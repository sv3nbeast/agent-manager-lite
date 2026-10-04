package main

import (
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProviderGatewayServiceTierBoundaries(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name, raw, configured, want, echo string
		status                            int
	}{
		{"missing", "", "priority", "priority", "default", 200},
		{"null", "null", "priority", "priority", "default", 200},
		{"empty", `""`, "priority", "priority", "default", 200},
		{"blank", `"  "`, "priority", "priority", "default", 200},
		{"alias", `"fast"`, "default", "priority", "priority", 200},
		{"standard", `"default"`, "priority", "default", "default", 200},
		{"auto", `"auto"`, "priority", "auto", "default", 200},
		{"flex", `"flex"`, "priority", "flex", "flex", 200},
		{"no_echo", `"priority"`, "priority", "priority", "", 200},
		{"follow_null", "null", "", "", "", 200},
		{"invalid_string", `"banana"`, "priority", "", "", 400},
		{"invalid_number", "42", "priority", "", "", 400},
		{"invalid_object", `{}`, "priority", "", "", 400},
		{"invalid_boolean", "false", "priority", "", "", 400},
		{"duplicate", `"default","service_tier":"flex"`, "priority", "", "", 400},
	}
	for _, wire := range []string{"responses", "chat_completions"} {
		for _, stream := range []bool{false, true} {
			for _, tc := range cases {
				t.Run(fmt.Sprintf("%s/%s/stream=%t", wire, tc.name, stream), func(t *testing.T) {
					captured := make(chan map[string]any, 1)
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						var body map[string]any
						if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
							t.Error(err)
						}
						captured <- body
						result := map[string]any{"id": "resp_tier", "model": "gpt-5.5", "object": "response", "status": "completed", "output": []any{}}
						if wire == "chat_completions" {
							choice := map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "Unicode 🧪"}, "finish_reason": "stop"}
							if stream {
								delete(choice, "message")
								choice["delta"] = map[string]any{"content": "Unicode 🧪"}
							}
							result = map[string]any{"id": "chat_tier", "model": "gpt-5.5", "object": "chat.completion", "created": 1, "choices": []any{choice}}
						}
						if tc.echo != "" {
							result["service_tier"] = tc.echo
						}
						if stream && wire == "chat_completions" {
							result["object"] = "chat.completion.chunk"
						}
						raw, _ := json.Marshal(result)
						if stream {
							w.Header().Set("Content-Type", "text/event-stream")
							if wire == "responses" {
								fmt.Fprintf(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":%s}\n\n", raw)
							} else {
								fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", raw)
							}
						} else {
							w.Header().Set("Content-Type", "application/json")
							w.Write(raw)
						}
					}))
					defer upstream.Close()
					gateway := &providerGatewaySpec{BaseURL: upstream.URL, APIKey: "upstream-fixture", UpstreamModels: []string{"gpt-5.5"}, UpstreamModel: "gpt-5.5", WireAPI: wire}
					spec := apiKeySpec{ID: "test", Key: "client-fixture", Enabled: true, ProviderGateway: gateway}
					m := &manifest{APIKeys: []apiKeySpec{spec}, ModelIDs: []string{"gpt-5.5"}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: &spec}}
					cfg := &config.Config{}
					protocol := "openai-response"
					if wire == "chat_completions" {
						protocol = "openai"
					}
					if tc.configured != "" {
						cfg.Payload.Default = []config.PayloadRule{{Models: []config.PayloadModelRule{{Name: "*", Protocol: protocol}}, Params: map[string]any{"service_tier": tc.configured}}}
					}
					router := (&relayServer{runtime: &fakeRuntime{}, cfg: cfg, manifest: m, policy: &requestPolicy{manifest: m}}).router()
					body := fmt.Sprintf(`{"model":"gpt-5.5","input":[{"role":"user","content":"Unicode 🧪"}],"stream":%t`, stream)
					if tc.raw != "" {
						body += `,"service_tier":` + tc.raw
					}
					body += `}`
					req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body))
					req.Header.Set("Authorization", "Bearer "+spec.Key)
					response := httptest.NewRecorder()
					router.ServeHTTP(response, req)
					if response.Code != tc.status {
						t.Fatalf("status=%d want=%d body=%s", response.Code, tc.status, response.Body.String())
					}
					if tc.status != 200 {
						select {
						case <-captured:
							t.Fatal("invalid request reached upstream")
						default:
						}
						return
					}
					select {
					case got := <-captured:
						if tier, _ := got["service_tier"].(string); tier != tc.want {
							t.Errorf("wire tier=%q want=%q", tier, tc.want)
						}
						if tc.want == "" {
							if _, exists := got["service_tier"]; exists {
								t.Error("follow must omit field")
							}
						}
					default:
						t.Fatal("upstream not called")
					}
					output := response.Body.String()
					if tc.echo == "" {
						if strings.Contains(output, `"service_tier"`) {
							t.Errorf("invented upstream tier: %s", output)
						}
					} else if !strings.Contains(output, `"service_tier":"`+tc.echo+`"`) {
						t.Errorf("upstream echo was replaced: %s", output)
					}
				})
			}
		}
	}
}
