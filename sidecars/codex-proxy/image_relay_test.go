package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestConfiguredImageToolModelAndHistoricalAliases(t *testing.T) {
	configured := "fixture-future-image"
	for _, requested := range []string{"", legacyImagesToolModel, previousImagesToolModel, defaultImagesToolModel, configured} {
		payload := map[string]any{"prompt": "synthetic fixture"}
		if requested != "" {
			payload["model"] = requested
		}
		raw, _ := json.Marshal(payload)
		relay, err := buildImageGenerationRelayRequestWithModel(raw, configured, false)
		if err != nil {
			t.Fatalf("requested %q: %v", requested, err)
		}
		var body map[string]any
		if err := json.Unmarshal(relay.body, &body); err != nil {
			t.Fatal(err)
		}
		tool := body["tools"].([]any)[0].(map[string]any)
		if tool["model"] != configured || body["model"] != defaultImagesMainModel {
			t.Fatalf("requested %q: image/tool model projection changed: %#v", requested, body)
		}
		wantRequested := requested
		if wantRequested == "" {
			wantRequested = configured
		}
		if relay.requestedModel != wantRequested {
			t.Fatalf("requested model = %q, want %q", relay.requestedModel, wantRequested)
		}
	}
	if !isConfiguredImagesToolModel(&manifest{ImageGenerationModel: configured}, previousImagesToolModel) || !isHiddenCodexClientModel(previousImagesToolModel) {
		t.Fatal("previous image alias lost compatibility")
	}
	if !isImageGenerationRequest(nil, nil, previousImagesToolModel) {
		t.Fatal("previous image alias must retain image timeout policy")
	}
}

func TestProviderImageDefaultAliasesDoNotAcceptUnregisteredNamespaces(t *testing.T) {
	configured := "fixture-future-image"
	s := &relayServer{manifest: &manifest{ImageGenerationModel: configured}}
	gateway := &providerGatewaySpec{UpstreamModels: []string{configured}}
	for _, alias := range []string{legacyImagesToolModel, previousImagesToolModel, defaultImagesToolModel} {
		if got := s.providerGatewayImageModel(gateway, alias); got != configured {
			t.Fatalf("alias %q resolved to %q", alias, got)
		}
		if got := s.providerGatewayImageModel(gateway, "unregistered/"+alias); got != "" {
			t.Fatalf("unregistered namespace resolved to %q", got)
		}
	}
	gateway.UpstreamModels = append(gateway.UpstreamModels, previousImagesToolModel)
	if got := s.providerGatewayImageModel(gateway, previousImagesToolModel); got != previousImagesToolModel {
		t.Fatalf("explicit supported model must be retained, got %q", got)
	}
}

func TestProcessImageResponseFramePreservesStructuredFailure(t *testing.T) {
	frame := []byte("event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"type\":\"insufficient_balance\",\"message\":\"no credits\",\"status_code\":402}}}\n\n")
	_, done, err := processImageResponseFrame(frame, "b64_json")
	if done || err == nil {
		t.Fatalf("failure frame = done %v, err %v; want terminal error", done, err)
	}
	if statusCodeFromError(err) != http.StatusPaymentRequired || !strings.Contains(err.Error(), "insufficient_balance: no credits") {
		t.Fatalf("unexpected structured failure: status=%d err=%v", statusCodeFromError(err), err)
	}
}

func TestProcessImageResponseFramePreservesIncompleteFailure(t *testing.T) {
	frame := []byte("data: {\"type\":\"response.incomplete\",\"response\":{\"message\":\"generation stopped\"}}\n\n")
	_, done, err := processImageResponseFrame(frame, "b64_json")
	if done || err == nil || !strings.Contains(err.Error(), "generation stopped") {
		t.Fatalf("incomplete frame = done %v, err %v; want error", done, err)
	}
}

func TestImageResponseTerminalErrorDoesNotUseUnstructuredPromptText(t *testing.T) {
	event := map[string]any{"type": "response.failed", "response": map[string]any{
		"error": map[string]any{"code": "server_error", "message": "upstream rejected image"},
	}}
	payload, _ := json.Marshal(event)
	_, _, err := processImageResponseFrame(append([]byte("data: "), append(payload, []byte("\n\n")...)...), "b64_json")
	if err == nil || !strings.Contains(err.Error(), "server_error: upstream rejected image") {
		t.Fatalf("unexpected error: %v", err)
	}
}
