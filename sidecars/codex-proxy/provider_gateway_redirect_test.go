package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

func TestProviderGatewayDoesNotForwardCredentialsOrPromptsOnRedirect(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, wire := range []string{"responses", "chat_completions"} {
		t.Run(wire, func(t *testing.T) {
			var redirected atomic.Int32
			destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				redirected.Add(1)
				w.WriteHeader(200)
			}))
			defer destination.Close()
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer fixture-secret" {
					t.Error("configured upstream did not receive its credential")
				}
				http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
			}))
			defer upstream.Close()
			gateway := &providerGatewaySpec{BaseURL: upstream.URL, APIKey: "fixture-secret", UpstreamModel: "gpt-5.5", UpstreamModels: []string{"gpt-5.5"}, WireAPI: wire}
			spec := apiKeySpec{ID: "fixture", Key: "fixture-local-key", Enabled: true, ProviderGateway: gateway}
			m := &manifest{APIKeys: []apiKeySpec{spec}, ModelIDs: []string{"gpt-5.5"}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: &spec}}
			router := (&relayServer{runtime: &fakeRuntime{}, cfg: &config.Config{}, manifest: m, policy: &requestPolicy{manifest: m}}).router()
			request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5.5","input":"private probe","stream":false}`))
			request.Header.Set("Authorization", "Bearer "+spec.Key)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if redirected.Load() != 0 || response.Code != 502 || response.Header().Get("Location") != "" {
				t.Fatalf("redirect followed or exposed: count=%d status=%d", redirected.Load(), response.Code)
			}
			if !strings.Contains(response.Body.String(), "upstream_redirect") {
				t.Fatal("missing explicit redirect failure")
			}
		})
	}
}
