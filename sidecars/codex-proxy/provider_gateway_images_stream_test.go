package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-contrib/sse"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

type imageChunkReader struct {
	reader io.Reader
	limit  int
}

func (r imageChunkReader) Read(p []byte) (int, error) {
	if len(p) > r.limit {
		p = p[:r.limit]
	}
	return r.reader.Read(p)
}

func TestProviderImageStreamUsageSurvivesLargeImageAndChunkBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name        string
		imageLength int
		chunkSize   int
		headerOnly  bool
	}{
		{"large final event", (4 << 20) + 1, 32768, false},
		{"split escaped strings", 4096, 1, false},
		{"event header completion", 4096, 7, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Embedded fake metadata inside the image string must not become JSON
			// fields when the observer shortens it, even across escaped quotes.
			encoded, _ := json.Marshal(strings.Repeat("A", tc.imageLength) + `\"type":"error","usage":{"total_tokens":99999}\`)
			typeField := `"type":"image_generation.completed",`
			if tc.headerOnly {
				typeField = ""
			}
			stream := "event: image_generation.completed\r\ndata: {" + typeField + `"b64_json":` + string(encoded) + `,"usage":{"input_tokens":3,"output_tokens":7,"total_tokens":10}}` + "\r\n\r\n"
			usage := &providerUsageObserver{wireAPI: "images"}
			reader := &providerImageMetadataReader{body: imageChunkReader{reader: strings.NewReader(stream), limit: tc.chunkSize}, observer: usage}
			actual, err := io.ReadAll(reader)
			if err != nil || string(actual) != stream {
				t.Fatalf("native stream bytes changed: length=%d error=%v", len(actual), err)
			}
			if !usage.doneSeen || usage.failed || usage.detail.InputTokens != 3 || usage.detail.OutputTokens != 7 || usage.detail.TotalTokens != 10 {
				t.Fatalf("terminal or usage lost: done=%v failed=%v detail=%+v", usage.doneSeen, usage.failed, usage.detail)
			}
			if len(reader.value) > 2048 || cap(reader.value) > 4096 {
				t.Fatalf("observer retained image payload: length=%d capacity=%d", len(reader.value), cap(reader.value))
			}
		})
	}
}

func TestProviderImageStreamDoesNotHideMalformedImageStrings(t *testing.T) {
	for _, tc := range []struct {
		name, suffix string
		valid        bool
	}{
		{"valid JSON escapes", `\/\\\"\b\f\n\r\t\u1234`, true},
		{"invalid escape", `\q`, false},
		{"invalid unicode escape", `\u12XZ`, false},
		{"short unicode escape", `\u12`, false},
		{"literal control character", "\t", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := "event: image_generation.completed\ndata: {\"type\":\"image_generation.completed\",\"b64_json\":\"" + strings.Repeat("A", 3000) + tc.suffix + "\"}\n\n"
			usage := &providerUsageObserver{wireAPI: "images"}
			reader := &providerImageMetadataReader{body: imageChunkReader{reader: strings.NewReader(stream), limit: 1}, observer: usage}
			actual, err := io.ReadAll(reader)
			if err != nil || string(actual) != stream {
				t.Fatalf("native stream bytes changed: length=%d error=%v", len(actual), err)
			}
			if (usage.doneSeen && !usage.failed) != tc.valid {
				t.Fatalf("shortening the image string changed validity: complete=%v failed=%v", usage.doneSeen, usage.failed)
			}
		})
	}
}

func TestProviderImageStreamRecognizesSSELineEndings(t *testing.T) {
	for _, tc := range []struct {
		name, ending string
	}{
		{"LF", "\n"},
		{"CR only", "\r"},
		{"CRLF split across reads", "\r\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := strings.Join([]string{
				"event: image_generation.completed",
				`data: {"b64_json":"cG5n",`,
				`data: "usage":{"input_tokens":3,"output_tokens":7,"total_tokens":10}}`,
				"", "",
			}, tc.ending)
			usage := &providerUsageObserver{wireAPI: "images"}
			reader := &providerImageMetadataReader{body: imageChunkReader{reader: strings.NewReader(stream), limit: 1}, observer: usage}
			actual, err := io.ReadAll(reader)
			if err != nil || string(actual) != stream {
				t.Fatalf("native SSE line endings changed: length=%d error=%v", len(actual), err)
			}
			if !usage.doneSeen || usage.failed || usage.detail.TotalTokens != 10 {
				t.Fatalf("SSE completion or usage lost: complete=%v failed=%v tokens=%d", usage.doneSeen, usage.failed, usage.detail.TotalTokens)
			}
		})
	}
}

func TestProviderGatewayImageStreamRequiresNativeCompletion(t *testing.T) {
	for _, tc := range []struct {
		name, stream string
		wantError    bool
	}{
		{"partial only", "event: image_generation.partial_image\ndata: {\"type\":\"image_generation.partial_image\",\"b64_json\":\"cG5n\"}\n\n", true},
		{"generic done is insufficient", "data: [DONE]\n\n", true},
		{"native error preserved", "event: error\ndata: {\"message\":\"fixture native image failure\"}\n\n", false},
		{"completed", "event: image_edit.completed\ndata: {\"type\":\"image_edit.completed\",\"b64_json\":\"cG5n\"}\n\n", false},
		{"completed carriage returns", "event: image_edit.completed\rdata: {\"type\":\"image_edit.completed\",\"b64_json\":\"cG5n\"}\r\r", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, tc.stream)
			}))
			defer upstream.Close()
			router, _ := imageGatewayRouter(t, apiKeySpec{ProviderGateway: imageGatewayFixture(upstream.URL)}, nil)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw","stream":true}`)))
			if !strings.HasPrefix(response.Body.String(), tc.stream) {
				t.Fatal("native upstream events were not preserved")
			}
			if tc.wantError {
				if !strings.Contains(response.Body.String()[len(tc.stream):], "provider image stream disconnected") {
					t.Fatalf("incomplete image stream silently succeeded: %s", response.Body.String())
				}
			} else if response.Body.String() != tc.stream {
				t.Fatalf("native terminal event was changed: %s", response.Body.String())
			}
			usage := &providerUsageObserver{wireAPI: "images"}
			_, _ = io.Copy(io.Discard, &providerImageMetadataReader{body: strings.NewReader(tc.stream), observer: usage})
			if tc.wantError && usage.doneSeen {
				t.Error("incomplete image stream marked complete")
			}
		})
	}
}

func TestProviderGatewayImageStreamTruncationLeavesReadableErrorEvent(t *testing.T) {
	for _, tc := range []struct {
		name, stream string
	}{
		{"mid data line", "event: image_generation.partial_image\ndata: {\"type\":\"image_generation.partial_image\",\"b64_json\":\"AAAA"},
		{"single newline", "event: image_generation.partial_image\ndata: {\"type\":\"image_generation.partial_image\",\"b64_json\":\"AAAA\"}\n"},
		{"undelimited completion", "event: image_generation.completed\ndata: {\"type\":\"image_generation.completed\",\"b64_json\":\"AAAA\"}\n"},
		{"undelimited CR completion", "event: image_generation.completed\rdata: {\"type\":\"image_generation.completed\",\"b64_json\":\"AAAA\"}\r"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				w.Header().Set("Content-Length", fmt.Sprint(len(tc.stream)+10))
				fmt.Fprint(w, tc.stream)
			}))
			defer upstream.Close()
			gateway := imageGatewayFixture(upstream.URL)
			spec := &apiKeySpec{ID: "image-fixture", Key: "fixture-image-client", Enabled: true, ProviderGateway: gateway, AccountIDs: []string{"image-account"}}
			account := &accountSpec{ID: "image-account", AuthKind: "api_key", UpstreamAPIKey: gateway.APIKey}
			m := &manifest{ModelIDs: []string{imageFixtureModel}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: spec}, accountByID: map[string]*accountSpec{account.ID: account}}
			tracker := newRequestUsageTracker()
			router := (&relayServer{manifest: m, cfg: &config.Config{}, policy: &requestPolicy{manifest: m, tracker: tracker}}).router()
			response := httptest.NewRecorder()
			router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw","stream":true}`)))
			if !strings.HasPrefix(response.Body.String(), tc.stream) {
				t.Fatal("native upstream bytes changed before the disconnect")
			}
			// Decode the SSE envelope as a client does. A substring assertion
			// misses an error whose fields were appended to an unfinished event.
			// The test decoder handles LF; normalize the three SSE line-ending
			// forms before feeding it the byte-preserved response.
			normalized := strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(response.Body.String())
			events, err := sse.Decode(strings.NewReader(normalized))
			if err != nil || len(events) == 0 {
				t.Fatalf("image error stream could not be decoded: events=%d err=%v", len(events), err)
			}
			last := events[len(events)-1]
			var payload struct {
				Error struct {
					Message string `json:"message"`
				} `json:"error"`
			}
			if last.Event != "error" || json.Unmarshal([]byte(last.Data.(string)), &payload) != nil || payload.Error.Message != "provider image stream disconnected" {
				t.Fatalf("client did not receive an independent JSON error event: %+v", events)
			}
			for _, event := range events {
				if event.Event == "image_generation.completed" || event.Event == "image_edit.completed" {
					t.Fatalf("incomplete upstream event became a successful completion: %+v", event)
				}
				// Some SDKs dispatch by payload.type instead of the SSE event name.
				var data struct {
					Type string `json:"type"`
				}
				if json.Unmarshal([]byte(event.Data.(string)), &data) == nil && (data.Type == "image_generation.completed" || data.Type == "image_edit.completed") {
					t.Fatalf("incomplete upstream JSON became a successful completion: %+v", event)
				}
			}
			tracker.mu.Lock()
			defer tracker.mu.Unlock()
			count := 0
			for _, records := range tracker.records {
				for _, record := range records {
					count++
					if record.Success {
						t.Error("truncated image response was recorded as successful")
					}
				}
			}
			if count != 1 || len(tracker.imageJobs) != 0 {
				t.Fatalf("image request record or reservations leaked: records=%d jobs=%v", count, tracker.imageJobs)
			}
		})
	}
}

func TestProviderGatewayImageStreamDeadlinesCancelUpstream(t *testing.T) {
	for _, idle := range []bool{false, true} {
		t.Run(fmt.Sprint(idle), func(t *testing.T) {
			cancelled := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				if idle {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "event: image_generation.partial_image\ndata: {\"type\":\"image_generation.partial_image\"}\n\n")
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
				close(cancelled)
			}))
			defer upstream.Close()
			router, _ := imageGatewayRouter(t, apiKeySpec{ProviderGateway: imageGatewayFixture(upstream.URL)}, func(_ *manifest, cfg *config.Config, _ *fakeRuntime) {
				cfg.Streaming.ImageStreamOpenTimeoutMS = 25
				cfg.Streaming.ImageStreamIdleTimeoutMS = 25
			})
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			response := httptest.NewRecorder()
			router.ServeHTTP(response, imageFixtureRequest(ctx, imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw","stream":true}`)))
			select {
			case <-cancelled:
			case <-time.After(time.Second):
				t.Fatal("image deadline did not cancel upstream")
			}
			if (!idle && response.Code != 504) || (idle && !bytes.Contains(response.Body.Bytes(), []byte("provider image stream disconnected"))) {
				t.Fatalf("deadline was not reported: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestProviderGatewayImageUsageDoesNotReportTruncatedCompletionAsSuccess(t *testing.T) {
	for _, truncated := range []bool{false, true} {
		t.Run(fmt.Sprint(truncated), func(t *testing.T) {
			stream := "event: image_generation.completed\ndata: {\"type\":\"image_generation.completed\",\"b64_json\":\"cG5n\",\"usage\":{\"input_tokens\":3,\"output_tokens\":7,\"total_tokens\":10}}\n\n"
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				if truncated {
					w.Header().Set("Content-Length", fmt.Sprint(len(stream)+10))
				}
				fmt.Fprint(w, stream)
			}))
			defer upstream.Close()
			gateway := imageGatewayFixture(upstream.URL)
			spec := &apiKeySpec{ID: "image-fixture", Key: "fixture-image-client", Enabled: true, ProviderGateway: gateway, AccountIDs: []string{"image-account"}}
			account := &accountSpec{ID: "image-account", AuthKind: "api_key", UpstreamAPIKey: gateway.APIKey}
			m := &manifest{ModelIDs: []string{imageFixtureModel}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: spec}, accountByID: map[string]*accountSpec{account.ID: account}}
			tracker := newRequestUsageTracker()
			router := (&relayServer{manifest: m, cfg: &config.Config{}, policy: &requestPolicy{manifest: m, tracker: tracker}}).router()
			response := httptest.NewRecorder()
			router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw","stream":true}`)))
			tracker.mu.Lock()
			defer tracker.mu.Unlock()
			count := 0
			for _, records := range tracker.records {
				for _, record := range records {
					count++
					if record.Success == truncated || record.Usage.TotalTokens != 10 || record.AccountID != "image-account" {
						t.Errorf("wrong native image usage: success=%v tokens=%d account=%s", record.Success, record.Usage.TotalTokens, record.AccountID)
					}
				}
			}
			if count != 1 || len(tracker.imageJobs) != 0 {
				t.Fatalf("image request record or reservations leaked: records=%d jobs=%v", count, tracker.imageJobs)
			}
		})
	}
}

func TestProviderGatewayImageStreamRejectsUnfinishedDataAfterCompletion(t *testing.T) {
	completed := "event: image_generation.completed\ndata: {\"type\":\"image_generation.completed\",\"output_index\":0,\"b64_json\":\"cG5n\",\"usage\":{\"input_tokens\":3,\"output_tokens\":7,\"total_tokens\":10}}\n\n"
	for _, tc := range []struct {
		name, tail string
		wantError  bool
	}{
		{"next image mid data", "event: image_generation.partial_image\ndata: {\"type\":\"image_generation.partial_image\",\"output_index\":1,\"b64_json\":\"AAAA", true},
		{"next completion missing delimiter", "event: image_generation.completed\ndata: {\"type\":\"image_generation.completed\",\"output_index\":1,\"b64_json\":\"AAAA\"}\n", true},
		{"next CR completion missing delimiter", "event: image_generation.completed\rdata: {\"type\":\"image_generation.completed\",\"output_index\":1,\"b64_json\":\"AAAA\"}\r", true},
		{"complete second image", "event: image_generation.completed\ndata: {\"type\":\"image_generation.completed\",\"output_index\":1,\"b64_json\":\"AAAA\"}\n\n", false},
		{"trailing comment", ": keepalive data: still a comment", false},
		{"trailing comment line", ": keepalive\n", false},
		{"empty keepalive event", "event: ping\n\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := completed + tc.tail
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				// Clean HTTP EOF after the first result is not proof that the
				// provider delivered the whole next SSE data frame.
				fmt.Fprint(w, stream)
			}))
			defer upstream.Close()
			gateway := imageGatewayFixture(upstream.URL)
			spec := &apiKeySpec{ID: "image-fixture", Key: "fixture-image-client", Enabled: true, ProviderGateway: gateway, AccountIDs: []string{"image-account"}}
			account := &accountSpec{ID: "image-account", AuthKind: "api_key", UpstreamAPIKey: gateway.APIKey}
			m := &manifest{ModelIDs: []string{imageFixtureModel}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: spec}, accountByID: map[string]*accountSpec{account.ID: account}}
			tracker := newRequestUsageTracker()
			router := (&relayServer{manifest: m, cfg: &config.Config{}, policy: &requestPolicy{manifest: m, tracker: tracker}}).router()
			response := httptest.NewRecorder()
			router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw","n":2,"stream":true}`)))
			if !strings.HasPrefix(response.Body.String(), stream) {
				t.Fatal("native upstream bytes changed before EOF")
			}
			if tc.wantError {
				normalized := strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(response.Body.String())
				events, err := sse.Decode(strings.NewReader(normalized))
				if err != nil || len(events) == 0 {
					t.Fatalf("invalid image error stream: events=%d err=%v", len(events), err)
				}
				last := events[len(events)-1]
				var payload struct {
					Error struct {
						Message string `json:"message"`
					} `json:"error"`
				}
				if last.Event != "error" || json.Unmarshal([]byte(last.Data.(string)), &payload) != nil || payload.Error.Message != "provider image stream disconnected" {
					t.Error("clean EOF hid an unfinished image data frame")
				}
			} else if response.Body.String() != stream {
				t.Error("trailing comment, keepalive or complete image caused a false error")
			}
			tracker.mu.Lock()
			defer tracker.mu.Unlock()
			count := 0
			for _, records := range tracker.records {
				for _, record := range records {
					count++
					if record.Success == tc.wantError || record.Usage.TotalTokens != 10 {
						t.Errorf("incorrect completion usage: success=%v tokens=%d", record.Success, record.Usage.TotalTokens)
					}
				}
			}
			if count != 1 || len(tracker.imageJobs) != 0 {
				t.Fatalf("image request record or reservations leaked: records=%d jobs=%v", count, tracker.imageJobs)
			}
		})
	}
}

func TestProviderGatewayImagesRejectInvalidSuccessfulJSONAndPreserveErrors(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		wantStatus int
		wantOK     bool
	}{
		{"unknown fields without usage", `{"data":[{"b64_json":"cG5n"}],"provider_detail":{"opaque":[1,true]}}`, 200, 200, true},
		{"invalid JSON", `{"data":[`, 200, 502, false},
		{"HTML success", `<html>provider failure</html>`, 200, 502, false},
		{"null success", `null`, 200, 502, false},
		{"array success", `[]`, 200, 502, false},
		{"upstream HTML error", `<html>rate limited</html>`, 429, 429, false},
		{"upstream malformed error", `{"error":`, 500, 500, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer upstream.Close()
			gateway := imageGatewayFixture(upstream.URL)
			spec := &apiKeySpec{ID: "image-fixture", Key: "fixture-image-client", Enabled: true, ProviderGateway: gateway, AccountIDs: []string{"image-account"}}
			account := &accountSpec{ID: "image-account", AuthKind: "api_key", UpstreamAPIKey: gateway.APIKey}
			m := &manifest{ModelIDs: []string{imageFixtureModel}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: spec}, accountByID: map[string]*accountSpec{account.ID: account}}
			tracker := newRequestUsageTracker()
			router := (&relayServer{manifest: m, cfg: &config.Config{}, policy: &requestPolicy{manifest: m, tracker: tracker}}).router()
			response := httptest.NewRecorder()
			router.ServeHTTP(response, imageFixtureRequest(context.Background(), imagesGenerationsPath, "application/json", strings.NewReader(`{"model":"fixture-image-model","prompt":"draw"}`)))
			if response.Code != tc.wantStatus {
				t.Errorf("invalid Images response status: got=%d want=%d body=%s", response.Code, tc.wantStatus, response.Body.String())
			}
			if tc.status == tc.wantStatus && response.Body.String() != tc.body {
				t.Error("valid response or upstream error body was not preserved")
			}
			tracker.mu.Lock()
			defer tracker.mu.Unlock()
			count := 0
			for _, records := range tracker.records {
				for _, record := range records {
					count++
					if record.Success != tc.wantOK || record.Status != tc.wantStatus {
						t.Errorf("invalid Images usage result: status=%d success=%v", record.Status, record.Success)
					}
				}
			}
			if count != 1 || len(tracker.imageJobs) != 0 {
				t.Fatalf("image request record or reservations leaked: records=%d jobs=%v", count, tracker.imageJobs)
			}
		})
	}
}
