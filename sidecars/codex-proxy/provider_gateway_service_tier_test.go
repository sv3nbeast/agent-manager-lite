package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

// Assert the real HTTP request received by an upstream, not the projected config.
func TestProviderGatewayServiceTierOnWire(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct{ name, configured, incoming, want, ruleModel string }{
		{"fast_default", "priority", "", "priority", "*"},
		{"standard_default", "default", "", "default", "*"},
		{"follow_request", "", "", "", "*"},
		{"explicit_standard", "priority", "default", "default", "*"},
		{"explicit_flex", "priority", "flex", "flex", "*"},
		{"explicit_priority", "default", "priority", "priority", "*"},
		{"explicit_auto", "priority", "auto", "auto", "*"},
		{"unmatched_rule", "priority", "", "", "another-model"},
	}
	for _, tc := range cases {
		for _, streaming := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/stream=%t", tc.name, streaming), func(t *testing.T) {
				captured := make(chan map[string]any, 1)
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Authorization") != "Bearer local-upstream-test" {
						t.Error("upstream authorization was not preserved")
					}
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					captured <- body
					result := `{"id":"resp_tier","object":"response","status":"completed","model":"gpt-5.5","service_tier":"default","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}`
					if streaming {
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprintf(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":%s}\n\n", result)
					} else {
						w.Header().Set("Content-Type", "application/json")
						io.WriteString(w, result)
					}
				}))
				defer upstream.Close()
				gateway := &providerGatewaySpec{BaseURL: upstream.URL, APIKey: "local-upstream-test", UpstreamModel: "gpt-5.5", UpstreamModels: []string{"gpt-5.5"}, WireAPI: "responses"}
				spec := apiKeySpec{ID: "local-key", Key: "local-client-test", Enabled: true, ProviderGateway: gateway}
				m := &manifest{APIKeys: []apiKeySpec{spec}, ModelIDs: []string{"gpt-5.5"}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: &spec}}
				cfg := &config.Config{}
				if tc.configured != "" {
					cfg.Payload.Default = []config.PayloadRule{{Models: []config.PayloadModelRule{{Name: tc.ruleModel, Protocol: "openai-response"}}, Params: map[string]any{"service_tier": tc.configured}}}
				}
				router := (&relayServer{runtime: &fakeRuntime{}, cfg: cfg, manifest: m, policy: &requestPolicy{manifest: m}}).router()
				body := map[string]any{"model": "gpt-5.5", "input": "检查换行\n与字符 🧪", "stream": streaming}
				if tc.incoming != "" {
					body["service_tier"] = tc.incoming
				}
				raw, _ := json.Marshal(body)
				req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(string(raw)))
				req.Header.Set("Authorization", "Bearer "+spec.Key)
				req.Header.Set("Content-Type", "application/json")
				response := httptest.NewRecorder()
				router.ServeHTTP(response, req)
				if response.Code != 200 {
					t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
				}
				select {
				case got := <-captured:
					tier, _ := got["service_tier"].(string)
					if tier != tc.want {
						t.Fatalf("upstream received tier=%q, want %q", tier, tc.want)
					}
					if tc.want == "" {
						if _, exists := got["service_tier"]; exists {
							t.Error("follow mode must not add a tier")
						}
					}
					if got["input"] != body["input"] {
						t.Fatalf("input changed: %#v", got["input"])
					}
				default:
					t.Fatal("request never reached upstream")
				}
			})
		}
	}
}
