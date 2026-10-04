package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	internalconfig "github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	coreusage "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/usage"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
	"github.com/tidwall/gjson"
)

func TestFastTierNativeHTTPOnWire(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	testNativeHTTPTier(t, false, false)
}

func TestManagedAccountTierNativeHTTPOnWire(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	testNativeHTTPTier(t, true, false)
}

func TestManagedAccountProxyNativeHTTPOnWire(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	testNativeHTTPTier(t, true, true)
}

func testNativeHTTPTier(t *testing.T, managed bool, proxied bool) {
	gin.SetMode(gin.TestMode)
	for _, configured := range []string{"priority", "default", ""} {
		for _, stream := range []bool{false, true} {
			t.Run(fmt.Sprintf("default=%s/stream=%t", configured, stream), func(t *testing.T) {
				captured := make(chan []byte, 20)
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					body, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
					}
					captured <- body
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_native\",\"status\":\"completed\",\"service_tier\":\"default\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0,\"total_tokens\":1}}}\n\n")
				}))
				defer upstream.Close()
				cfg := &config.Config{}
				cfg.DisableImageGeneration = internalconfig.DisableImageGenerationAll
				if configured != "" && !managed {
					cfg.Payload.Default = []config.PayloadRule{{Models: []config.PayloadModelRule{{Name: "*", Protocol: "codex"}}, Params: map[string]any{"service_tier": configured}}}
				}
				manager := coreauth.NewManager(nil, nil, nil)
				manager.SetConfig(cfg)
				manager.SetRoundTripperProvider(newSidecarRoundTripperProvider())
				manager.RegisterExecutor(executor.NewCodexExecutor(cfg))
				auth := &coreauth.Auth{ID: fmt.Sprintf("http-tier-%s-%t", configured, stream), Provider: "codex", Status: coreauth.StatusActive, Attributes: map[string]string{"api_key": "fake-only", "base_url": upstream.URL}}
				proxyRequests := make(chan bool, 20)
				if proxied {
					direct := http.DefaultTransport.(*http.Transport).Clone()
					direct.Proxy = nil
					defer direct.CloseIdleConnections()
					proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.Header.Get("Proxy-Authorization") != "Basic Zml4dHVyZTpzZWNyZXQ=" {
							t.Error("proxy auth missing")
							w.WriteHeader(407)
							return
						}
						proxyRequests <- true
						request := r.Clone(r.Context())
						request.RequestURI = ""
						request.Header.Del("Proxy-Authorization")
						response, err := direct.RoundTrip(request)
						if err != nil {
							t.Error(err)
							w.WriteHeader(502)
							return
						}
						defer response.Body.Close()
						for key, values := range response.Header {
							w.Header()[key] = values
						}
						w.WriteHeader(response.StatusCode)
						_, _ = io.Copy(w, response.Body)
					}))
					defer proxyServer.Close()
					proxyURL, _ := url.Parse(proxyServer.URL)
					proxyURL.User = url.UserPassword("fixture", "secret")
					auth.ProxyURL = proxyURL.String()
				}
				if managed {
					auth.Metadata = map[string]any{"cml_default_service_tier": configured}
				}
				if _, err := manager.Register(context.Background(), auth); err != nil {
					t.Fatal(err)
				}
				observations := make(chan coreusage.Record, 20)
				coreusage.DefaultManager().RegisterNamed("tier-native-observer", tierRecordCollector{auth.ID, observations})
				registry.GetGlobalRegistry().RegisterClient(auth.ID, "codex", []*registry.ModelInfo{{ID: "gpt-5.5"}})
				defer registry.GetGlobalRegistry().UnregisterClient(auth.ID)
				spec := &apiKeySpec{ID: "client", Key: "http-client-fixture", Enabled: true}
				m := &manifest{apiKeyByValue: map[string]*apiKeySpec{spec.Key: spec}, ModelIDs: []string{"gpt-5.5"}}
				router := (&relayServer{runtime: manager, manifest: m, cfg: cfg, policy: &requestPolicy{manifest: m}}).router()
				cases := []struct {
					raw, want string
					status    int
				}{{"", configured, 200}, {"null", configured, 200}, {`""`, configured, 200}, {`"default"`, "default", 200}, {`"auto"`, "auto", 200}, {`"flex"`, "flex", 200}, {`"fast"`, "priority", 200}, {"42", "", 400}}
				for _, tc := range cases {
					body := fmt.Sprintf(`{"model":"gpt-5.5","input":"Unicode 🧪","stream":%t`, stream)
					if tc.raw != "" {
						body += `,"service_tier":` + tc.raw
					}
					body += `}`
					req := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body))
					req.Header.Set("Authorization", "Bearer "+spec.Key)
					response := httptest.NewRecorder()
					router.ServeHTTP(response, req)
					if response.Code != tc.status {
						t.Fatalf("status=%d want=%d response=%s", response.Code, tc.status, response.Body.String())
					}
					if tc.status == 400 {
						select {
						case <-captured:
							t.Fatal("invalid tier reached native upstream")
						default:
						}
						continue
					}
					assertTierRecord(t, observations, tc.raw, tc.want)
					if proxied {
						select {
						case <-proxyRequests:
						default:
							t.Fatal("request bypassed account proxy")
						}
					}
					select {
					case sent := <-captured:
						if got := gjson.GetBytes(sent, "service_tier").String(); got != tc.want {
							t.Fatalf("tier=%q want=%q sent=%s", got, tc.want, sent)
						}
					default:
						t.Fatal("native request not sent")
					}
				}
			})
		}
	}
}
