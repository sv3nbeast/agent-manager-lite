package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	internallogging "github.com/router-for-me/CLIProxyAPI/v7/internal/logging"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

// Images is an independent provider API. Its bodies and events must not pass
// through the hosted Responses image tool or a conversation protocol adapter.
// Return false only for the existing OAuth image path, leaving its body intact.
func (s *relayServer) handleProviderGatewayImages(c *gin.Context, spec *apiKeySpec) bool {
	if spec == nil || (spec.ProviderGateway == nil && spec.ModelRouting == nil) || len(imageGenerationAccountIDsForSpec(spec)) > 0 {
		return false
	}
	input, err := readProviderImageInput(c.Request)
	if err != nil {
		writeAPIError(c, http.StatusBadRequest, err.Error(), "invalid_request")
		return true
	}
	route, upstreamModel, routeStatus := resolveModelRoutingRoute(spec, input.model)
	automatic := spec.ModelRouting != nil && spec.ModelRouting.Automatic
	if automatic && automaticNativeModel(spec, input.model) {
		return false
	}
	if s.policy != nil && s.policy.tracker != nil {
		defer s.policy.tracker.releaseImageJobs(internallogging.GetRequestID(c.Request.Context()))
	}
	if automatic && !automaticNativeModel(spec, input.model) {
		route, upstreamModel, err = s.selectAutomaticImageRoute(c, spec, input)
		if err != nil {
			writeProviderImageSelectionError(c, err, http.StatusNotFound, "no authorized provider image route is available", "model_route_not_available")
			return true
		}
		routeStatus = "matched"
	}
	gateway := spec.ProviderGateway
	switch routeStatus {
	case "native":
		return false
	case "none":
		if gateway == nil {
			return false
		}
		upstreamModel = s.providerGatewayImageModel(gateway, stripModelPrefix(input.model, spec))
	case "matched":
		if route != nil {
			gateway = route.ProviderGateway
		}
	default:
		writeAPIError(c, http.StatusNotFound, "image model route is not available for this API key", "model_route_not_available")
		return true
	}
	if gateway == nil || upstreamModel == "" || !providerImageModelAllowed(s.manifest, spec, input.model, upstreamModel) {
		writeAPIError(c, http.StatusNotFound, "image model is not available for this API key", "model_not_available")
		return true
	}
	if route != nil && !routedClientModelAllowed(s.manifest, spec, input.model) {
		writeAPIError(c, http.StatusNotFound, "image model is not available for this API key", "model_not_available")
		return true
	}
	if !automatic {
		if err := s.admitProviderImageAccount(c, spec, route, gateway, input.model, upstreamModel); err != nil {
			writeProviderImageSelectionError(c, err, http.StatusForbidden, "image provider account is not available for this request", "image_account_unavailable")
			return true
		}
	}
	body, err := input.withModel(upstreamModel)
	if err != nil {
		writeAPIError(c, http.StatusBadRequest, "invalid image request body", "invalid_request")
		return true
	}
	c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), requestModelContextKey, input.model))
	s.forwardProviderGatewayImage(c, gateway, input, body, upstreamModel)
	return true
}

// A native image request never falls back to the provider's default chat model.
// Only declared models, configured aliases and the existing image-tool alias
// are eligible. An unconstrained provider retains native model passthrough.
func (s *relayServer) providerGatewayImageModel(gateway *providerGatewaySpec, model string) string {
	if gateway == nil {
		return ""
	}
	model = strings.TrimSpace(model)
	if s.manifest != nil {
		if source := s.manifest.aliasToSource[strings.ToLower(model)]; source != "" {
			model = source
		}
	}
	if len(gateway.UpstreamModels) == 0 && strings.TrimSpace(gateway.UpstreamModel) == "" {
		return model
	}
	declared := func(candidate string) string {
		for _, allowed := range gateway.UpstreamModels {
			if strings.EqualFold(candidate, allowed) {
				return allowed
			}
		}
		if strings.EqualFold(candidate, strings.TrimSpace(gateway.UpstreamModel)) {
			return strings.TrimSpace(gateway.UpstreamModel)
		}
		return ""
	}
	if exact := declared(model); exact != "" {
		return exact
	}
	if strings.EqualFold(model, legacyImagesToolModel) || strings.EqualFold(model, defaultImagesToolModel) {
		return declared(configuredImagesToolModel(s.manifest))
	}
	return ""
}

func providerImageModelAllowed(m *manifest, spec *apiKeySpec, requested, upstream string) bool {
	requested = stripModelPrefix(requested, spec)
	if m != nil && (modelMatchesAnyRule(requested, m.ExcludedModels) || modelMatchesAnyRule(upstream, m.ExcludedModels)) {
		return false
	}
	if spec == nil {
		return false
	}
	if len(spec.AllowedModels) > 0 && !modelMatchesAnyRule(requested, spec.AllowedModels) && !modelMatchesAnyRule(upstream, spec.AllowedModels) {
		return false
	}
	return !modelMatchesAnyRule(requested, spec.ExcludedModels) && !modelMatchesAnyRule(upstream, spec.ExcludedModels)
}

type providerImageInput struct {
	body        []byte
	contentType string
	boundary    string
	model       string
	modelSet    bool
	stream      bool
	jsonFields  map[string]json.RawMessage
}

func readProviderImageInput(r *http.Request) (providerImageInput, error) {
	input := providerImageInput{contentType: r.Header.Get("Content-Type"), model: defaultImagesToolModel}
	mediaType := "application/json"
	var params map[string]string
	var err error
	if input.contentType != "" {
		mediaType, params, err = mime.ParseMediaType(input.contentType)
		if err != nil {
			return input, fmt.Errorf("invalid image request content type")
		}
	} else {
		input.contentType = mediaType
	}
	if mediaType != "application/json" && (mediaType != "multipart/form-data" || r.URL.Path != imagesEditsPath) {
		return input, fmt.Errorf("unsupported image request content type")
	}
	input.body, err = readAndRestoreBody(r)
	if err != nil {
		return input, fmt.Errorf("failed to read image request body")
	}
	if mediaType == "application/json" {
		if err := json.Unmarshal(input.body, &input.jsonFields); err != nil || input.jsonFields == nil {
			return input, fmt.Errorf("invalid image request JSON")
		}
		if value, ok := input.jsonFields["model"]; ok {
			input.modelSet = true
			if err := json.Unmarshal(value, &input.model); err != nil || strings.TrimSpace(input.model) == "" || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return input, fmt.Errorf("image model must be a nonempty string")
			}
		}
		if value, ok := input.jsonFields["stream"]; ok {
			if err := json.Unmarshal(value, &input.stream); err != nil {
				return input, fmt.Errorf("image stream must be a boolean")
			}
		}
	} else {
		input.boundary = params["boundary"]
		if input.boundary == "" {
			return input, fmt.Errorf("image multipart boundary is required")
		}
		reader := multipart.NewReader(bytes.NewReader(input.body), input.boundary)
		seen := make(map[string]bool)
		for {
			part, err := reader.NextRawPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return input, fmt.Errorf("invalid image multipart body")
			}
			name := part.FormName()
			if name != "model" && name != "stream" {
				if _, err := io.Copy(io.Discard, part); err != nil {
					return input, fmt.Errorf("invalid image multipart body")
				}
				continue
			}
			if seen[name] || part.FileName() != "" || part.Header.Get("Content-Transfer-Encoding") != "" {
				return input, fmt.Errorf("ambiguous image multipart %s field", name)
			}
			seen[name] = true
			value, err := io.ReadAll(io.LimitReader(part, 1025))
			if err != nil || len(value) > 1024 {
				return input, fmt.Errorf("invalid image multipart %s field", name)
			}
			switch name {
			case "model":
				input.modelSet = true
				input.model = strings.TrimSpace(string(value))
				if input.model == "" {
					return input, fmt.Errorf("image model must be a nonempty string")
				}
			case "stream":
				switch strings.TrimSpace(string(value)) {
				case "true":
					input.stream = true
				case "false", "":
				default:
					return input, fmt.Errorf("image stream must be a boolean")
				}
			}
		}
	}
	input.model = strings.TrimSpace(input.model)
	return input, nil
}

func (input providerImageInput) withModel(model string) ([]byte, error) {
	if input.boundary == "" {
		// RawMessage retains unknown provider options and exact numeric values.
		// Re-encoding also removes ambiguous duplicate top-level model keys.
		input.jsonFields["model"], _ = json.Marshal(model)
		return json.Marshal(input.jsonFields)
	}
	if model == input.model && input.modelSet {
		return input.body, nil
	}
	var output bytes.Buffer
	writer := multipart.NewWriter(&output)
	if err := writer.SetBoundary(input.boundary); err != nil {
		return nil, err
	}
	reader := multipart.NewReader(bytes.NewReader(input.body), input.boundary)
	for {
		part, err := reader.NextRawPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		next, err := writer.CreatePart(part.Header)
		if err != nil {
			return nil, err
		}
		if part.FormName() == "model" {
			_, err = io.WriteString(next, model)
		} else {
			_, err = io.Copy(next, part)
		}
		if err != nil {
			return nil, err
		}
	}
	if !input.modelSet {
		if err := writer.WriteField("model", model); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func (s *relayServer) forwardProviderGatewayImage(c *gin.Context, gateway *providerGatewaySpec, input providerImageInput, body []byte, model string) {
	upstreamURL, err := providerGatewayURL(gateway.BaseURL, c.Request.URL.Path)
	if err != nil {
		writeAPIError(c, http.StatusBadGateway, "provider image endpoint is invalid", "bad_gateway")
		return
	}
	parsed, err := url.Parse(upstreamURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		writeAPIError(c, http.StatusBadGateway, "provider image endpoint is invalid", "bad_gateway")
		return
	}
	req, err := http.NewRequestWithContext(relayContext(c), http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		writeAPIError(c, http.StatusBadGateway, "failed to create provider image request", "bad_gateway")
		return
	}
	req.Header.Set("Authorization", "Bearer "+gateway.APIKey)
	req.Header.Set("Content-Type", input.contentType)
	req.Header.Set("Accept", "application/json")
	if input.stream {
		req.Header.Set("Accept", "text/event-stream")
	}
	copyProviderGatewayDiagnosticHeaders(req.Header, c.Request.Header)
	client := *http.DefaultClient
	if gateway.ProxyURL != "" {
		transport, mode, proxyErr := proxyutil.BuildHTTPTransport(gateway.ProxyURL)
		if proxyErr != nil || transport == nil || (mode != proxyutil.ModeProxy && mode != proxyutil.ModeDirect) {
			writeAPIError(c, http.StatusBadGateway, "upstream proxy configuration is invalid", "upstream_proxy_error")
			return
		}
		client.Transport = transport
		defer transport.CloseIdleConnections()
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	observer := &providerUsageObserver{wireAPI: "images"}
	startedAt := time.Now()
	defer func() { s.recordProviderUsage(c, model, nil, nil, startedAt, observer, input.stream) }()
	var resp *http.Response
	if input.stream {
		resp, err = doProviderStream(&client, req, s.streamTimeoutsForRequest(c.Request, nil, model))
	} else {
		// Native nonstream Images sends its headers after generation finishes;
		// the OAuth Responses first-event budget is not a generation deadline.
		resp, err = client.Do(req)
	}
	if err != nil {
		observer.readErr = err
		if c.Request.Context().Err() == nil {
			writeAPIError(c, statusCodeFromError(err), "provider image request failed", "upstream_error")
		}
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		writeAPIError(c, http.StatusBadGateway, "upstream redirected; configure the final provider endpoint", "upstream_redirect")
		return
	}
	// Never expose reflected credentials or provider cookies to a local client.
	resp.Header.Del("Authorization")
	resp.Header.Del("X-Api-Key")
	resp.Header.Del("X-Goog-Api-Key")
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}
	mediaType, _, _ := mime.ParseMediaType(contentType)
	if mediaType == "text/event-stream" && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		writeUpstreamHeaders(c.Writer.Header(), resp.Header)
		c.Header("Content-Type", contentType)
		c.Status(resp.StatusCode)
		c.Writer.Flush()
		metadata := &providerImageMetadataReader{body: resp.Body, observer: observer}
		_, copyErr := io.Copy(providerFlushWriter{writer: c.Writer, flush: c.Writer.Flush}, metadata)
		// An earlier image's completion cannot close a later unfinished data
		// frame. Comments and keepalive fields alone do not leave pending data.
		if copyErr == nil && (metadata.pendingData || (!observer.doneSeen && !observer.failed)) {
			copyErr = errors.New("provider image stream ended before completion")
		}
		observer.readErr = copyErr
		if copyErr != nil {
			observer.failed = true
		}
		// Native image events have their own completion types. Preserve them
		// verbatim rather than requiring a Responses terminal event or [DONE].
		if copyErr != nil && c.Request.Context().Err() == nil {
			if metadata.finishInterruptedEvent(c.Writer) == nil {
				writeImagesStreamError(c, c.Writer, relayStatusError{status: http.StatusBadGateway, message: "provider image stream disconnected"})
			}
		}
		return
	}
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		observer.readErr = err
		if c.Request.Context().Err() == nil {
			writeAPIError(c, http.StatusBadGateway, "provider image response was interrupted", "upstream_error")
		}
		return
	}
	trimmed := bytes.TrimSpace(payload)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && (!json.Valid(trimmed) || trimmed[0] != '{') {
		observer.failed = true
		observer.readErr = errors.New("provider image response is not a valid JSON object")
		writeAPIError(c, http.StatusBadGateway, "provider image response is not valid JSON", "upstream_error")
		return
	}
	observer.observeJSON(payload)
	observer.doneSeen = true
	writeUpstreamHeaders(c.Writer.Header(), resp.Header)
	c.Data(resp.StatusCode, contentType, payload)
}
