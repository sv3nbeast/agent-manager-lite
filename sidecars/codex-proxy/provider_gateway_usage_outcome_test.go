package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	internallogging "github.com/router-for-me/CLIProxyAPI/v7/internal/logging"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

const historyCompletedFrame = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_fixture\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":10,\"output_tokens\":3,\"total_tokens\":13}}}\n\n"

// Exercise the real HTTP handler and connection cancellation, not just a
// predicate. The client consumes the completed event and then closes the stream
// while upstream is still open, as clients are permitted to do.
func TestProviderUsageCompletedClientDisconnect(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, complete := range []bool{true, false} {
		t.Run(map[bool]string{true: "after_completion", false: "before_completion"}[complete], func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				frame := "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"
				if complete {
					frame = historyCompletedFrame
				}
				io.WriteString(w, frame)
				w.(http.Flusher).Flush()
				select {
				case <-r.Context().Done():
				case <-time.After(5 * time.Second):
				}
			}))
			defer upstream.Close()
			gateway := &providerGatewaySpec{BaseURL: upstream.URL, APIKey: "fixture-upstream", WireAPI: "responses", UpstreamModels: []string{"fixture-model"}}
			spec := apiKeySpec{ID: "fixture-key", Key: "fixture-client", Enabled: true, ProviderGateway: gateway}
			m := &manifest{APIKeys: []apiKeySpec{spec}, ModelIDs: []string{"fixture-model"}, apiKeyByValue: map[string]*apiKeySpec{spec.Key: &spec}}
			tracker := newRequestUsageTracker()
			router := (&relayServer{cfg: &config.Config{}, manifest: m, policy: &requestPolicy{manifest: m, tracker: tracker}}).router()
			done := make(chan struct{})
			relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { router.ServeHTTP(w, r); close(done) }))
			defer relay.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, "POST", relay.URL+"/v1/responses", strings.NewReader(`{"model":"fixture-model","input":"local fixture","stream":true}`))
			req.Header.Set("Authorization", "Bearer "+spec.Key)
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			scanner := bufio.NewReader(res.Body)
			var received strings.Builder
			for {
				line, err := scanner.ReadString('\n')
				if err != nil {
					t.Fatal(err)
				}
				received.WriteString(line)
				if line == "\n" {
					break
				}
			}
			if complete && !strings.Contains(received.String(), `"type":"response.completed"`) {
				t.Fatal("client did not receive completion")
			}
			res.Body.Close()
			cancel()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("relay did not settle")
			}
			tracker.mu.Lock()
			defer tracker.mu.Unlock()
			var records []usagePayload
			for _, rs := range tracker.records {
				records = append(records, rs...)
			}
			if len(records) != 1 {
				t.Fatalf("expected one usage, got %d", len(records))
			}
			usage := records[0]
			if usage.Success != complete {
				t.Fatalf("completed=%v success=%v category=%s", complete, usage.Success, usage.ErrorCategory)
			}
			if complete && (usage.Status != 200 || usage.Usage.InputTokens != 10 || usage.Usage.OutputTokens != 3 || usage.ErrorCategory != "") {
				t.Fatalf("completion usage lost: %+v", usage)
			}
			if !complete && usage.ErrorCategory != "client_canceled" {
				t.Fatalf("wrong cancellation category: %s", usage.ErrorCategory)
			}
		})
	}
}

type historyFaultWriter struct {
	gin.ResponseWriter
	fail   bool
	short  bool
	cancel context.CancelFunc
}

func (w *historyFaultWriter) Write(p []byte) (int, error) {
	if w.fail {
		if w.short {
			return len(p) - 1, nil
		}
		return 0, errors.New("synthetic downstream failure")
	}
	return w.ResponseWriter.Write(p)
}
func (w *historyFaultWriter) Flush() {
	w.ResponseWriter.Flush()
	if w.cancel != nil {
		w.cancel()
	}
}

type historyReadError struct{ io.Reader }

func (r historyReadError) Read(p []byte) (int, error) {
	n, e := r.Reader.Read(p)
	if e == io.EOF {
		return n, io.ErrUnexpectedEOF
	}
	return n, e
}

func TestProviderUsageStreamCompletionEvidence(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name, frame, category                               string
		writeFail, shortWrite, cancel, readFailure, success bool
	}{
		{name: "completed", frame: historyCompletedFrame, success: true},
		{name: "done_alias", frame: strings.ReplaceAll(historyCompletedFrame, "response.completed", "response.done"), success: true},
		{name: "cancel_after_delivered", frame: historyCompletedFrame, cancel: true, success: true},
		{name: "read_error_after_delivered", frame: historyCompletedFrame, readFailure: true, success: true},
		{name: "read_error_before_terminal", frame: "data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n", readFailure: true, category: "stream_interrupted"},
		{name: "read_ahead_without_delivery", frame: historyCompletedFrame, writeFail: true, category: "downstream_write_error"},
		{name: "short_write", frame: historyCompletedFrame, writeFail: true, shortWrite: true, category: "downstream_write_error"},
		{name: "truncated_frame", frame: strings.TrimSuffix(historyCompletedFrame, "\n\n"), category: "stream_interrupted"},
		{name: "done_without_terminal", frame: "data: [DONE]\n\n", category: "stream_interrupted"},
		{name: "explicit_failure", frame: "data: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n", category: "upstream_response_failed"},
		{name: "incomplete", frame: "data: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\"}}\n\n", category: "response_incomplete"},
		{name: "null_error", frame: strings.Replace(historyCompletedFrame, `"type":"response.completed"`, `"error":null,"type":"response.completed"`, 1), success: true},
		{name: "nested_failure", frame: strings.Replace(historyCompletedFrame, `"status":"completed"`, `"status":"failed"`, 1), category: "upstream_response_failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ctx = internallogging.WithRequestID(ctx, tc.name)
			rec := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(rec)
			c.Request = httptest.NewRequest("POST", "/v1/responses", nil).WithContext(ctx)
			writer := &historyFaultWriter{ResponseWriter: c.Writer, fail: tc.writeFail, short: tc.shortWrite}
			if tc.cancel {
				writer.cancel = cancel
			}
			c.Writer = writer
			c.Status(200)
			var reader io.Reader = bytes.NewBufferString(tc.frame)
			if tc.readFailure {
				reader = historyReadError{reader}
			}
			observer := &providerUsageObserver{wireAPI: "responses", body: io.NopCloser(reader)}
			tracker := newRequestUsageTracker()
			server := &relayServer{policy: &requestPolicy{tracker: tracker}}
			server.writeProviderGatewayResponsesStream(c, observer, false)
			server.recordProviderUsage(c, "fixture", nil, nil, time.Now(), observer, true)
			record := tracker.records[tc.name][0]
			if record.Success != tc.success || record.ErrorCategory != tc.category {
				t.Fatalf("success=%v category=%s; want %v/%s", record.Success, record.ErrorCategory, tc.success, tc.category)
			}
		})
	}
}
