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

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

func TestProviderGatewayImagesAdmissionErrorsKeepDistinctStatus(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		for _, multipartInput := range []bool{false, true} {
			t.Run(fmt.Sprintf("automatic=%v/multipart=%v", automatic, multipartInput), func(t *testing.T) {
				var hits atomic.Int32
				upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
				defer upstream.Close()
				gateway := imageGatewayFixture(upstream.URL)
				router, _ := imageGatewayRouter(t, apiKeySpec{ProviderGateway: gateway}, func(m *manifest, _ *config.Config, _ *fakeRuntime) {
					if automatic {
						spec := m.apiKeyByValue["fixture-image-client"]
						spec.ProviderGateway = nil
						spec.ModelRouting = &modelRoutingSpec{Automatic: true, Routes: []modelRouteSpec{{
							ProviderAccountID: "missing-account", ProviderGateway: gateway,
							Models: []modelRouteModelSpec{{ClientModel: imageFixtureModel, UpstreamModel: imageFixtureModel}},
						}}}
					} else {
						m.accountByID["image-account"].ImageGenerationPolicy = "disabled"
					}
				})
				request := imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw"}`))
				if multipartInput {
					body, contentType := imageMultipartFixture(t, imageFixtureModel)
					request = imageFixtureRequest(context.Background(), imagesEditsPath, contentType, bytes.NewReader(body))
				}
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				var payload struct {
					Error struct{ Code string } `json:"error"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
					t.Fatal(err)
				}
				wantStatus, wantCode := http.StatusForbidden, "image_account_unavailable"
				if automatic {
					wantStatus, wantCode = http.StatusNotFound, "model_route_not_available"
				}
				if response.Code != wantStatus || payload.Error.Code != wantCode || hits.Load() != 0 {
					t.Fatalf("admission error changed: status=%d code=%s hits=%d", response.Code, payload.Error.Code, hits.Load())
				}
			})
		}
	}
}

func TestProviderGatewayImagesAutomaticRoutingKeepsAccountPolicies(t *testing.T) {
	for _, policy := range []string{"disabled", "excluded", "reserve", "scope"} {
		t.Run(policy, func(t *testing.T) {
			var blockedHits, eligibleHits atomic.Int32
			blocked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				blockedHits.Add(1)
				fmt.Fprint(w, `{"data":[{"b64_json":"blocked"}]}`)
			}))
			defer blocked.Close()
			eligible := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				eligibleHits.Add(1)
				fmt.Fprint(w, `{"data":[{"b64_json":"eligible"}]}`)
			}))
			defer eligible.Close()
			router, _ := imageGatewayRouter(t, apiKeySpec{}, func(m *manifest, _ *config.Config, _ *fakeRuntime) {
				spec := m.apiKeyByValue["fixture-image-client"]
				spec.AccountIDs = []string{"blocked", "eligible"}
				spec.ModelRouting = &modelRoutingSpec{Automatic: true}
				for name, endpoint := range map[string]string{"blocked": blocked.URL, "eligible": eligible.URL} {
					gateway := imageGatewayFixture(endpoint)
					gateway.APIKey = "fixture-" + name
					m.accountByID[name] = &accountSpec{ID: name, AuthKind: "api_key", UpstreamAPIKey: gateway.APIKey}
					spec.ModelRouting.Routes = append(spec.ModelRouting.Routes, modelRouteSpec{ProviderAccountID: name, ProviderGateway: gateway, Models: []modelRouteModelSpec{{ClientModel: imageFixtureModel, UpstreamModel: imageFixtureModel}}})
				}
				switch policy {
				case "disabled":
					m.accountByID["blocked"].ImageGenerationPolicy = "disabled"
				case "excluded":
					m.AccountModelRules = []accountModelRule{{AccountID: "blocked", ExcludedModels: []string{imageFixtureModel}}}
				case "reserve":
					m.accountByID["blocked"].QuotaReserve = &quotaReserveSpec{}
				case "scope":
					spec.AccountIDs = []string{"eligible"}
				}
			})
			for i := 0; i < 3; i++ {
				response := httptest.NewRecorder()
				router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw"}`)))
				if response.Code != 200 || !strings.Contains(response.Body.String(), "eligible") {
					t.Fatalf("eligible provider not selected: %d %s", response.Code, response.Body.String())
				}
			}
			if blockedHits.Load() != 0 || eligibleHits.Load() != 3 {
				t.Fatalf("account policy bypass: blocked=%d eligible=%d", blockedHits.Load(), eligibleHits.Load())
			}
		})
	}
}

func TestProviderGatewayImagesAutomaticRoutingDoesNotReplayGeneration(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprint(w, `{"error":{"message":"fixture capacity"}}`)
	}))
	defer upstream.Close()
	router, _ := imageGatewayRouter(t, apiKeySpec{}, func(m *manifest, _ *config.Config, _ *fakeRuntime) {
		spec := m.apiKeyByValue["fixture-image-client"]
		spec.ModelRouting = &modelRoutingSpec{Automatic: true}
		for _, name := range []string{"first", "second"} {
			gateway := imageGatewayFixture(upstream.URL)
			m.accountByID[name] = &accountSpec{ID: name, AuthKind: "api_key", UpstreamAPIKey: gateway.APIKey}
			spec.ModelRouting.Routes = append(spec.ModelRouting.Routes, modelRouteSpec{ProviderAccountID: name, ProviderGateway: gateway, Models: []modelRouteModelSpec{{ClientModel: imageFixtureModel, UpstreamModel: imageFixtureModel}}})
		}
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw"}`)))
	if response.Code != http.StatusServiceUnavailable || hits.Load() != 1 {
		t.Fatalf("native image request replayed: status=%d attempts=%d", response.Code, hits.Load())
	}
}
