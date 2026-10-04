package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

func proxyProviderRouter(t *testing.T, base, proxy string) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	gateway := &providerGatewaySpec{BaseURL: base, ProxyURL: proxy, APIKey: "fixture-provider-key", UpstreamModel: "fixture-model", UpstreamModels: []string{"fixture-model"}, WireAPI: "responses"}
	spec := apiKeySpec{ID: "fixture", Key: "fixture-client", Enabled: true, ProviderGateway: gateway}
	m := &manifest{APIKeys: []apiKeySpec{spec}, ModelIDs: []string{"fixture-model"}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: &spec}}
	server := httptest.NewServer((&relayServer{cfg: &config.Config{}, manifest: m, policy: &requestPolicy{manifest: m}}).router())
	t.Cleanup(server.Close)
	return server
}

func TestProviderGatewayAuthenticatedProxyPreservesFast(t *testing.T) {
	var hits atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Host != "provider.invalid" || r.URL.Path != "/v1/responses" {
			t.Errorf("proxy target=%s", r.URL)
		}
		if r.Header.Get("Proxy-Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("fixture-proxy:fixture-pass")) {
			t.Error("missing proxy authentication")
		}
		if r.Header.Get("Authorization") != "Bearer fixture-provider-key" {
			t.Error("upstream auth changed")
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil || body["service_tier"] != "priority" {
			t.Errorf("Fast changed: %v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"resp_fixture","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"代理成功"}]}],"service_tier":"priority","usage":{"input_tokens":2,"output_tokens":2}}`)
	}))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	proxyURL.User = url.UserPassword("fixture-proxy", "fixture-pass")
	server := proxyProviderRouter(t, "http://provider.invalid/v1", proxyURL.String())
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/responses", strings.NewReader(`{"model":"fixture-model","input":"hi","service_tier":"priority"}`))
	request.Header.Set("Authorization", "Bearer fixture-client")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 || hits.Load() != 1 || !strings.Contains(string(body), "代理成功") {
		t.Fatalf("status=%d hits=%d body=%s", response.StatusCode, hits.Load(), body)
	}
}

func TestProviderGatewayProxyStreamsCompleteAndCancel(t *testing.T) {
	for _, cancelEarly := range []bool{false, true} {
		t.Run(fmt.Sprint(cancelEarly), func(t *testing.T) {
			cancelled := make(chan struct{})
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"代理🧪\"}\n\n")
				w.(http.Flusher).Flush()
				if cancelEarly {
					<-r.Context().Done()
					close(cancelled)
					return
				}
				fmt.Fprint(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_proxy\",\"status\":\"completed\",\"output\":[]}}\n\n")
			}))
			defer proxy.Close()
			server := proxyProviderRouter(t, "http://provider.invalid/v1", proxy.URL)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			response, err := http.DefaultClient.Do(lifecycleRequest(ctx, server.URL, "/v1/responses", "priority"))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			reader := bufio.NewReader(response.Body)
			seen := ""
			for !strings.Contains(seen, "代理🧪") {
				line, err := reader.ReadString('\n')
				if err != nil {
					t.Fatalf("first delta failed: %q %v", seen, err)
				}
				seen += line
			}
			if cancelEarly {
				cancel()
				select {
				case <-cancelled:
				case <-time.After(time.Second):
					t.Fatal("cancel did not close proxied upstream")
				}
			} else {
				rest, err := io.ReadAll(reader)
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(string(rest), "response.completed") {
					t.Fatalf("missing final event: %s", rest)
				}
			}
		})
	}
}

func TestProviderGatewayProxyFailureNeverFallsBackAndDirectBypassesDefaultTransport(t *testing.T) {
	var upstreamHits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits.Add(1)
		fmt.Fprint(w, `{"id":"resp_direct","status":"completed","output":[]}`)
	}))
	defer upstream.Close()
	for _, proxy := range []string{"http://127.0.0.1:1", "broken://fixture-secret"} {
		server := proxyProviderRouter(t, upstream.URL, proxy)
		response, err := http.DefaultClient.Do(lifecycleRequest(context.Background(), server.URL, "/v1/responses", "default"))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode < 400 || upstreamHits.Load() != 0 || strings.Contains(string(body), "fixture-secret") {
			t.Fatalf("failed proxy escaped: status=%d hits=%d body=%s", response.StatusCode, upstreamHits.Load(), body)
		}
	}
	original := http.DefaultClient.Transport
	http.DefaultClient.Transport = proxyRejectTransport{}
	defer func() { http.DefaultClient.Transport = original }()
	server := proxyProviderRouter(t, upstream.URL, "direct")
	local := &http.Client{Transport: &http.Transport{Proxy: nil}}
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/responses", strings.NewReader(`{"model":"fixture-model","input":"direct"}`))
	request.Header.Set("Authorization", "Bearer fixture-client")
	response, err := local.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 || upstreamHits.Load() != 1 {
		t.Fatalf("explicit direct inherited default proxy: status=%d hits=%d", response.StatusCode, upstreamHits.Load())
	}
}

type proxyRejectTransport struct{}

func (proxyRejectTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, fmt.Errorf("fixture inherited transport must not be used")
}
