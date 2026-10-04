package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	internalconfig "github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/api/handlers"
	sdkopenai "github.com/router-for-me/CLIProxyAPI/v7/sdk/api/handlers/openai"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	coreusage "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/usage"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
	"github.com/tidwall/gjson"
)

// Exercise real downstream and upstream WebSockets plus the real Codex executor.
// Reusing one client socket also verifies tiers do not leak from the prior turn.
func TestFastTierWebsocketEndToEnd(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	testWebsocketTier(t, false)
}

func TestManagedAccountTierWebsocketEndToEnd(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	testWebsocketTier(t, true)
}

func testWebsocketTier(t *testing.T, managed bool) {
	gin.SetMode(gin.TestMode)
	for _, configured := range []string{"priority", "default", ""} {
		t.Run("default="+configured, func(t *testing.T) {
			captured := make(chan []byte, 20)
			upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.Close()
				for {
					_, body, err := conn.ReadMessage()
					if err != nil {
						return
					}
					captured <- body
					if err = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.completed","response":{"id":"resp_test","status":"completed","service_tier":"default","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}`)); err != nil {
						return
					}
				}
			}))
			defer upstream.Close()
			cfg := &config.Config{}
			cfg.DisableImageGeneration = internalconfig.DisableImageGenerationAll
			if configured != "" && !managed {
				cfg.Payload.Default = []config.PayloadRule{{Models: []config.PayloadModelRule{{Name: "*", Protocol: "codex"}}, Params: map[string]any{"service_tier": configured}}}
			}
			manager := coreauth.NewManager(nil, nil, nil)
			manager.SetConfig(cfg)
			exec := executor.NewCodexWebsocketsExecutor(cfg)
			manager.RegisterExecutor(exec)
			auth := &coreauth.Auth{ID: "tier-test-" + configured, Provider: "codex", Status: coreauth.StatusActive, Attributes: map[string]string{"api_key": "fake-only", "base_url": upstream.URL, "websockets": "true"}}
			if managed {
				auth.Metadata = map[string]any{"cml_default_service_tier": configured}
			}
			if _, err := manager.Register(context.Background(), auth); err != nil {
				t.Fatal(err)
			}
			observations := make(chan coreusage.Record, 20)
			coreusage.DefaultManager().RegisterNamed("tier-ws-observer", tierRecordCollector{auth.ID, observations})
			registry.GetGlobalRegistry().RegisterClient(auth.ID, "codex", []*registry.ModelInfo{{ID: "gpt-5.5"}})
			defer registry.GetGlobalRegistry().UnregisterClient(auth.ID)
			handler := sdkopenai.NewOpenAIResponsesAPIHandler(handlers.NewBaseAPIHandlers(&cfg.SDKConfig, manager))
			spec := &apiKeySpec{ID: "client", Key: "ws-client-fixture", Enabled: true, ResponsesWebsockets: true}
			m := &manifest{apiKeyByValue: map[string]*apiKeySpec{spec.Key: spec}}
			relay := &relayServer{manifest: m, cfg: cfg, policy: &requestPolicy{manifest: m}, responsesWebsocket: handler.ResponsesWebsocket}
			server := httptest.NewServer(relay.router())
			defer server.Close()
			header := http.Header{"Authorization": []string{"Bearer " + spec.Key}}
			conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/v1/responses", header)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			cases := []struct {
				raw, want string
				invalid   bool
			}{{`"default"`, "default", false}, {"", configured, false}, {"null", configured, false}, {`""`, configured, false}, {`"fast"`, "priority", false}, {`"flex"`, "flex", false}, {`"auto"`, "auto", false}, {"42", "", true}, {`"banana"`, "", true}, {"", configured, false}}
			for index, tc := range cases {
				body := fmt.Sprintf(`{"type":"response.create","model":"gpt-5.5","input":[{"role":"user","content":"turn %d 🧪"}]`, index)
				if tc.raw != "" {
					body += `,"service_tier":` + tc.raw
				}
				body += `}`
				conn.SetReadDeadline(time.Now().Add(5 * time.Second))
				if err = conn.WriteMessage(websocket.TextMessage, []byte(body)); err != nil {
					t.Fatal(err)
				}
				for {
					_, response, readErr := conn.ReadMessage()
					if readErr != nil {
						t.Fatal(readErr)
					}
					kind := gjson.GetBytes(response, "type").String()
					if kind == "error" {
						if !tc.invalid {
							t.Fatalf("unexpected WS error: %s", response)
						}
						break
					}
					if kind == "response.completed" {
						if tc.invalid {
							t.Fatal("invalid tier reached execution")
						}
						break
					}
				}
				if tc.invalid {
					select {
					case b := <-captured:
						t.Fatalf("invalid request sent upstream: %s", b)
					default:
					}
					continue
				}
				assertTierRecord(t, observations, tc.raw, tc.want)
				select {
				case sent := <-captured:
					if tier := gjson.GetBytes(sent, "service_tier").String(); tier != tc.want {
						t.Fatalf("turn %d tier=%q want=%q payload=%s", index, tier, tc.want, sent)
					}
				case <-time.After(time.Second):
					t.Fatal("no upstream WS frame")
				}
			}
		})
	}
}
