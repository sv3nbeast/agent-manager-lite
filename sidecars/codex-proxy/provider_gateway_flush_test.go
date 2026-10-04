package main

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

func TestProviderGatewayFlushesBeforeUpstreamCompletesAndCancels(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, wire := range []string{"responses", "chat_completions"} {
		t.Run(wire, func(t *testing.T) {
			cancelled := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"中文🧪\"}\n\n")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
				close(cancelled)
			}))
			defer upstream.Close()
			gateway := &providerGatewaySpec{BaseURL: upstream.URL, APIKey: "fixture-upstream", UpstreamModel: "fixture-model", UpstreamModels: []string{"fixture-model"}, WireAPI: wire}
			spec := apiKeySpec{ID: "fixture", Key: "fixture-client", Enabled: true, ProviderGateway: gateway}
			m := &manifest{APIKeys: []apiKeySpec{spec}, ModelIDs: []string{"fixture-model"}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: &spec}}
			server := httptest.NewServer((&relayServer{cfg: &config.Config{}, manifest: m, policy: &requestPolicy{manifest: m}}).router())
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			path, body := "/v1/responses", `{"model":"fixture-model","input":"test","stream":true}`
			if wire == "chat_completions" {
				path, body = "/v1/chat/completions", `{"model":"fixture-model","messages":[{"role":"user","content":"test"}],"stream":true}`
			}
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+path, strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+spec.Key)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			line, err := bufio.NewReader(resp.Body).ReadString('\n')
			if err != nil || !strings.Contains(line, "中文🧪") {
				t.Fatalf("first event was buffered or corrupted: %q %v", line, err)
			}
			select {
			case <-cancelled:
				t.Fatal("upstream ended before client cancellation")
			default:
			}
			cancel()
			select {
			case <-cancelled:
			case <-time.After(time.Second):
				t.Fatal("client cancellation did not close upstream")
			}
		})
	}
}
