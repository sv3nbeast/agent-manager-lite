package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

func lifecycleRouter(upstream, wire string) http.Handler {
	fast := "priority"
	gateway := &providerGatewaySpec{BaseURL: upstream, APIKey: "fixture-upstream", UpstreamModel: "fixture-model", UpstreamModels: []string{"fixture-model"}, WireAPI: wire, DefaultServiceTier: &fast}
	spec := apiKeySpec{ID: "fixture", Key: "fixture-client", Enabled: true, ProviderGateway: gateway}
	m := &manifest{APIKeys: []apiKeySpec{spec}, ModelIDs: []string{"fixture-model"}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: &spec}}
	cfg := &config.Config{}
	cfg.Streaming.StreamOpenTimeoutMS = 80
	cfg.Streaming.StreamIdleTimeoutMS = 80
	cfg.Streaming.StreamOpenMaxAttempts = 3
	return (&relayServer{cfg: cfg, manifest: m, policy: &requestPolicy{manifest: m}}).router()
}

func TestProviderGatewayTimeoutFailoverPreservesTierAndCommitBoundary(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, wire := range []string{"responses", "chat_completions"} {
		for _, phase := range []string{"before_headers", "headers_only", "after_delta", "cancel"} {
			for _, incoming := range []string{"", "auto"} {
				t.Run(wire+"/"+phase+"/"+incoming, func(t *testing.T) {
					type observation struct{ key, tier string }
					seen := make(chan observation, 8)
					cancelled := make(chan struct{}, 8)
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						var body map[string]any
						_ = json.NewDecoder(r.Body).Decode(&body)
						key := r.Header.Get("Authorization")
						seen <- observation{key, fmt.Sprint(body["service_tier"])}
						if key == "Bearer fixture-a" {
							if phase != "before_headers" {
								w.Header().Set("Content-Type", "text/event-stream")
								if phase != "headers_only" {
									_, _ = io.WriteString(w, lifecycleDelta(wire))
								}
								w.(http.Flusher).Flush()
							}
							<-r.Context().Done()
							cancelled <- struct{}{}
							return
						}
						w.Header().Set("Content-Type", "text/event-stream")
						if wire == "responses" {
							_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_backup\",\"service_tier\":\"default\",\"output\":[]}}\n\n")
						} else {
							_, _ = io.WriteString(w, "data: {\"id\":\"chat_backup\",\"service_tier\":\"default\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"backup\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
						}
					}))
					defer upstream.Close()
					payload := fmt.Sprintf(`{"modelIds":["fixture-model"],"accounts":[{"id":"a","upstreamApiKey":"fixture-a"},{"id":"b","upstreamApiKey":"fixture-b"}],"apiKeys":[{"id":"fixture","key":"fixture-client","enabled":true,"accountIds":["a","b"],"modelRouting":{"automatic":true,"defaultRoute":"oauth","failurePolicy":"strict","routes":[{"id":"a","namespace":"a","providerAccountId":"a","models":[{"clientModel":"fixture-model","upstreamModel":"fixture-model"}],"providerGateway":{"baseUrl":%q,"apiKey":"fixture-a","wireApi":%q,"upstreamModel":"fixture-model","upstreamModels":["fixture-model"],"defaultServiceTier":"priority"}},{"id":"b","namespace":"b","providerAccountId":"b","models":[{"clientModel":"fixture-model","upstreamModel":"fixture-model"}],"providerGateway":{"baseUrl":%q,"apiKey":"fixture-b","wireApi":%q,"upstreamModel":"fixture-model","upstreamModels":["fixture-model"],"defaultServiceTier":"default"}}]}}]}`, upstream.URL, wire, upstream.URL, wire)
					m := loadAutomaticRoutingManifest(t, payload)
					cfg := &config.Config{}
					cfg.Streaming.StreamOpenTimeoutMS = 80
					cfg.Streaming.StreamIdleTimeoutMS = 80
					relay := &relayServer{cfg: cfg, manifest: m, policy: &requestPolicy{manifest: m, tracker: newRequestUsageTracker()}, automaticSelector: &firstAuthSelector{}}
					server := httptest.NewServer(relay.router())
					defer server.Close()
					ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
					defer cancel()
					response, err := http.DefaultClient.Do(lifecycleRequest(ctx, server.URL, "/v1/responses", incoming))
					if err != nil {
						t.Fatal(err)
					}
					defer response.Body.Close()
					if phase == "cancel" {
						if _, err := bufio.NewReader(response.Body).ReadString('\n'); err != nil {
							t.Fatal(err)
						}
						cancel()
					} else {
						body, err := io.ReadAll(response.Body)
						if err != nil {
							t.Fatal(err)
						}
						if phase == "after_delta" {
							if strings.Count(string(body), "event: response.failed\n") != 1 || strings.Contains(string(body), "response.completed") {
								t.Fatalf("post-output failure: %s", body)
							}
						} else if !strings.Contains(string(body), "response.completed") || strings.Contains(string(body), "response.failed") {
							t.Fatalf("pre-output failover failed: %d %s", response.StatusCode, body)
						}
					}
					select {
					case <-cancelled:
					case <-time.After(time.Second):
						t.Fatal("first account HTTP exchange not cancelled")
					}
					wantCount := 2
					if phase == "after_delta" || phase == "cancel" {
						wantCount = 1
					}
					if len(seen) != wantCount {
						t.Fatalf("upstream requests=%d want=%d", len(seen), wantCount)
					}
					for i := 0; i < wantCount; i++ {
						got := <-seen
						want := "priority"
						key := "Bearer fixture-a"
						if i == 1 {
							want = "default"
							key = "Bearer fixture-b"
						}
						if incoming != "" {
							want = incoming
						}
						if got.key != key || got.tier != want {
							t.Fatalf("wire observation=%+v want key=%s tier=%s", got, key, want)
						}
					}
				})
			}
		}
	}
}

func TestProviderGatewayIdleDeadlineResetsForUnicodeChunks(t *testing.T) {
	gin.SetMode(gin.TestMode)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := lifecycleDelta("responses")
		split := strings.Index(chunk, "🧪") + 2
		for i := 0; i < 5; i++ {
			_, _ = io.WriteString(w, chunk[:split])
			w.(http.Flusher).Flush()
			time.Sleep(25 * time.Millisecond)
			_, _ = io.WriteString(w, chunk[split:])
			w.(http.Flusher).Flush()
			time.Sleep(25 * time.Millisecond)
		}
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n")
	}))
	defer upstream.Close()
	server := httptest.NewServer(lifecycleRouter(upstream.URL, "responses"))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	response, err := http.DefaultClient.Do(lifecycleRequest(ctx, server.URL, "/v1/responses", "default"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(body), "中文🧪") != 5 || strings.Contains(string(body), "response.failed") || !strings.Contains(string(body), "response.completed") {
		t.Fatalf("ongoing stream timed out or was corrupted: %s", body)
	}
}

func lifecycleRequest(ctx context.Context, url, path, tier string) *http.Request {
	body := map[string]any{"model": "fixture-model", "input": "中文 🧪", "messages": []any{map[string]any{"role": "user", "content": "中文 🧪"}}, "stream": true}
	if tier != "" {
		body["service_tier"] = tier
	}
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url+path, strings.NewReader(string(raw)))
	req.Header.Set("Authorization", "Bearer fixture-client")
	req.Header.Set("Content-Type", "application/json")
	return req
}

func lifecycleDelta(wire string) string {
	if wire == "responses" {
		return "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"中文🧪\"}\n\n"
	}
	return "data: {\"id\":\"chat_fixture\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"中文🧪\"}}]}\n\n"
}

func TestProviderGatewayStreamDeadlinesOnWire(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, flow := range []struct{ name, wire, path string }{
		{"responses", "responses", "/v1/responses"},
		{"chat_to_responses", "chat_completions", "/v1/responses"},
		{"chat_passthrough", "chat_completions", "/v1/chat/completions"},
	} {
		for _, phase := range []string{"before_headers", "headers_only", "after_delta"} {
			t.Run(flow.name+"/"+phase, func(t *testing.T) {
				var requests atomic.Int32
				cancelled := make(chan struct{}, 4)
				received := make(chan string, 4)
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests.Add(1)
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					received <- fmt.Sprint(body["service_tier"])
					if phase != "before_headers" {
						w.Header().Set("Content-Type", "text/event-stream")
						if phase == "after_delta" {
							_, _ = io.WriteString(w, lifecycleDelta(flow.wire))
						}
						w.(http.Flusher).Flush()
					}
					<-r.Context().Done()
					cancelled <- struct{}{}
				}))
				defer upstream.Close()
				server := httptest.NewServer(lifecycleRouter(upstream.URL, flow.wire))
				defer server.Close()
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				tier := ""
				if phase == "headers_only" {
					tier = "default"
				}
				if phase == "after_delta" {
					tier = "flex"
				}
				response, err := http.DefaultClient.Do(lifecycleRequest(ctx, server.URL, flow.path, tier))
				if err != nil {
					t.Fatalf("gateway did not enforce its configured timeout: %v", err)
				}
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				if err != nil {
					t.Fatalf("gateway left stream open until client timeout: %v", err)
				}
				if phase == "before_headers" {
					if response.StatusCode != 504 || !strings.Contains(string(body), "stream_open") {
						t.Fatalf("expected open timeout, got %d %s", response.StatusCode, body)
					}
				} else if phase == "headers_only" {
					if response.StatusCode != 504 || !strings.Contains(string(body), "stream_idle") || !strings.HasPrefix(response.Header.Get("Content-Type"), "application/json") {
						t.Fatalf("empty upstream must fail before downstream output: %d %s", response.StatusCode, body)
					}
				} else {
					if !strings.Contains(string(body), "stream_idle") {
						t.Fatalf("missing terminal idle timeout: %s", body)
					}
					if phase == "after_delta" && !strings.Contains(string(body), "中文🧪") {
						t.Fatalf("partial response lost: %s", body)
					}
					if flow.path == "/v1/responses" && strings.Count(string(body), "event: response.failed\n") != 1 {
						t.Fatalf("expected one failure event: %s", body)
					}
					if strings.Contains(string(body), "event: response.completed") {
						t.Fatalf("timeout claimed completion: %s", body)
					}
				}
				select {
				case <-cancelled:
				case <-time.After(time.Second):
					t.Fatal("timeout did not cancel upstream")
				}
				if requests.Load() != 1 {
					t.Fatalf("request was replayed %d times", requests.Load())
				}
				want := tier
				if want == "" {
					want = "priority"
				}
				if got := <-received; got != want {
					t.Fatalf("wire tier=%q want=%q", got, want)
				}
			})
		}
	}
}

func TestProviderGatewayResponsesTerminationOnWire(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name, suffix string
		failures     int
	}{
		{"truncated", "", 1},
		{"partial_line", "data: {\"type\":\"response.completed\"", 1},
		{"partial_frame", "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n", 1},
		{"done_without_response", "data: [DONE]\n\n", 1},
		{"completed", "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n", 0},
		{"failed", "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n", 1},
		{"incomplete", "event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\"}}\n\n", 0},
		{"multiline_completed", "event: response.completed\ndata: {\"type\":\"response.completed\",\ndata: \"response\":{\"status\":\"completed\"}}\n\n", 0},
		{"large_completed", "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":\"" + strings.Repeat("a", (4<<20)+1) + "\"}}\n\n", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, lifecycleDelta("responses")+tc.suffix)
			}))
			defer upstream.Close()
			server := httptest.NewServer(lifecycleRouter(upstream.URL, "responses"))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			response, err := http.DefaultClient.Do(lifecycleRequest(ctx, server.URL, "/v1/responses", "auto"))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if count := strings.Count(string(body), "event: response.failed\n"); count != tc.failures {
				t.Fatalf("failure count=%d want=%d body=%s", count, tc.failures, body)
			}
			for _, frame := range strings.Split(string(body), "\n\n") {
				var data []string
				for _, line := range strings.Split(frame, "\n") {
					if strings.HasPrefix(line, "data:") {
						data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
					}
				}
				payload := strings.Join(data, "\n")
				if payload != "" && payload != "[DONE]" && !json.Valid([]byte(payload)) {
					t.Fatalf("unparseable downstream event: %s", payload)
				}
			}
			if !strings.Contains(string(body), "中文🧪") || strings.Contains(string(body), "�") {
				t.Fatalf("text lost or corrupted: %s", body)
			}
			if requests.Load() != 1 {
				t.Fatal("truncated stream replayed")
			}
		})
	}
}
