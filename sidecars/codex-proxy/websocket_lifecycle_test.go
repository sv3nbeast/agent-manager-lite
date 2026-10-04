package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
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

// The real downstream handler, auth manager and Codex executor all participate.
// No network method or timer is mocked, and test cleanup cancels any stuck turn.
func lifecycleWebsocketServer(t *testing.T, upstreamURL string, timeoutMS int, records ...chan coreusage.Record) string {
	t.Helper()
	cfg := &config.Config{}
	cfg.DisableImageGeneration = internalconfig.DisableImageGenerationAll
	cfg.Streaming.StreamOpenTimeoutMS = timeoutMS
	cfg.Streaming.StreamIdleTimeoutMS = timeoutMS
	cfg.Streaming.ImageStreamOpenTimeoutMS = timeoutMS * 5
	cfg.Streaming.ImageStreamIdleTimeoutMS = timeoutMS * 5
	manager := coreauth.NewManager(nil, nil, nil)
	manager.SetConfig(cfg)
	manager.RegisterExecutor(executor.NewCodexWebsocketsExecutor(cfg))
	auth := &coreauth.Auth{ID: t.Name(), Provider: "codex", Status: coreauth.StatusActive,
		Attributes: map[string]string{"api_key": "fixture-upstream", "base_url": upstreamURL, "websockets": "true"},
		Metadata:   map[string]any{"cml_default_service_tier": "priority"}}
	if _, err := manager.Register(context.Background(), auth); err != nil {
		t.Fatal(err)
	}
	if len(records) > 0 {
		coreusage.DefaultManager().RegisterNamed("ws-lifecycle-observer", tierRecordCollector{auth.ID, records[0]})
	}
	registry.GetGlobalRegistry().RegisterClient(auth.ID, "codex", []*registry.ModelInfo{{ID: "gpt-5.5"}})
	t.Cleanup(func() { registry.GetGlobalRegistry().UnregisterClient(auth.ID) })
	handler := sdkopenai.NewOpenAIResponsesAPIHandler(handlers.NewBaseAPIHandlers(&cfg.SDKConfig, manager))
	spec := &apiKeySpec{ID: "fixture", Key: "fixture-client", Enabled: true, ResponsesWebsockets: true}
	m := &manifest{apiKeyByValue: map[string]*apiKeySpec{spec.Key: spec}}
	relay := &relayServer{manifest: m, cfg: cfg, policy: &requestPolicy{manifest: m}, responsesWebsocket: handler.ResponsesWebsocket}
	ctx, cancel := context.WithCancel(context.Background())
	server := httptest.NewUnstartedServer(relay.router())
	server.Config.BaseContext = func(net.Listener) context.Context { return ctx }
	server.Start()
	t.Cleanup(func() { cancel(); server.CloseClientConnections(); server.Close() })
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/responses"
}

func TestNativeWebsocketImageBudgetAndFinalEventBeforeClose(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	gin.SetMode(gin.TestMode)
	upgrader := websocket.Upgrader{}
	var attempts atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		if _, _, err = conn.ReadMessage(); err != nil {
			return
		}
		attempts.Add(1)
		// Exceeds the normal 50ms setting but fits the configured image budget.
		time.Sleep(100 * time.Millisecond)
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.output_text.delta","delta":"中文🧪"}`))
		time.Sleep(100 * time.Millisecond)
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.completed","response":{"id":"resp_image_fixture","status":"completed","service_tier":"default","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`))
	}))
	t.Cleanup(upstream.Close)
	records := make(chan coreusage.Record, 4)
	conn := dialLifecycleWebsocket(t, lifecycleWebsocketServer(t, upstream.URL, 50, records))
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create","model":"gpt-5.5","input":[],"tools":[{"type":"image_generation"}]}`)); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(time.Second))
	for _, want := range []string{"response.output_text.delta", "response.completed"} {
		_, data, err := conn.ReadMessage()
		if err != nil || gjson.GetBytes(data, "type").String() != want {
			t.Fatalf("final event lost: %s, %v", data, err)
		}
	}
	_, data, err := conn.ReadMessage()
	if err == nil {
		t.Fatalf("event appended after completion: %s", data)
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		t.Fatal("idle upstream disconnect not propagated")
	}
	select {
	case record := <-records:
		if record.Failed {
			t.Fatalf("completed response counted as failure: %+v", record)
		}
	case <-time.After(time.Second):
		t.Fatal("missing completed usage")
	}
	if attempts.Load() != 1 {
		t.Fatal("completed response replayed")
	}
}

func TestNativeWebsocketPendingTurnsRemainSerialAndBounded(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	gin.SetMode(gin.TestMode)
	for _, overflow := range []bool{false, true} {
		t.Run(fmt.Sprint(overflow), func(t *testing.T) {
			upgrader := websocket.Upgrader{}
			started, closed := make(chan struct{}, 1), make(chan struct{}, 1)
			var requests atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				defer close(closed)
				for {
					_, body, err := conn.ReadMessage()
					if err != nil {
						return
					}
					n := requests.Add(1)
					if n == 1 {
						close(started)
					}
					if overflow {
						continue
					}
					time.Sleep(20 * time.Millisecond)
					id := gjson.GetBytes(body, "input.0.content").String()
					if err = conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf(`{"type":"response.completed","response":{"id":"%s","status":"completed","output":[]}}`, id))); err != nil {
						return
					}
				}
			}))
			t.Cleanup(upstream.Close)
			conn := dialLifecycleWebsocket(t, lifecycleWebsocketServer(t, upstream.URL, 5000))
			message := func(i int) []byte {
				return []byte(fmt.Sprintf(`{"type":"response.create","model":"gpt-5.5","input":[{"role":"user","content":"turn_%d"}]}`, i))
			}
			if err := conn.WriteMessage(websocket.TextMessage, message(0)); err != nil {
				t.Fatal(err)
			}
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("first request not started")
			}
			count := 2
			if overflow {
				count = 16
			}
			for i := 1; i < count; i++ {
				if err := conn.WriteMessage(websocket.TextMessage, message(i)); err != nil {
					if !overflow {
						t.Fatal(err)
					}
					break
				}
			}
			conn.SetReadDeadline(time.Now().Add(time.Second))
			if overflow {
				_, _, err := conn.ReadMessage()
				if err == nil {
					t.Fatal("overflow accepted")
				}
				var netErr net.Error
				if errors.As(err, &netErr) && netErr.Timeout() {
					t.Fatal("queue overflow left session open")
				}
				if requests.Load() != 1 {
					t.Fatal("queued turns executed while first turn was incomplete")
				}
			} else {
				for i := 0; i < 2; i++ {
					_, body, err := conn.ReadMessage()
					if err != nil || gjson.GetBytes(body, "response.id").String() != fmt.Sprintf("turn_%d", i) {
						t.Fatalf("pending turns reordered or dropped: %s %v", body, err)
					}
				}
			}
			conn.Close()
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("pending-turn upstream leaked")
			}
		})
	}
}

func dialLifecycleWebsocket(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(url, http.Header{"Authorization": {"Bearer fixture-client"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestNativeWebsocketLifecycleOnWire(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	gin.SetMode(gin.TestMode)
	for _, phase := range []string{"cancel_handshake", "cancel_before_event", "cancel_after_delta", "timeout_handshake", "timeout_before_event", "timeout_after_delta", "close_before_event", "close_after_delta", "too_big_after_delta", "error_after_delta"} {
		t.Run(phase, func(t *testing.T) {
			started := make(chan struct{}, 4)
			closed := make(chan struct{}, 4)
			requests := make(chan []byte, 4)
			var attempts atomic.Int32
			var mu sync.Mutex
			var upstreamConnections []*websocket.Conn
			upgrader := websocket.Upgrader{}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				attempts.Add(1)
				defer func() { closed <- struct{}{} }()
				if strings.HasSuffix(phase, "handshake") {
					started <- struct{}{}
					<-r.Context().Done()
					return
				}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				mu.Lock()
				upstreamConnections = append(upstreamConnections, conn)
				mu.Unlock()
				defer conn.Close()
				_, request, err := conn.ReadMessage()
				if err != nil {
					return
				}
				requests <- request
				started <- struct{}{}
				if strings.HasSuffix(phase, "after_delta") {
					_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.output_text.delta","delta":"中文🧪"}`))
				}
				switch {
				case strings.HasPrefix(phase, "close_"):
					return // Abnormal TCP closure; no terminal event.
				case strings.HasPrefix(phase, "too_big_"):
					_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseMessageTooBig, "fixture too big"), time.Now().Add(time.Second))
					return
				case strings.HasPrefix(phase, "error_"):
					_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","status":400,"error":{"type":"invalid_request_error","code":"fixture_error","message":"fixture rejection"}}`))
				}
				_, _, _ = conn.ReadMessage() // Observe actual gateway closure, not just a context variable.
			}))
			t.Cleanup(func() {
				upstream.CloseClientConnections()
				mu.Lock()
				for _, conn := range upstreamConnections {
					conn.Close()
				}
				mu.Unlock()
				upstream.Close()
			})
			budget := 100
			if strings.HasPrefix(phase, "cancel_") {
				budget = 5000 // Prove client cancellation, not incidental timeout.
			}
			records := make(chan coreusage.Record, 4)
			conn := dialLifecycleWebsocket(t, lifecycleWebsocketServer(t, upstream.URL, budget, records))
			request := `{"type":"response.create","model":"gpt-5.5","input":[{"role":"user","content":"fixture"}],"service_tier":"auto"}`
			if err := conn.WriteMessage(websocket.TextMessage, []byte(request)); err != nil {
				t.Fatal(err)
			}
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("no upstream request")
			}
			if !strings.HasSuffix(phase, "handshake") {
				if tier := gjson.GetBytes(<-requests, "service_tier").String(); tier != "auto" {
					t.Fatalf("explicit tier replaced: %s", tier)
				}
			}
			conn.SetReadDeadline(time.Now().Add(time.Second))
			if strings.HasSuffix(phase, "after_delta") {
				_, payload, err := conn.ReadMessage()
				if err != nil || gjson.GetBytes(payload, "delta").String() != "中文🧪" {
					t.Fatalf("partial output lost: %s, %v", payload, err)
				}
			}
			if strings.HasPrefix(phase, "cancel_") {
				conn.Close()
			} else {
				failures := 0
				for {
					_, payload, err := conn.ReadMessage()
					if err != nil {
						var netErr net.Error
						if errors.As(err, &netErr) && netErr.Timeout() {
							t.Fatal("gateway left the failed turn open until the client deadline")
						}
						if strings.HasPrefix(phase, "too_big_") && !websocket.IsCloseError(err, websocket.CloseMessageTooBig) {
							t.Fatalf("1009 close code lost: %v", err)
						}
						break
					}
					kind := gjson.GetBytes(payload, "type").String()
					if kind != "error" && kind != "response.failed" {
						t.Fatalf("unexpected output after failure: %s", payload)
					}
					failures++
					if failures > 1 {
						t.Fatal("duplicate terminal failure")
					}
				}
			}
			select {
			case <-closed:
			case <-time.After(500 * time.Millisecond):
				t.Fatal("upstream request/socket remained alive after downstream termination")
			}
			select {
			case record := <-records:
				if !record.Failed || record.ResponseServiceTier != "" {
					t.Fatalf("failed request reported success/tier: %+v", record)
				}
				if !strings.HasSuffix(phase, "handshake") && (record.OutboundServiceTier == nil || *record.OutboundServiceTier != "auto") {
					t.Fatalf("failed request lost outbound tier: %+v", record)
				}
			case <-time.After(time.Second):
				t.Fatal("failed/cancelled request missing usage record")
			}
			if attempts.Load() != 1 {
				t.Fatalf("failed turn replayed %d times", attempts.Load())
			}
		})
	}
}

func TestNativeWebsocketContinuesAcrossIdleGapsAndFragmentedTurns(t *testing.T) {
	if runTierTestIsolated(t) {
		return
	}
	gin.SetMode(gin.TestMode)
	upgrader := websocket.Upgrader{WriteBufferSize: 16}
	var connections atomic.Int32
	requests := make(chan []byte, 4)
	closed := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		connections.Add(1)
		defer conn.Close()
		defer func() { closed <- struct{}{} }()
		for {
			_, request, err := conn.ReadMessage()
			if err != nil {
				return
			}
			requests <- request
			for i := 0; i < 6; i++ {
				writer, err := conn.NextWriter(websocket.TextMessage)
				if err != nil {
					return
				}
				// Fragment the message through the small WS write buffer, including UTF-8.
				for _, b := range []byte(`{"type":"response.output_text.delta","delta":"中文🧪"}`) {
					if _, err = writer.Write([]byte{b}); err != nil {
						return
					}
				}
				if err = writer.Close(); err != nil {
					return
				}
				time.Sleep(45 * time.Millisecond)
			}
			if err = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.completed","response":{"id":"resp_continued","status":"completed","service_tier":"default","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`)); err != nil {
				return
			}
		}
	}))
	t.Cleanup(upstream.Close)
	records := make(chan coreusage.Record, 8)
	conn := dialLifecycleWebsocket(t, lifecycleWebsocketServer(t, upstream.URL, 200, records))
	for i, tier := range []string{"flex", "", "default"} {
		body := fmt.Sprintf(`{"type":"response.create","model":"gpt-5.5","input":[{"role":"user","content":"turn %d"}]`, i)
		if tier != "" {
			body += `,"service_tier":"` + tier + `"`
		}
		if err := conn.WriteMessage(websocket.TextMessage, []byte(body+`}`)); err != nil {
			t.Fatal(err)
		}
		conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		var text string
		for {
			_, payload, err := conn.ReadMessage()
			if err != nil {
				t.Fatal(err)
			}
			kind := gjson.GetBytes(payload, "type").String()
			if kind == "response.completed" {
				break
			}
			if kind != "response.output_text.delta" {
				t.Fatalf("unexpected event: %s", payload)
			}
			text += gjson.GetBytes(payload, "delta").String()
		}
		if text != strings.Repeat("中文🧪", 6) {
			t.Fatalf("fragmented output changed: %q", text)
		}
		want := tier
		if want == "" {
			want = "priority"
		}
		if sent := <-requests; gjson.GetBytes(sent, "service_tier").String() != want {
			t.Fatalf("tier leaked from previous turn: %s", sent)
		}
		assertTierRecord(t, records, tier, want)
		// An inactive connection is not an in-progress model request.
		time.Sleep(300 * time.Millisecond)
	}
	conn.Close()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("completed session upstream not released")
	}
	if connections.Load() != 1 {
		t.Fatalf("healthy turns reconnected %d times", connections.Load())
	}
}
