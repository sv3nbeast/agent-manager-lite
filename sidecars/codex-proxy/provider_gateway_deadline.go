package main

import (
	"context"
	"io"
	"net/http"
	"time"
)

// Bound the direct provider path with the same configured open/idle budgets as
// the executor path. A timeout cancels the actual HTTP exchange. Do not replay
// here: account-pool failover owns pre-output retries and checks commitment.
func doProviderStream(client *http.Client, req *http.Request, timeouts streamTimeoutProfile) (*http.Response, error) {
	ctx, cancel := context.WithCancelCause(req.Context())
	timer := time.AfterFunc(timeouts.open, func() {
		cancel(relayTimeoutError{phase: "stream_open", timeout: timeouts.open})
	})
	response, err := client.Do(req.WithContext(ctx))
	timer.Stop()
	if cause := context.Cause(ctx); cause != nil {
		if response != nil {
			response.Body.Close()
		}
		cancel(cause)
		return nil, cause
	}
	if err != nil {
		cancel(err)
		return nil, err
	}
	response.Body = &providerStreamBody{ReadCloser: response.Body, ctx: ctx, cancel: cancel, idle: timeouts.idle}
	return response, nil
}

type providerStreamBody struct {
	io.ReadCloser
	ctx    context.Context
	cancel context.CancelCauseFunc
	idle   time.Duration
}

func (b *providerStreamBody) Read(p []byte) (int, error) {
	if err := context.Cause(b.ctx); err != nil {
		return 0, err
	}
	// Time only an upstream read, not time blocked writing to a slow downstream.
	timer := time.AfterFunc(b.idle, func() {
		b.cancel(relayTimeoutError{phase: "stream_idle", timeout: b.idle})
	})
	n, err := b.ReadCloser.Read(p)
	timer.Stop()
	if cause := context.Cause(b.ctx); cause != nil {
		return n, cause
	}
	return n, err
}

func (b *providerStreamBody) Close() error {
	b.cancel(context.Canceled)
	return b.ReadCloser.Close()
}
