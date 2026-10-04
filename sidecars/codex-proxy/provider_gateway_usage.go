package main

import (
	"bytes"
	"io"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	internallogging "github.com/router-for-me/CLIProxyAPI/v7/internal/logging"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	coreusage "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/usage"
	"github.com/tidwall/gjson"
)

// Observes upstream bytes before response translation without buffering the
// response or changing chunk boundaries. Only bounded event metadata survives.
type providerUsageObserver struct {
	body                       io.ReadCloser
	line, event                []byte
	skipLine, skipEvent        bool
	detail                     coreusage.Detail
	responseTier               string
	terminal, failed           bool
	responseTerminal, doneSeen bool
	wireAPI                    string
	readErr                    error
}

func (o *providerUsageObserver) observeJSON(payload []byte) {
	if !gjson.ValidBytes(payload) {
		return
	}
	var detail coreusage.Detail
	if gjson.GetBytes(payload, "response").Exists() {
		detail, _ = helps.ParseCodexUsage(payload)
	} else {
		detail = helps.ParseOpenAIUsage(payload)
	}
	if detail.ResponseServiceTier != "" {
		o.responseTier = detail.ResponseServiceTier
	}
	if gjson.GetBytes(payload, "usage").Exists() || gjson.GetBytes(payload, "response.usage").Exists() {
		o.detail = detail
	}
	kind := gjson.GetBytes(payload, "type").String()
	if kind == "response.completed" || kind == "response.done" {
		o.terminal = true
		o.responseTerminal = true
	}
	if kind == "error" || kind == "response.failed" || kind == "response.incomplete" || gjson.GetBytes(payload, "error").Exists() {
		o.failed = true
		o.responseTerminal = true
	}
	if reason := gjson.GetBytes(payload, "choices.0.finish_reason"); reason.Exists() && reason.Type == gjson.String {
		o.terminal = true
	}
}

func (o *providerUsageObserver) consumeLine() {
	line := bytes.TrimSuffix(o.line, []byte("\r"))
	if len(line) == 0 {
		if !o.skipEvent && len(o.event) > 0 {
			payload := bytes.TrimSpace(o.event)
			if bytes.Equal(payload, []byte("[DONE]")) {
				o.terminal = true
				o.doneSeen = true
			} else {
				o.observeJSON(payload)
			}
		}
		o.event = o.event[:0]
		o.skipEvent = false
	} else if bytes.HasPrefix(line, []byte("data:")) && !o.skipEvent {
		value := bytes.TrimPrefix(line[5:], []byte(" "))
		if len(o.event)+len(value) > 4<<20 {
			o.skipEvent = true
			o.event = nil
		} else {
			o.event = append(o.event, value...)
			o.event = append(o.event, '\n')
		}
	}
	o.line = o.line[:0]
}

func (o *providerUsageObserver) Read(p []byte) (int, error) {
	n, err := o.body.Read(p)
	o.observeSSE(p[:n])
	if err != nil && err != io.EOF {
		o.readErr = err
	}
	return n, err
}

func (o *providerUsageObserver) observeSSE(data []byte) {
	for _, b := range data {
		if b == '\n' {
			if o.skipLine {
				o.skipEvent = true
				o.skipLine = false
				o.line = nil
			} else {
				o.consumeLine()
			}
		} else if !o.skipLine {
			if len(o.line) >= 4<<20 {
				o.skipLine = true
				o.line = nil
			} else {
				o.line = append(o.line, b)
			}
		}
	}
}
func (o *providerUsageObserver) Close() error { return o.body.Close() }

func (s *relayServer) recordProviderUsage(c *gin.Context, model string, inbound, outbound []byte, start time.Time, observer *providerUsageObserver, stream bool) {
	if s.policy == nil || s.policy.tracker == nil {
		return
	}
	in := strings.TrimSpace(gjson.GetBytes(inbound, "service_tier").String())
	out := strings.TrimSpace(gjson.GetBytes(outbound, "service_tier").String())
	status := c.Writer.Status()
	streamComplete := observer.doneSeen
	if observer.wireAPI == "responses" {
		streamComplete = observer.responseTerminal
	}
	success := status < 400 && c.Request.Context().Err() == nil && !observer.failed && ((!stream && observer.readErr == nil) || (stream && streamComplete))
	spec, _ := c.Request.Context().Value(clientAPIKeyContextKey).(*apiKeySpec)
	requested, _ := c.Request.Context().Value(requestModelContextKey).(string)
	payload := usagePayload{Type: "usage", RequestID: internallogging.GetRequestID(c.Request.Context()), Provider: "provider_gateway", Model: model, UpstreamModel: model, RequestedModel: requested,
		APIKeyID: stringFromAPIKey(spec, "id"), APIKeyLabel: stringFromAPIKey(spec, "label"), Status: status, Success: success, RequestedAtMS: start.UnixMilli(), LatencyMS: time.Since(start).Milliseconds(),
		InboundServiceTier: &in, OutboundServiceTier: &out, ResponseServiceTier: observer.responseTier, ServiceTier: normalizedUsageServiceTier(observer.responseTier),
		Usage: usageDetails{InputTokens: observer.detail.InputTokens, OutputTokens: observer.detail.OutputTokens, CachedTokens: observer.detail.CachedTokens, ReasoningTokens: observer.detail.ReasoningTokens, TotalTokens: observer.detail.TotalTokens, TokenBreakdown: observer.detail.TokenBreakdown}}
	if !success {
		payload.ErrorCategory = "upstream_error"
		if observer.readErr != nil {
			payload.ErrorCategory = errorCategory(status, observer.readErr.Error(), false)
		}
	}
	s.policy.tracker.mu.Lock()
	selected, ok := s.policy.tracker.selectedAccounts[payload.RequestID]
	s.policy.tracker.mu.Unlock()
	if ok {
		payload.AccountID, payload.AccountEmail, payload.AuthID = selected.AccountID, selected.AccountEmail, selected.AuthID
	}
	s.policy.tracker.record(payload)
}
