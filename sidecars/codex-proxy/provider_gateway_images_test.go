package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

const imageFixtureModel = "fixture-image-model"

func imageGatewayFixture(base string) *providerGatewaySpec {
	return &providerGatewaySpec{BaseURL: base, APIKey: "fixture-image-upstream-secret", UpstreamModel: "fixture-chat-model", UpstreamModels: []string{"fixture-chat-model", imageFixtureModel}, WireAPI: "chat_completions"}
}

func imageGatewayRouter(t *testing.T, spec apiKeySpec, configure func(*manifest, *config.Config, *fakeRuntime)) (*gin.Engine, *fakeRuntime) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	spec.ID, spec.Key, spec.Enabled = "image-fixture", "fixture-image-client", true
	account := &accountSpec{ID: "image-account", AuthKind: "api_key", UpstreamAPIKey: "fixture-image-upstream-secret"}
	m := &manifest{APIKeys: []apiKeySpec{spec}, ModelIDs: []string{imageFixtureModel}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: &spec}, accountByID: map[string]*accountSpec{account.ID: account}, accountByAPIKey: map[string]*accountSpec{account.UpstreamAPIKey: account}}
	cfg, runtime := &config.Config{}, &fakeRuntime{}
	if configure != nil {
		configure(m, cfg, runtime)
	}
	return (&relayServer{runtime: runtime, cfg: cfg, manifest: m, policy: &requestPolicy{manifest: m}}).router(), runtime
}

func imageFixtureRequest(ctx context.Context, endpoint, contentType string, body io.Reader) *http.Request {
	r, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, body)
	r.Header.Set("Authorization", "Bearer fixture-image-client")
	r.Header.Set("Content-Type", contentType)
	return r
}

func TestProviderGatewayImagesPreserveNativeJSONAndEndpoint(t *testing.T) {
	for _, tc := range []struct {
		path, baseSuffix, wantPath string
	}{
		{imagesGenerationsPath, "", imagesGenerationsPath},
		{imagesGenerationsPath, "/v1/", imagesGenerationsPath},
		{imagesGenerationsPath, "/proxy/v1", "/proxy/v1/images/generations"},
		{imagesGenerationsPath, imagesGenerationsPath, imagesGenerationsPath},
		{imagesEditsPath, "/v1", imagesEditsPath},
	} {
		t.Run(tc.path+tc.baseSuffix, func(t *testing.T) {
			var hits atomic.Int32
			responseBody := `{"created":1790000000,"data":[{"b64_json":"cG5n","provider_detail":{"ok":true}}],"usage":{"input_tokens":5,"output_tokens":8,"total_tokens":13}}`
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				if r.URL.Path != tc.wantPath || r.URL.RawQuery != "" || r.Method != http.MethodPost {
					t.Errorf("wrong target: %s %s", r.Method, r.URL)
				}
				if r.Header.Get("Authorization") != "Bearer fixture-image-upstream-secret" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Api-Key") != "" || r.Header.Get("Proxy-Authorization") != "" {
					t.Error("client credentials escaped or provider authorization changed")
				}
				if r.Header.Get("X-Client-Request-Id") != "fixture-request-id" {
					t.Error("missing diagnostic request id")
				}
				var body map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Errorf("invalid JSON: %v", err)
				}
				for key, value := range map[string]string{"model": `"fixture-image-model"`, "prompt": `"draw a test"`, "n": `2`, "provider_option": `9007199254740993`, "quality": `"low"`, "size": `"1024x1024"`, "images": `[{"image_url":"data:image/png;base64,cG5n"}]`} {
					if string(body[key]) != value {
						t.Errorf("native field %s changed: %s", key, body[key])
					}
				}
				if _, exists := body["tools"]; exists {
					t.Error("image request was converted to hosted Responses")
				}
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.Header().Set("X-Request-Id", "fixture-upstream-id")
				w.Header().Set("Authorization", "Bearer fixture-image-upstream-secret")
				w.Header().Set("Set-Cookie", "session=fixture-cookie")
				w.WriteHeader(http.StatusCreated)
				fmt.Fprint(w, responseBody)
			}))
			defer upstream.Close()
			gateway := imageGatewayFixture(upstream.URL + tc.baseSuffix + "?credential=fixture-query-secret")
			router, runtime := imageGatewayRouter(t, apiKeySpec{ProviderGateway: gateway, ModelPrefix: "local"}, func(m *manifest, _ *config.Config, _ *fakeRuntime) {
				m.aliasToSource = map[string]string{"image-alias": imageFixtureModel}
			})
			body := `{"model":"local/image-alias","prompt":"draw a test","n":2,"provider_option":9007199254740993,"quality":"low","size":"1024x1024","images":[{"image_url":"data:image/png;base64,cG5n"}]}`
			request := imageFixtureRequest(context.Background(), tc.path+"?auth_token=fixture-client-query", "application/json", strings.NewReader(body))
			request.Header.Set("Cookie", "fixture-client-cookie")
			request.Header.Set("Proxy-Authorization", "fixture-client-proxy-secret")
			request.Header.Set("X-Api-Key", "fixture-other-client-secret")
			request.Header.Set("X-Client-Request-Id", "fixture-request-id")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusCreated || response.Body.String() != responseBody || hits.Load() != 1 {
				t.Fatalf("native response changed: %d %s hits=%d", response.Code, response.Body.String(), hits.Load())
			}
			if response.Header().Get("X-Request-Id") != "fixture-upstream-id" || response.Header().Get("Authorization") != "" || response.Header().Get("Set-Cookie") != "" {
				t.Fatalf("response headers unsafe or lost: %#v", response.Header())
			}
			if runtime.streamCalls != 0 || runtime.executeCalls != 0 {
				t.Fatal("native images entered OAuth executor")
			}
		})
	}
}

func imageMultipartFixture(t *testing.T, model string) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	if model != "" {
		if err := w.WriteField("model", model); err != nil {
			t.Fatal(err)
		}
	}
	for _, field := range [][2]string{{"prompt", "edit test"}, {"style[]", "first"}, {"style[]", "second"}, {"quality", "low"}, {"stream", "false"}} {
		if err := w.WriteField(field[0], field[1]); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"image[]", "image[]", "mask"} {
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="fixture.png"`, name))
		h.Set("Content-Type", "image/png")
		h.Set("X-Image-Option", "preserve")
		part, err := w.CreatePart(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte{137, 'P', 'N', 'G', 0, 255, '\r', '\n', 1}); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return body.Bytes(), w.FormDataContentType()
}

func TestProviderGatewayImagesPreserveMultipartEdits(t *testing.T) {
	for _, model := range []string{imageFixtureModel, "image-alias", ""} {
		t.Run(model, func(t *testing.T) {
			original, contentType := imageMultipartFixture(t, model)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
				}
				if model == imageFixtureModel && !bytes.Equal(body, original) {
					t.Error("unmapped multipart bytes changed")
				}
				if r.Header.Get("Content-Type") != contentType || r.URL.Path != imagesEditsPath {
					t.Error("multipart content type or endpoint changed")
				}
				r.Body = io.NopCloser(bytes.NewReader(body))
				if err := r.ParseMultipartForm(1 << 20); err != nil {
					t.Error(err)
					return
				}
				defer r.MultipartForm.RemoveAll()
				form := r.MultipartForm
				if fmt.Sprint(form.Value["model"]) != "["+imageFixtureModel+"]" || fmt.Sprint(form.Value["style[]"]) != "[first second]" || r.FormValue("prompt") != "edit test" {
					t.Errorf("multipart fields changed: %v", form.Value)
				}
				if len(form.File["image[]"]) != 2 || len(form.File["mask"]) != 1 {
					t.Errorf("image files missing: %v", form.File)
				}
				for _, files := range form.File {
					for _, file := range files {
						f, err := file.Open()
						if err != nil {
							t.Error(err)
							continue
						}
						data, _ := io.ReadAll(f)
						f.Close()
						if !bytes.Equal(data, []byte{137, 'P', 'N', 'G', 0, 255, '\r', '\n', 1}) || file.Filename != "fixture.png" || file.Header.Get("X-Image-Option") != "preserve" || file.Header.Get("Content-Type") != "image/png" {
							t.Error("multipart file bytes or headers changed")
						}
					}
				}
				fmt.Fprint(w, `{"data":[{"b64_json":"cG5n"}]}`)
			}))
			defer upstream.Close()
			router, _ := imageGatewayRouter(t, apiKeySpec{ProviderGateway: imageGatewayFixture(upstream.URL)}, func(m *manifest, _ *config.Config, _ *fakeRuntime) {
				m.aliasToSource = map[string]string{"image-alias": imageFixtureModel}
				m.ImageGenerationModel = imageFixtureModel
			})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesEditsPath, contentType, bytes.NewReader(original)))
			if response.Code != http.StatusOK {
				t.Fatalf("multipart rejected: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestProviderGatewayImagesEnforceKeyModelsAndRoutes(t *testing.T) {
	for _, tc := range []struct {
		name, model string
		status      int
		configure   func(*apiKeySpec, *manifest)
		noKey       bool
	}{
		{name: "direct", model: imageFixtureModel, status: 200},
		{name: "unknown does not use chat default", model: "unknown-image", status: 404},
		{name: "missing key", model: imageFixtureModel, status: 401, noKey: true},
		{name: "allowed models", model: imageFixtureModel, status: 404, configure: func(spec *apiKeySpec, _ *manifest) { spec.AllowedModels = []string{"fixture-chat-model"} }},
		{name: "key exclusions", model: imageFixtureModel, status: 404, configure: func(spec *apiKeySpec, _ *manifest) { spec.ExcludedModels = []string{imageFixtureModel} }},
		{name: "global exclusions", model: imageFixtureModel, status: 404, configure: func(_ *apiKeySpec, m *manifest) { m.ExcludedModels = []string{imageFixtureModel} }},
		{name: "namespaced", model: "provider/" + imageFixtureModel, status: 200, configure: func(spec *apiKeySpec, _ *manifest) {
			spec.ModelRouting = &modelRoutingSpec{Routes: []modelRouteSpec{{Namespace: "provider", ProviderGateway: spec.ProviderGateway}}}
			spec.ProviderGateway = nil
		}},
		{name: "unknown namespace", model: "other/" + imageFixtureModel, status: 404, configure: func(spec *apiKeySpec, _ *manifest) {
			spec.ModelRouting = &modelRoutingSpec{Routes: []modelRouteSpec{{Namespace: "provider", ProviderGateway: spec.ProviderGateway}}}
		}},
		{name: "mapped route", model: "image-route", status: 200, configure: func(spec *apiKeySpec, _ *manifest) {
			spec.ModelRouting = &modelRoutingSpec{Routes: []modelRouteSpec{{ProviderGateway: spec.ProviderGateway, Models: []modelRouteModelSpec{{ClientModel: "image-route", UpstreamModel: imageFixtureModel}}}}}
			spec.ProviderGateway = nil
		}},
		{name: "automatic route", model: "image-route", status: 200, configure: func(spec *apiKeySpec, _ *manifest) {
			spec.ModelRouting = &modelRoutingSpec{Automatic: true, Routes: []modelRouteSpec{{ProviderAccountID: "image-account", ProviderGateway: spec.ProviderGateway, Models: []modelRouteModelSpec{{ClientModel: "image-route", UpstreamModel: imageFixtureModel}}}}}
			spec.ProviderGateway = nil
		}},
		{name: "automatic route excluded", model: "image-route", status: 404, configure: func(spec *apiKeySpec, _ *manifest) {
			spec.ModelRouting = &modelRoutingSpec{Automatic: true, Routes: []modelRouteSpec{{ProviderAccountID: "image-account", ProviderGateway: spec.ProviderGateway, Models: []modelRouteModelSpec{{ClientModel: "image-route", UpstreamModel: imageFixtureModel}}}}}
			spec.ProviderGateway = nil
			spec.ExcludedModels = []string{"image-route"}
		}},
		{name: "upstream alias exclusion", model: "image-alias", status: 404, configure: func(spec *apiKeySpec, m *manifest) {
			m.aliasToSource = map[string]string{"image-alias": imageFixtureModel}
			spec.ExcludedModels = []string{imageFixtureModel}
		}},
		{name: "configured legacy image alias", model: legacyImagesToolModel, status: 200, configure: func(_ *apiKeySpec, m *manifest) { m.ImageGenerationModel = imageFixtureModel }},
		{name: "undeclared legacy image", model: legacyImagesToolModel, status: 404},
		{name: "account image policy disabled", model: imageFixtureModel, status: 403, configure: func(_ *apiKeySpec, m *manifest) {
			m.accountByID["image-account"].ImageGenerationPolicy = "disabled"
		}},
		{name: "account model excluded", model: imageFixtureModel, status: 403, configure: func(_ *apiKeySpec, m *manifest) {
			m.AccountModelRules = []accountModelRule{{AccountID: "image-account", ExcludedModels: []string{imageFixtureModel}}}
		}},
		{name: "account outside key scope", model: imageFixtureModel, status: 403, configure: func(spec *apiKeySpec, _ *manifest) {
			spec.AccountIDs = []string{"other-account"}
		}},
		{name: "API key keeps existing quota rules", model: imageFixtureModel, status: 200, configure: func(_ *apiKeySpec, m *manifest) {
			zero := 0
			m.accountByID["image-account"].RemainingQuota = &zero
		}},
		{name: "account quota reserve unknown", model: imageFixtureModel, status: 403, configure: func(_ *apiKeySpec, m *manifest) {
			m.accountByID["image-account"].QuotaReserve = &quotaReserveSpec{}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var hits atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				var body struct{ Model string }
				if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
					if err := r.ParseMultipartForm(1 << 20); err != nil {
						t.Error(err)
						return
					}
					defer r.MultipartForm.RemoveAll()
					body.Model = r.FormValue("model")
				} else {
					json.NewDecoder(r.Body).Decode(&body)
				}
				if body.Model != imageFixtureModel {
					t.Errorf("wrong routed model: %q", body.Model)
				}
				fmt.Fprint(w, `{"data":[{"b64_json":"cG5n"}]}`)
			}))
			defer upstream.Close()
			router, runtime := imageGatewayRouter(t, apiKeySpec{ProviderGateway: imageGatewayFixture(upstream.URL)}, func(m *manifest, _ *config.Config, _ *fakeRuntime) {
				if tc.configure != nil {
					tc.configure(m.apiKeyByValue["fixture-image-client"], m)
				}
			})
			for _, multipartInput := range []bool{false, true} {
				var request *http.Request
				if multipartInput {
					body, contentType := imageMultipartFixture(t, tc.model)
					request = imageFixtureRequest(context.Background(), imagesEditsPath, contentType, bytes.NewReader(body))
				} else {
					request = imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(fmt.Sprintf(`{"model":%q,"prompt":"draw"}`, tc.model)))
				}
				if tc.noKey {
					request.Header.Del("Authorization")
				}
				response := httptest.NewRecorder()
				// This assertion covers both JSON policy inspection and multipart's
				// handler-side authorization, which must enforce identical rules.
				router.ServeHTTP(response, request)
				if response.Code != tc.status {
					t.Errorf("multipart=%v status=%d expected=%d body=%s", multipartInput, response.Code, tc.status, response.Body.String())
				}
			}
			if tc.status != 200 && hits.Load() != 0 {
				t.Fatalf("blocked model reached provider %d time(s)", hits.Load())
			}
			if runtime.streamCalls != 0 || runtime.executeCalls != 0 {
				t.Fatal("provider model unexpectedly fell back to OAuth")
			}
		})
	}
}

func TestProviderGatewayImagesPreserveOAuthImagePool(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer upstream.Close()
	router, runtime := imageGatewayRouter(t, apiKeySpec{ProviderGateway: imageGatewayFixture(upstream.URL), ImageGenerationAccountIDs: []string{"fixture-oauth-image"}}, func(_ *manifest, _ *config.Config, runtime *fakeRuntime) {
		stream := make(chan cliproxyexecutor.StreamChunk, 1)
		stream <- cliproxyexecutor.StreamChunk{Payload: []byte("event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"created_at\":1790000000,\"output\":[{\"type\":\"image_generation_call\",\"result\":\"cG5n\",\"output_format\":\"png\"}]}}\n\n")}
		close(stream)
		runtime.streamResult = &cliproxyexecutor.StreamResult{Chunks: stream}
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"gpt-image-2","prompt":"draw"}`)))
	if response.Code != 200 || runtime.streamCalls != 1 || hits.Load() != 0 || !strings.Contains(response.Body.String(), `"b64_json":"cG5n"`) {
		t.Fatalf("explicit OAuth image pool changed: status=%d calls=%d hits=%d body=%s", response.Code, runtime.streamCalls, hits.Load(), response.Body.String())
	}
}

func TestProviderGatewayImagesPreserveSSEAndCancel(t *testing.T) {
	for _, cancelEarly := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelEarly), func(t *testing.T) {
			first := ": native-image-event\n\nevent: image_generation.partial_image\ndata: {\"type\":\"image_generation.partial_image\",\"b64_json\":\"cG5n\"}\n\n"
			// Image events can exceed both Scanner's default limit and the usage
			// observer's metadata budget. Neither may truncate the native bytes.
			last := "event: image_generation.completed\ndata: {\"type\":\"image_generation.completed\",\"b64_json\":\"" + strings.Repeat("A", (4<<20)+7) + "\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}\n\n"
			cancelled := make(chan struct{})
			release := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
				fmt.Fprint(w, first)
				w.(http.Flusher).Flush()
				select {
				case <-r.Context().Done():
					close(cancelled)
					return
				case <-release:
					fmt.Fprint(w, last)
				}
			}))
			defer upstream.Close()
			router, _ := imageGatewayRouter(t, apiKeySpec{ProviderGateway: imageGatewayFixture(upstream.URL)}, nil)
			relay := httptest.NewServer(router)
			defer relay.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			response, err := http.DefaultClient.Do(imageFixtureRequest(ctx, relay.URL+imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw","stream":true}`)))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			reader := bufio.NewReader(response.Body)
			prefix := make([]byte, len(first))
			if _, err := io.ReadFull(reader, prefix); err != nil || string(prefix) != first {
				t.Fatalf("first image event was not flushed intact: %v", err)
			}
			if cancelEarly {
				cancel()
				select {
				case <-cancelled:
				case <-time.After(time.Second):
					t.Fatal("client cancellation did not close upstream image request")
				}
				return
			}
			close(release)
			rest, err := io.ReadAll(reader)
			if err != nil || string(rest) != last {
				t.Fatalf("complete native SSE changed: bytes=%d want=%d error=%v", len(rest), len(last), err)
			}
		})
	}
}

func TestProviderGatewayImagesRejectRedirectsAndUnsafeEndpoints(t *testing.T) {
	var redirected atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected.Add(1) }))
	defer destination.Close()
	for _, redirectStatus := range []int{301, 307} {
		t.Run(fmt.Sprint(redirectStatus), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, destination.URL+"?secret=fixture-location-secret", redirectStatus)
			}))
			defer upstream.Close()
			router, _ := imageGatewayRouter(t, apiKeySpec{ProviderGateway: imageGatewayFixture(upstream.URL)}, nil)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"private"}`)))
			if response.Code != 502 || redirected.Load() != 0 || response.Header().Get("Location") != "" || strings.Contains(response.Body.String(), "fixture-location-secret") || !strings.Contains(response.Body.String(), "upstream_redirect") {
				t.Fatalf("unsafe image redirect: %d %s hits=%d", response.Code, response.Body.String(), redirected.Load())
			}
		})
	}
	for _, endpoint := range []string{"file:///tmp/fixture", "http://user:fixture-password@provider.invalid", "http://[malformed"} {
		router, _ := imageGatewayRouter(t, apiKeySpec{ProviderGateway: imageGatewayFixture(endpoint)}, nil)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw"}`)))
		if response.Code != 502 || strings.Contains(response.Body.String(), "fixture-password") || strings.Contains(response.Body.String(), endpoint) {
			t.Fatalf("unsafe endpoint leaked: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestProviderGatewayImagesHonorProxyAndDoNotLeakProxyCredentials(t *testing.T) {
	var hits atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Host != "provider.invalid" || r.URL.Path != imagesGenerationsPath || r.Header.Get("Authorization") != "Bearer fixture-image-upstream-secret" {
			t.Errorf("wrong native image proxy request: %s", r.URL)
		}
		if r.Header.Get("Proxy-Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("fixture-proxy:fixture-password")) {
			t.Error("proxy credentials missing")
		}
		fmt.Fprint(w, `{"data":[{"b64_json":"cG5n"}]}`)
	}))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	proxyURL.User = url.UserPassword("fixture-proxy", "fixture-password")
	gateway := imageGatewayFixture("http://provider.invalid/v1")
	gateway.ProxyURL = proxyURL.String()
	router, _ := imageGatewayRouter(t, apiKeySpec{ProviderGateway: gateway}, nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw"}`)))
	if response.Code != 200 || hits.Load() != 1 {
		t.Fatalf("proxy not used: %d hits=%d", response.Code, hits.Load())
	}
	for _, proxyURL := range []string{"invalid://fixture-proxy:fixture-password@127.0.0.1", "http://fixture-proxy:fixture-password@127.0.0.1:1"} {
		gateway := imageGatewayFixture(proxy.URL)
		gateway.ProxyURL = proxyURL
		router, _ := imageGatewayRouter(t, apiKeySpec{ProviderGateway: gateway}, nil)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw"}`)))
		if response.Code < 400 || hits.Load() != 1 || strings.Contains(response.Body.String(), "fixture-password") || strings.Contains(response.Body.String(), "fixture-image-upstream-secret") {
			t.Fatalf("proxy failure escaped or leaked: %d %s hits=%d", response.Code, response.Body.String(), hits.Load())
		}
	}
}

func TestProviderGatewayImagesPreserveErrorsAndRejectTruncation(t *testing.T) {
	for _, truncated := range []bool{false, true} {
		t.Run(fmt.Sprint(truncated), func(t *testing.T) {
			payload := `{"error":{"message":"image model capacity exhausted","type":"rate_limit_error","code":"capacity"}}`
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if truncated {
					w.Header().Set("Content-Length", "1000")
					fmt.Fprint(w, `{"data":[`)
					return
				}
				w.Header().Set("Retry-After", "7")
				w.WriteHeader(429)
				fmt.Fprint(w, payload)
			}))
			defer upstream.Close()
			router, _ := imageGatewayRouter(t, apiKeySpec{ProviderGateway: imageGatewayFixture(upstream.URL)}, nil)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw"}`)))
			if truncated {
				if response.Code != 502 || !strings.Contains(response.Body.String(), "interrupted") {
					t.Fatalf("truncated image response reported success: %d %s", response.Code, response.Body.String())
				}
			} else if response.Code != 429 || response.Body.String() != payload || response.Header().Get("Retry-After") != "7" {
				t.Fatalf("native upstream error changed: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestProviderGatewayImagesNonstreamWaitsForGenerationAndCancels(t *testing.T) {
	for _, cancelEarly := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelEarly), func(t *testing.T) {
			started, cancelled := make(chan struct{}), make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				close(started)
				if cancelEarly {
					<-r.Context().Done()
					close(cancelled)
					return
				}
				select {
				case <-r.Context().Done():
					return
				case <-time.After(30 * time.Millisecond):
					fmt.Fprint(w, `{"data":[{"b64_json":"cG5n"}]}`)
				}
			}))
			defer upstream.Close()
			router, _ := imageGatewayRouter(t, apiKeySpec{ProviderGateway: imageGatewayFixture(upstream.URL)}, func(_ *manifest, cfg *config.Config, _ *fakeRuntime) { cfg.Streaming.ImageStreamOpenTimeoutMS = 5 })
			relay := httptest.NewServer(router)
			defer relay.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				response, err := http.DefaultClient.Do(imageFixtureRequest(ctx, relay.URL+imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw"}`)))
				if err == nil {
					body, readErr := io.ReadAll(response.Body)
					response.Body.Close()
					if response.StatusCode != 200 || readErr != nil || !strings.Contains(string(body), "b64_json") {
						err = fmt.Errorf("nonstream generation failed: %d %s %v", response.StatusCode, body, readErr)
					}
				}
				done <- err
			}()
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("image generation did not start")
			}
			if cancelEarly {
				cancel()
				select {
				case <-cancelled:
				case <-time.After(time.Second):
					t.Fatal("nonstream cancellation did not reach upstream")
				}
			}
			err := <-done
			if !cancelEarly && err != nil {
				t.Fatal(err)
			}
		})
	}
}
