package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	internallogging "github.com/router-for-me/CLIProxyAPI/v7/internal/logging"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

func TestProviderGatewayImagesConcurrencyExhaustionKeepsRetryableStatus(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		for _, multipartInput := range []bool{false, true} {
			for _, waitMs := range []int{0, 20} {
				t.Run(fmt.Sprintf("automatic=%v/multipart=%v/wait=%d", automatic, multipartInput, waitMs), func(t *testing.T) {
					gin.SetMode(gin.TestMode)
					var hits atomic.Int32
					upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
						hits.Add(1)
						fmt.Fprint(w, `{"data":[{"b64_json":"fixture"}]}`)
					}))
					defer upstream.Close()
					gateway := imageGatewayFixture(upstream.URL)
					account := &accountSpec{ID: "image-account", Email: "fixture-private@example.invalid", AuthKind: "api_key", UpstreamAPIKey: gateway.APIKey}
					spec := &apiKeySpec{ID: "image-fixture", Key: "fixture-image-client", Enabled: true, AccountIDs: []string{account.ID}, ProviderGateway: gateway}
					if automatic {
						spec.ProviderGateway = nil
						spec.ModelRouting = &modelRoutingSpec{Automatic: true, Routes: []modelRouteSpec{{
							ProviderAccountID: account.ID, ProviderGateway: gateway,
							Models: []modelRouteModelSpec{{ClientModel: imageFixtureModel, UpstreamModel: imageFixtureModel}},
						}}}
					}
					m := &manifest{
						ModelIDs: []string{imageFixtureModel}, MaxAccountConcurrency: 1, AccountConcurrencyWaitMs: waitMs,
						apiKeyByValue: map[string]*apiKeySpec{spec.Key: spec}, accountByID: map[string]*accountSpec{account.ID: account},
						accountByAPIKey: map[string]*accountSpec{gateway.APIKey: account},
					}
					tracker := newRequestUsageTracker()
					const authID = "cockpit-provider:image-account"
					if !tracker.tryReserveAccountSlot("active-chat", authID, 1) {
						t.Fatal("failed to reserve fixture conversation slot")
					}
					defer tracker.releaseAccountSlots("active-chat")
					router := (&relayServer{cfg: &config.Config{}, runtime: &fakeRuntime{}, manifest: m, policy: &requestPolicy{manifest: m, tracker: tracker}}).router()
					requestID := "native-image-exhausted"
					newRequest := func() *http.Request {
						ctx := internallogging.WithRequestID(context.Background(), requestID)
						if multipartInput {
							body, contentType := imageMultipartFixture(t, imageFixtureModel)
							return imageFixtureRequest(ctx, imagesEditsPath, contentType, bytes.NewReader(body))
						}
						return imageFixtureRequest(ctx, imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw"}`))
					}
					response := httptest.NewRecorder()
					router.ServeHTTP(response, newRequest())
					var payload struct {
						Error struct{ Code string } `json:"error"`
					}
					if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
						t.Fatal(err)
					}
					if response.Code != http.StatusTooManyRequests || payload.Error.Code != "account_concurrency_exceeded" || hits.Load() != 0 {
						t.Errorf("concurrency exhaustion was misclassified: status=%d code=%s hits=%d body=%s", response.Code, payload.Error.Code, hits.Load(), response.Body.String())
					}
					for _, credential := range []string{spec.Key, gateway.APIKey, account.Email} {
						if strings.Contains(response.Body.String(), credential) {
							t.Error("concurrency response leaked a credential")
						}
					}
					tracker.mu.Lock()
					remainingSlots, remainingJobs, waiters := len(tracker.accountSlots[requestID]), len(tracker.imageJobs[requestID]), tracker.accountWaiters
					tracker.mu.Unlock()
					if remainingSlots != 0 || remainingJobs != 0 || waiters != 0 || tracker.imageInFlightCount(authID) != 0 || tracker.accountInFlightCount(authID) != 1 {
						t.Fatal("concurrency rejection leaked a reservation or released the active conversation")
					}
					tracker.releaseAccountSlots("active-chat")
					retried := httptest.NewRecorder()
					router.ServeHTTP(retried, newRequest())
					if retried.Code != http.StatusOK || hits.Load() != 1 {
						t.Fatalf("request did not recover after the active conversation finished: status=%d hits=%d", retried.Code, hits.Load())
					}
				})
			}
		}
	}
}

func TestProviderGatewayImagesConcurrentWaitKeepsAccountAdmission(t *testing.T) {
	for _, policy := range []string{"disabled", "scope", "reserve", "excluded", "target"} {
		for _, cancelWaiting := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/cancel=%v", policy, cancelWaiting), func(t *testing.T) {
				gin.SetMode(gin.TestMode)
				var blockedHits, firstHits, secondHits atomic.Int32
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch {
					case strings.HasPrefix(r.URL.Path, "/blocked/"):
						blockedHits.Add(1)
					case strings.HasPrefix(r.URL.Path, "/eligible-first/"):
						firstHits.Add(1)
					case strings.HasPrefix(r.URL.Path, "/eligible-second/"):
						secondHits.Add(1)
					default:
						t.Errorf("unexpected provider endpoint: %s", r.URL.Path)
					}
					fmt.Fprint(w, `{"data":[{"b64_json":"fixture"}]}`)
				}))
				defer upstream.Close()

				spec := &apiKeySpec{
					ID: "image-fixture", Key: "fixture-image-client", Enabled: true,
					AccountIDs:   []string{"blocked", "eligible-first", "eligible-second"},
					ModelRouting: &modelRoutingSpec{Automatic: true},
				}
				m := &manifest{
					ModelIDs:              []string{imageFixtureModel},
					MaxAccountConcurrency: 1, AccountConcurrencyWaitMs: 2000,
					apiKeyByValue: map[string]*apiKeySpec{spec.Key: spec},
					accountByID:   make(map[string]*accountSpec),
				}
				for _, id := range []string{"blocked", "eligible-first", "eligible-second"} {
					gateway := imageGatewayFixture(upstream.URL + "/" + id)
					gateway.APIKey = "fixture-" + id
					m.accountByID[id] = &accountSpec{ID: id, AuthKind: "api_key", UpstreamAPIKey: gateway.APIKey}
					spec.ModelRouting.Routes = append(spec.ModelRouting.Routes, modelRouteSpec{
						ProviderAccountID: id, ProviderGateway: gateway,
						Models: []modelRouteModelSpec{{ClientModel: imageFixtureModel, UpstreamModel: imageFixtureModel}},
					})
				}
				switch policy {
				case "disabled":
					m.accountByID["blocked"].ImageGenerationPolicy = "disabled"
				case "scope":
					spec.AccountIDs = []string{"eligible-first", "eligible-second"}
				case "reserve":
					m.accountByID["blocked"].QuotaReserve = &quotaReserveSpec{}
				case "excluded":
					m.AccountModelRules = []accountModelRule{{AccountID: "blocked", ExcludedModels: []string{imageFixtureModel}}}
				case "target":
					spec.Internal = true
				}

				tracker := newRequestUsageTracker()
				for _, id := range []string{"eligible-first", "eligible-second"} {
					// Ordinary conversation traffic holds all eligible account slots,
					// while the forbidden image account still has a free slot.
					if !tracker.tryReserveAccountSlot("chat-"+id, "cockpit-provider:"+id, 1) {
						t.Fatal("failed to reserve fixture conversation slot")
					}
					defer tracker.releaseAccountSlots("chat-" + id)
				}
				relay := &relayServer{
					cfg: &config.Config{}, runtime: &fakeRuntime{}, manifest: m,
					policy: &requestPolicy{manifest: m, tracker: tracker},
				}
				router := relay.router()
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				requestID := "native-image-wait-" + policy
				ctx = internallogging.WithRequestID(ctx, requestID)
				request := imageFixtureRequest(ctx, imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw"}`))
				if policy == "target" {
					request.Header.Set(targetAccountIDHeaderName, "eligible-second")
				}
				done := make(chan *httptest.ResponseRecorder, 1)
				go func() {
					response := httptest.NewRecorder()
					router.ServeHTTP(response, request)
					done <- response
				}()

				waitForProviderImageAccountWait(t, tracker, done)
				if blockedHits.Load() != 0 || firstHits.Load() != 0 || secondHits.Load() != 0 {
					t.Fatal("image request reached an upstream while every eligible account was full")
				}
				if cancelWaiting {
					cancel()
				} else {
					tracker.releaseAccountSlots("chat-eligible-second")
				}
				var response *httptest.ResponseRecorder
				select {
				case response = <-done:
				case <-time.After(2 * time.Second):
					t.Fatal("image request did not finish after slot release or cancellation")
				}
				if cancelWaiting {
					if response.Code < 400 || secondHits.Load() != 0 {
						t.Fatalf("cancelled request was forwarded: status=%d hits=%d", response.Code, secondHits.Load())
					}
				} else if response.Code != http.StatusOK || secondHits.Load() != 1 {
					t.Fatalf("released eligible account was not used: status=%d hits=%d", response.Code, secondHits.Load())
				}
				if blockedHits.Load() != 0 || firstHits.Load() != 0 {
					t.Fatalf("wait bypassed account admission: blocked=%d still-full=%d", blockedHits.Load(), firstHits.Load())
				}
				for _, id := range []string{"blocked", "eligible-first", "eligible-second"} {
					if jobs := tracker.imageInFlightCount("cockpit-provider:" + id); jobs != 0 {
						t.Errorf("image reservation leaked for %s: %d", id, jobs)
					}
				}
				tracker.mu.Lock()
				remainingSlots, remainingJobs, waiters := len(tracker.accountSlots[requestID]), len(tracker.imageJobs[requestID]), tracker.accountWaiters
				tracker.mu.Unlock()
				if remainingSlots != 0 || remainingJobs != 0 || waiters != 0 {
					t.Fatalf("request resources leaked: account slots=%d image jobs=%d waiters=%d", remainingSlots, remainingJobs, waiters)
				}
				if got := tracker.accountInFlightCount("cockpit-provider:eligible-first"); got != 1 {
					t.Fatalf("another conversation's slot was modified: %d", got)
				}
			})
		}
	}
}

func waitForProviderImageAccountWait(t *testing.T, tracker *requestUsageTracker, done <-chan *httptest.ResponseRecorder) {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		tracker.mu.Lock()
		waiting := tracker.accountWaiters > 0
		tracker.mu.Unlock()
		if waiting {
			return
		}
		select {
		case response := <-done:
			t.Fatalf("request bypassed account wait: status=%d body=%s", response.Code, response.Body.String())
		case <-deadline.C:
			t.Fatal("request did not enter account concurrency wait")
		case <-tick.C:
		}
	}
}
