package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

type delayedProviderRoundTripper struct{ delay time.Duration }

func (r delayedProviderRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	timer := time.NewTimer(r.delay)
	defer timer.Stop()
	select {
	case <-request.Context().Done():
		return nil, request.Context().Err()
	case <-timer.C:
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
			Body:       io.NopCloser(strings.NewReader("data: ready\n\n")),
			Request:    request,
		}, nil
	}
}

func TestDoProviderStreamWaitsPastFormerMinuteOpenTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://provider.invalid/v1/responses", nil)
		if err != nil {
			t.Fatal(err)
		}
		client := &http.Client{Transport: delayedProviderRoundTripper{delay: 61 * time.Second}}
		response, err := doProviderStream(client, request, streamTimeoutProfile{idle: 2 * time.Minute})
		if err != nil {
			t.Fatalf("disabled open timeout failed before delayed headers: %v", err)
		}
		if time.Since(started) < 61*time.Second {
			t.Fatal("test did not advance beyond the former one-minute open timeout")
		}
		if body, err := io.ReadAll(response.Body); err != nil || string(body) != "data: ready\n\n" {
			t.Fatalf("delayed provider response was not read: body=%q err=%v", body, err)
		}
		if err := response.Body.Close(); err != nil {
			t.Fatalf("close provider response: %v", err)
		}
	})
}

func TestDoProviderStreamWaitsForHeadersWhenOpenTimeoutIsDisabled(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: ready\n\n")
	}))
	defer server.Close()

	go func() {
		<-started
		time.Sleep(60 * time.Millisecond)
		close(release)
	}()
	request, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := doProviderStream(server.Client(), request, streamTimeoutProfile{idle: time.Second})
	if err != nil {
		t.Fatalf("disabled open timeout unexpectedly failed: %v", err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	if string(body) != "data: ready\n\n" {
		t.Fatalf("unexpected stream body %q", body)
	}
}

func TestDoProviderStreamStillHonorsDownstreamCancellation(t *testing.T) {
	requestStarted := make(chan struct{})
	upstreamCanceled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(requestStarted)
		<-r.Context().Done()
		close(upstreamCanceled)
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := doProviderStream(server.Client(), request, streamTimeoutProfile{})
		result <- err
	}()
	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("upstream request did not start")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled downstream returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("downstream cancellation did not stop the pending request")
	}
	select {
	case <-upstreamCanceled:
	case <-time.After(time.Second):
		t.Fatal("downstream cancellation did not reach the upstream")
	}
}
