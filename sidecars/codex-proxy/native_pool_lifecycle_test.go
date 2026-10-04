package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

type nativePoolAttempt struct{ account, tier, body string }
type nativePoolCapture struct {
	sync.Mutex
	attempts []nativePoolAttempt
}

func (c *nativePoolCapture) add(account string, body []byte) {
	c.Lock()
	defer c.Unlock()
	c.attempts = append(c.attempts, nativePoolAttempt{account, gjson.GetBytes(body, "service_tier").String(), string(body)})
}
func (c *nativePoolCapture) read() []nativePoolAttempt {
	c.Lock()
	defer c.Unlock()
	return append([]nativePoolAttempt(nil), c.attempts...)
}

// Real relay -> production selector wrappers -> auth manager -> CodexAutoExecutor.
// OAuth metadata is synthetic; no API-key auth or external token endpoint is used.
func nativePoolServer(t *testing.T, upstream string, scope []string, timeoutMS ...int) (string, map[string]chan coreusage.Record) {
	t.Helper()
	cfg := &config.Config{}
	cfg.DisableImageGeneration = internalconfig.DisableImageGenerationAll
	cfg.Routing.SessionAffinity = true
	cfg.Routing.SessionAffinityTTL = "1m"
	cfg.Streaming.StreamOpenTimeoutMS = 1500
	cfg.Streaming.StreamIdleTimeoutMS = 1500
	if len(timeoutMS) > 0 {
		cfg.Streaming.StreamOpenTimeoutMS = timeoutMS[0]
		cfg.Streaming.StreamIdleTimeoutMS = timeoutMS[0]
	}
	cfg.Streaming.StreamOpenMaxAttempts = 1
	spec := &apiKeySpec{ID: "fixture-client", Key: "fixture-client", Enabled: true, ResponsesWebsockets: true, AccountIDs: scope}
	m := &manifest{ModelIDs: []string{"gpt-5.5"}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: spec},
		accountByID: map[string]*accountSpec{}, accountByAuthID: map[string]*accountSpec{}, originalIndexByID: map[string]int{}}
	for i, id := range []string{"a", "b"} {
		account := &accountSpec{ID: id, AuthID: strings.ToLower(t.Name()) + "-" + id, AuthKind: "oauth"}
		m.Accounts = append(m.Accounts, *account)
		m.accountByID[id] = account
		m.accountByAuthID[account.AuthID] = account
		m.originalIndexByID[id] = i
	}
	selector := buildCoreAuthSelectorWithConcurrency(cfg, &cockpitSelector{manifest: m}, m, nil, nil)
	if stoppable, ok := selector.(coreauth.StoppableSelector); ok {
		t.Cleanup(stoppable.Stop)
	}
	manager := coreauth.NewManager(nil, selector, nil)
	manager.SetConfig(cfg)
	manager.SetRetryConfig(0, 0, 2)
	manager.SetRoundTripperProvider(newSidecarRoundTripperProvider())
	manager.RegisterExecutor(executor.NewCodexAutoExecutor(cfg))
	m.authManager = manager
	records := map[string]chan coreusage.Record{}
	for _, account := range m.Accounts {
		id := account.ID
		tier := "priority"
		if id == "b" {
			tier = "default"
		}
		auth := &coreauth.Auth{ID: account.AuthID, Provider: "codex", Status: coreauth.StatusActive,
			Attributes: map[string]string{"base_url": upstream, "websockets": "true"},
			Metadata:   map[string]any{"access_token": "fixture-" + id, "account_id": "fixture-account-" + id, "refresh_owner": "codex_manager_lite", "cml_default_service_tier": tier}}
		if auth.AuthKind() != coreauth.AuthKindOAuth {
			t.Fatal("fixture must exercise OAuth auth")
		}
		if _, err := manager.Register(context.Background(), auth); err != nil {
			t.Fatal(err)
		}
		registry.GetGlobalRegistry().RegisterClient(auth.ID, "codex", []*registry.ModelInfo{{ID: "gpt-5.5"}})
		t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(auth.ID) })
		records[id] = make(chan coreusage.Record, 20)
		coreusage.DefaultManager().RegisterNamed("pool-observer-"+id, tierRecordCollector{auth.ID, records[id]})
	}
	handler := sdkopenai.NewOpenAIResponsesAPIHandler(handlers.NewBaseAPIHandlers(&cfg.SDKConfig, manager))
	relay := &relayServer{runtime: manager, manifest: m, cfg: cfg, policy: &requestPolicy{manifest: m}, responsesWebsocket: handler.ResponsesWebsocket}
	ctx, cancel := context.WithCancel(context.Background())
	server := httptest.NewUnstartedServer(relay.router())
	server.Config.BaseContext = func(net.Listener) context.Context { return ctx }
	server.Start()
	t.Cleanup(func() {
		cancel()
		manager.CloseExecutionSession(coreauth.CloseAllExecutionSessionsID)
		server.CloseClientConnections()
		server.Close()
	})
	return server.URL, records
}

// Run both upstream protocols through actual sockets. The callback returns false
// to disconnect WS; HTTP always ends when the callback returns.
func nativePoolUpstream(t *testing.T, captured *nativePoolCapture, handle func(*http.Request, string, []byte, func(string) error) bool) string {
	t.Helper()
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := nativePoolAccount(t, r)
		if websocket.IsWebSocketUpgrade(r) {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close()
			_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			for {
				_, body, err := conn.ReadMessage()
				if err != nil {
					return
				}
				captured.add(id, body)
				if !handle(r, id, body, func(event string) error { return conn.WriteMessage(websocket.TextMessage, []byte(event)) }) {
					return
				}
			}
		}
		body, _ := io.ReadAll(r.Body)
		captured.add(id, body)
		w.Header().Set("Content-Type", "text/event-stream")
		handle(r, id, body, func(event string) error {
			_, err := fmt.Fprintf(w, "data: %s\n\n", event)
			w.(http.Flusher).Flush()
			return err
		})
	}))
	t.Cleanup(server.Close)
	return server.URL
}

const nativePoolRateLimit = `{"type":"error","status":429,"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"fixture exhausted"}}`

func TestNativePoolDoesNotReplayAfterOutput(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	gin.SetMode(gin.TestMode)
	for _, transport := range []string{"sse", "ws"} {
		for _, failure := range []string{"error", "disconnect"} {
			t.Run(transport+"/"+failure, func(t *testing.T) {
				var captured nativePoolCapture
				upstream := nativePoolUpstream(t, &captured, func(_ *http.Request, id string, _ []byte, send func(string) error) bool {
					if id == "b" {
						_ = send(nativePoolCompleted)
						return true
					}
					_ = send(nativePoolDelta)
					if failure == "error" {
						_ = send(nativePoolRateLimit)
					}
					return false
				})
				base, records := nativePoolServer(t, upstream, []string{"a", "b"})
				body := `{"model":"gpt-5.5","input":[],"stream":true,"service_tier":"auto"}`
				var result string
				if transport == "sse" {
					ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					defer cancel()
					_, result = nativePoolHTTP(t, ctx, base, body)
				} else {
					conn := dialLifecycleWebsocket(t, "ws"+strings.TrimPrefix(base, "http")+"/v1/responses")
					if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create",`+body[1:])); err != nil {
						t.Fatal(err)
					}
					_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
					for {
						_, data, err := conn.ReadMessage()
						if err != nil {
							var netErr net.Error
							if errors.As(err, &netErr) && netErr.Timeout() {
								t.Fatal("failed turn remained open until client deadline")
							}
							break
						}
						result += string(data) + "\n"
					}
				}
				if strings.Count(result, "中文🧪") != 1 || strings.Contains(result, `"type":"response.completed"`) {
					t.Fatalf("partial output lost/duplicated or invented completion: %s", result)
				}
				nativePoolRecord(t, records["a"], true, "auto")
				attempts := captured.read()
				if len(attempts) != 1 || attempts[0].account != "a" || attempts[0].tier != "auto" {
					t.Fatalf("partially emitted turn replayed: %+v", attempts)
				}
			})
		}
	}
}

func TestNativePoolScopeSurvivesFailure(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	gin.SetMode(gin.TestMode)
	for _, transport := range []string{"http", "sse", "ws"} {
		t.Run(transport, func(t *testing.T) {
			var captured nativePoolCapture
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				captured.add(nativePoolAccount(t, r), body)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				fmt.Fprint(w, nativePoolError(429))
			}))
			t.Cleanup(upstream.Close)
			base, records := nativePoolServer(t, upstream.URL, []string{"a"})
			body := fmt.Sprintf(`{"model":"gpt-5.5","input":[],"stream":%t}`, transport == "sse")
			tier := "priority"
			if transport == "ws" {
				tier = "unsent"
				conn := dialLifecycleWebsocket(t, "ws"+strings.TrimPrefix(base, "http")+"/v1/responses")
				if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create",`+body[1:])); err != nil {
					t.Fatal(err)
				}
				_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
				_, data, err := conn.ReadMessage()
				var netErr net.Error
				if errors.As(err, &netErr) && netErr.Timeout() || err == nil && gjson.GetBytes(data, "type").String() != "error" {
					t.Fatalf("expected scope exhaustion error or closed session: %s %v", data, err)
				}
			} else {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				code, data := nativePoolHTTP(t, ctx, base, body)
				if code != 429 || strings.Contains(data, "response.completed") {
					t.Fatalf("scope exhaustion hidden: %d %s", code, data)
				}
			}
			nativePoolRecord(t, records["a"], true, tier)
			attempts := captured.read()
			if len(attempts) != 1 || attempts[0].account != "a" {
				t.Fatalf("API key scope escaped on failover: %+v", attempts)
			}
		})
	}
}

func TestNativePoolCancellationAndTimeoutDoNotRotate(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	gin.SetMode(gin.TestMode)
	for _, scenario := range []struct {
		transport           string
		afterDelta, timeout bool
	}{
		{"http", false, false}, {"sse", false, false}, {"sse", true, false},
		{"ws", false, false}, {"ws", true, false},
		{"sse", false, true}, {"sse", true, true}, {"ws", false, true}, {"ws", true, true},
	} {
		transport, afterDelta := scenario.transport, scenario.afterDelta
		t.Run(fmt.Sprintf("%s/afterDelta=%t/timeout=%t", transport, afterDelta, scenario.timeout), func(t *testing.T) {
			var captured nativePoolCapture
			started, closed := make(chan struct{}, 4), make(chan struct{}, 4)
			upgrader := websocket.Upgrader{}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				id := nativePoolAccount(t, r)
				defer func() { closed <- struct{}{} }()
				if websocket.IsWebSocketUpgrade(r) {
					conn, err := upgrader.Upgrade(w, r, nil)
					if err != nil {
						return
					}
					defer conn.Close()
					_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
					_, body, err := conn.ReadMessage()
					if err != nil {
						return
					}
					captured.add(id, body)
					started <- struct{}{}
					if afterDelta {
						_ = conn.WriteMessage(websocket.TextMessage, []byte(nativePoolDelta))
					}
					_, _, _ = conn.ReadMessage()
					return
				}
				body, _ := io.ReadAll(r.Body)
				captured.add(id, body)
				started <- struct{}{}
				if afterDelta {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprintf(w, "data: %s\n\n", nativePoolDelta)
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
			}))
			t.Cleanup(upstream.Close)
			budget := 5000
			if scenario.timeout {
				budget = 100
			}
			base, records := nativePoolServer(t, upstream.URL, []string{"a", "b"}, budget)
			body := fmt.Sprintf(`{"model":"gpt-5.5","input":[],"stream":%t,"service_tier":"flex"}`, transport == "sse")
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			delta, done := make(chan struct{}, 1), make(chan struct{})
			var conn *websocket.Conn
			if transport == "ws" {
				conn = dialLifecycleWebsocket(t, "ws"+strings.TrimPrefix(base, "http")+"/v1/responses")
				if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create",`+body[1:])); err != nil {
					t.Fatal(err)
				}
			} else {
				req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/responses", strings.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Authorization", "Bearer fixture-client")
				req.Header.Set("Content-Type", "application/json")
				go func() {
					defer close(done)
					response, err := http.DefaultClient.Do(req)
					if err != nil {
						return
					}
					defer response.Body.Close()
					scanner := bufio.NewScanner(response.Body)
					for scanner.Scan() {
						if strings.Contains(scanner.Text(), "中文🧪") {
							select {
							case delta <- struct{}{}:
							default:
							}
						}
					}
				}()
			}
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("upstream not reached")
			}
			if afterDelta {
				if conn != nil {
					_ = conn.SetReadDeadline(time.Now().Add(time.Second))
					_, data, err := conn.ReadMessage()
					if err != nil || gjson.GetBytes(data, "delta").String() != "中文🧪" {
						t.Fatalf("missing output before cancellation: %s %v", data, err)
					}
				} else {
					select {
					case <-delta:
					case <-time.After(time.Second):
						t.Fatal("delta not forwarded")
					}
				}
			}
			if conn != nil {
				if scenario.timeout {
					_ = conn.SetReadDeadline(time.Now().Add(time.Second))
					for {
						_, data, err := conn.ReadMessage()
						if err != nil {
							var netErr net.Error
							if errors.As(err, &netErr) && netErr.Timeout() {
								t.Fatal("gateway timeout did not close client")
							}
							break
						}
						kind := gjson.GetBytes(data, "type").String()
						if kind != "error" && kind != "response.failed" {
							t.Fatalf("unexpected timeout output: %s", data)
						}
					}
				} else {
					conn.Close()
				}
			} else {
				if !scenario.timeout {
					cancel()
				}
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Fatal("downstream did not terminate")
				}
			}
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("upstream still executing after cancellation/timeout")
			}
			nativePoolRecord(t, records["a"], true, "flex")
			if attempts := captured.read(); len(attempts) != 1 || attempts[0].account != "a" {
				t.Fatalf("cancelled/timed-out request replayed: %+v", attempts)
			}
		})
	}
}

func TestNativePoolRetainsSuccessfulAccountAndPerTurnTier(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	gin.SetMode(gin.TestMode)
	for _, transport := range []string{"http", "sse", "ws"} {
		t.Run(transport, func(t *testing.T) {
			var captured nativePoolCapture
			upstream := nativePoolUpstream(t, &captured, func(_ *http.Request, id string, _ []byte, send func(string) error) bool {
				if id == "a" {
					_ = send(nativePoolRateLimit)
					return false
				}
				_ = send(nativePoolCompleted)
				return transport != "ws" || len(captured.read()) < 4
			})
			base, records := nativePoolServer(t, upstream, []string{"a", "b"})
			var conn *websocket.Conn
			if transport == "ws" {
				conn = dialLifecycleWebsocket(t, "ws"+strings.TrimPrefix(base, "http")+"/v1/responses")
				_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
			}
			for _, tier := range []string{"", "flex", ""} {
				body := fmt.Sprintf(`{"model":"gpt-5.5","input":[{"role":"user","content":"fixture"}],"stream":%t`, transport == "sse")
				if tier != "" {
					body += `,"service_tier":"` + tier + `"`
				}
				body += "}"
				var result string
				if conn != nil {
					if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create",`+body[1:])); err != nil {
						t.Fatal(err)
					}
					_, data, err := conn.ReadMessage()
					if err != nil {
						t.Fatal(err)
					}
					result = string(data)
				} else {
					ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					defer cancel()
					code, data := nativePoolHTTP(t, ctx, base, body)
					if code != 200 {
						t.Fatalf("turn failed: %d %s", code, data)
					}
					result = data
				}
				if !strings.Contains(result, "resp_pool_fixture") {
					t.Fatalf("turn did not complete: %s", result)
				}
			}
			attempts := captured.read()
			if len(attempts) != 4 {
				t.Fatalf("wrong attempt count: %+v", attempts)
			}
			for i, want := range []nativePoolAttempt{{account: "a", tier: "priority"}, {account: "b", tier: "default"}, {account: "b", tier: "flex"}, {account: "b", tier: "default"}} {
				if attempts[i].account != want.account || attempts[i].tier != want.tier {
					t.Fatalf("account or tier inherited from wrong turn: %+v", attempts)
				}
				nativePoolRecord(t, records[want.account], i == 0, want.tier)
			}
			if conn != nil {
				_, _, err := conn.ReadMessage()
				var netErr net.Error
				if err == nil || errors.As(err, &netErr) && netErr.Timeout() {
					t.Fatalf("replacement connection disconnect not propagated: %v", err)
				}
			}
		})
	}
}

func TestNativePoolContinuationRequiresFullReplay(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	gin.SetMode(gin.TestMode)
	for _, replayTransport := range []string{"http", "ws"} {
		t.Run(replayTransport, func(t *testing.T) {
			var captured nativePoolCapture
			upstream := nativePoolUpstream(t, &captured, func(_ *http.Request, id string, body []byte, send func(string) error) bool {
				if id == "a" && gjson.GetBytes(body, "previous_response_id").Exists() {
					_ = send(nativePoolRateLimit)
					return true // Keep the upstream alive so the gateway must decide to close.
				}
				_ = send(nativePoolCompleted)
				return true
			})
			base, records := nativePoolServer(t, upstream, []string{"a", "b"})
			url := "ws" + strings.TrimPrefix(base, "http") + "/v1/responses"
			conn := dialLifecycleWebsocket(t, url)
			_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
			first := `{"type":"response.create","model":"gpt-5.5","input":[{"role":"user","content":"第一轮🧪"}]}`
			if err := conn.WriteMessage(websocket.TextMessage, []byte(first)); err != nil {
				t.Fatal(err)
			}
			_, data, err := conn.ReadMessage()
			if err != nil || gjson.GetBytes(data, "type").String() != "response.completed" {
				t.Fatalf("first turn failed: %s %v", data, err)
			}
			nativePoolRecord(t, records["a"], false, "priority")
			second := `{"type":"response.create","previous_response_id":"resp_pool_fixture","input":[{"role":"user","content":"第二轮"}],"service_tier":"flex"}`
			if err := conn.WriteMessage(websocket.TextMessage, []byte(second)); err != nil {
				t.Fatal(err)
			}
			_, data, err = conn.ReadMessage()
			var closeErr *websocket.CloseError
			if !errors.As(err, &closeErr) || closeErr.Code != websocket.CloseServiceRestart || closeErr.Text != "upstream requires HTTP replay" {
				t.Fatalf("continuation must request full replay: %s %v", data, err)
			}
			nativePoolRecord(t, records["a"], true, "flex")
			attempts := captured.read()
			if len(attempts) != 2 || attempts[0].account != "a" || attempts[1].account != "a" {
				t.Fatalf("connection-bound continuation escaped to another account: %+v", attempts)
			}
			replay := `{"model":"gpt-5.5","input":[{"role":"user","content":"第一轮🧪"},{"role":"assistant","content":"首轮回答"},{"role":"user","content":"第二轮"}],"service_tier":"flex"}`
			if replayTransport == "ws" {
				replayConn := dialLifecycleWebsocket(t, url)
				_ = replayConn.SetReadDeadline(time.Now().Add(3 * time.Second))
				if err := replayConn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create",`+replay[1:])); err != nil {
					t.Fatal(err)
				}
				_, data, err = replayConn.ReadMessage()
				if err != nil || gjson.GetBytes(data, "type").String() != "response.completed" {
					t.Fatalf("full replay failed: %s %v", data, err)
				}
			} else {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				code, body := nativePoolHTTP(t, ctx, base, replay)
				if code != 200 || !strings.Contains(body, "resp_pool_fixture") {
					t.Fatalf("full HTTP replay failed: %d %s", code, body)
				}
			}
			nativePoolRecord(t, records["b"], false, "flex")
			attempts = captured.read()
			if len(attempts) != 3 || attempts[2].account != "b" || attempts[2].tier != "flex" {
				t.Fatalf("wrong replay selection/tier: %+v", attempts)
			}
			actual := gjson.Parse(attempts[2].body)
			if actual.Get("previous_response_id").Exists() || len(actual.Get("input").Array()) != 3 || actual.Get("input.0.content").String() != "第一轮🧪" || actual.Get("input.1.content").String() != "首轮回答" || actual.Get("input.2.content").String() != "第二轮" {
				t.Fatalf("replay did not preserve full conversation: %s", attempts[2].body)
			}
		})
	}
}

const nativePoolCompleted = `{"type":"response.completed","response":{"id":"resp_pool_fixture","status":"completed","service_tier":"default","output":[],"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}`
const nativePoolDelta = `{"type":"response.output_text.delta","delta":"中文🧪"}`

func nativePoolAccount(t *testing.T, r *http.Request) string {
	t.Helper()
	id := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer fixture-")
	if id != "a" && id != "b" {
		t.Errorf("unexpected OAuth authorization")
	}
	if r.Header.Get("Chatgpt-Account-Id") != "fixture-account-"+id {
		t.Errorf("wrong account binding for %s", id)
	}
	return id
}

func nativePoolHTTP(t *testing.T, ctx context.Context, base, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/responses", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer fixture-client")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Session-ID", "fixture-session")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, string(data)
}

func nativePoolRecord(t *testing.T, records <-chan coreusage.Record, failed bool, tier string) {
	t.Helper()
	select {
	case record := <-records:
		outboundOK := tier == "unsent" && record.OutboundServiceTier == nil || record.OutboundServiceTier != nil && *record.OutboundServiceTier == tier
		if record.Failed != failed || !outboundOK {
			t.Fatalf("incorrect attempt evidence: %+v", record)
		}
		if failed && record.ResponseServiceTier != "" {
			t.Fatal("failed attempt has invented tier echo")
		}
		if !failed && (record.ResponseServiceTier != "default" || record.Detail.InputTokens != 5) {
			t.Fatalf("success usage missing: %+v", record)
		}
	case <-time.After(time.Second):
		t.Fatal("attempt usage missing")
	}
}

func nativePoolError(status int) string {
	typ := map[int]string{400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 429: "rate_limit_error", 500: "server_error"}[status]
	return fmt.Sprintf(`{"error":{"type":%q,"message":"fixture credential error"}}`, typ)
}

func TestNativePoolPreOutputFailoverOnWire(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	gin.SetMode(gin.TestMode)
	for _, transport := range []string{"http", "sse", "ws"} {
		for _, status := range []int{401, 403, 429, 500, 400} {
			for _, explicit := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%d/explicit=%t", transport, status, explicit), func(t *testing.T) {
					var captured nativePoolCapture
					upgrader := websocket.Upgrader{}
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						id := nativePoolAccount(t, r)
						if websocket.IsWebSocketUpgrade(r) && id == "a" {
							// The handshake does not contain a response body/tier yet.
							captured.add(id, nil)
							w.Header().Set("Content-Type", "application/json")
							w.WriteHeader(status)
							fmt.Fprint(w, nativePoolError(status))
							return
						}
						if websocket.IsWebSocketUpgrade(r) {
							conn, err := upgrader.Upgrade(w, r, nil)
							if err != nil {
								return
							}
							defer conn.Close()
							for {
								_, body, err := conn.ReadMessage()
								if err != nil {
									return
								}
								captured.add(id, body)
								if err = conn.WriteMessage(websocket.TextMessage, []byte(nativePoolCompleted)); err != nil {
									return
								}
							}
						}
						body, _ := io.ReadAll(r.Body)
						captured.add(id, body)
						if id == "a" {
							w.Header().Set("Content-Type", "application/json")
							w.WriteHeader(status)
							fmt.Fprint(w, nativePoolError(status))
							return
						}
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprintf(w, "data: %s\n\n", nativePoolCompleted)
					}))
					t.Cleanup(upstream.Close)
					base, records := nativePoolServer(t, upstream.URL, []string{"a", "b"})
					body := fmt.Sprintf(`{"model":"gpt-5.5","input":[{"role":"user","content":"Unicode 🧪"}],"stream":%t`, transport == "sse")
					if explicit {
						body += `,"service_tier":"flex"`
					}
					body += "}"
					ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					defer cancel()
					var result string
					if transport == "ws" {
						conn := dialLifecycleWebsocket(t, "ws"+strings.TrimPrefix(base, "http")+"/v1/responses")
						body = `{"type":"response.create",` + body[1:]
						if err := conn.WriteMessage(websocket.TextMessage, []byte(body)); err != nil {
							t.Fatal(err)
						}
						conn.SetReadDeadline(time.Now().Add(3 * time.Second))
						_, data, err := conn.ReadMessage()
						if err != nil {
							t.Fatal(err)
						}
						result = string(data)
					} else {
						code, data := nativePoolHTTP(t, ctx, base, body)
						result = data
						if status != 400 && code != 200 {
							t.Fatalf("failed to rotate: %d %s", code, data)
						}
					}
					attempts := captured.read()
					if status == 400 {
						if len(attempts) != 1 || strings.Contains(result, "response.completed") {
							t.Fatalf("request error rotated or succeeded: %+v %s", attempts, result)
						}
						return
					}
					if len(attempts) != 2 || attempts[0].account != "a" || attempts[1].account != "b" {
						t.Fatalf("wrong failover: %+v", attempts)
					}
					if !strings.Contains(result, "resp_pool_fixture") || strings.Contains(result, "fixture credential error") {
						t.Fatalf("fallback response incorrect: %s", result)
					}
					firstTier, nextTier := "priority", "default"
					if explicit {
						firstTier = "flex"
						nextTier = "flex"
					}
					if attempts[1].tier != nextTier || transport != "ws" && attempts[0].tier != firstTier {
						t.Fatalf("tier crossed accounts: %+v", attempts)
					}
					if transport == "ws" {
						firstTier = "unsent"
					}
					nativePoolRecord(t, records["a"], true, firstTier)
					nativePoolRecord(t, records["b"], false, nextTier)
				})
			}
		}
	}
}
