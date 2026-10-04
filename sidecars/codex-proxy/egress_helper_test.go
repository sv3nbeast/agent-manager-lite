package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

func TestAccountEgressAllowsExactSubscriptionRoutingHeaders(t *testing.T) {
	headers := map[string]string{"Referer": "https://chatgpt.com/", "x-openai-target-path": "/backend-api/subscriptions", "x-openai-target-route": "/backend-api/subscriptions", "X-OpenAI-Fedramp": "true"}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for header, expected := range headers {
			if actual := r.Header.Get(header); actual != expected {
				t.Errorf("header %s = %q, want %q", header, actual, expected)
			}
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer target.Close()
	output := egressRequest(context.Background(), egressInput{URL: target.URL, Method: "GET", Proxy: "direct", Headers: headers})
	if output.Error != "" || output.Status != 200 {
		t.Fatalf("subscription headers rejected: %+v", output)
	}
	rejected := egressRequest(context.Background(), egressInput{URL: target.URL, Method: "GET", Proxy: "direct", Headers: map[string]string{"x-not-allowed": "fixture"}})
	if rejected.Error != "invalid" {
		t.Fatalf("unknown header was accepted: %+v", rejected)
	}
}

func TestAccountEgressSOCKSAuthenticationAndRemoteName(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("SOCKS secret reached target")
		}
		_, _ = io.WriteString(w, `{"ip":"203.0.113.9"}`)
	}))
	defer target.Close()
	upstream, _ := url.Parse(target.URL)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	names := make(chan string, 4)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
				read := func(n int) []byte {
					data := make([]byte, n)
					if _, err := io.ReadFull(conn, data); err != nil {
						return nil
					}
					return data
				}
				hello := read(2)
				if len(hello) != 2 || hello[0] != 5 {
					return
				}
				if read(int(hello[1])) == nil {
					return
				}
				_, _ = conn.Write([]byte{5, 2})
				auth := read(2)
				if len(auth) != 2 || auth[0] != 1 {
					return
				}
				user := read(int(auth[1]))
				length := read(1)
				if len(length) != 1 {
					return
				}
				password := read(int(length[0]))
				if string(user) != "fixture" || string(password) != "secret" {
					_, _ = conn.Write([]byte{1, 1})
					return
				}
				_, _ = conn.Write([]byte{1, 0})
				request := read(4)
				if len(request) != 4 || request[1] != 1 || request[3] != 3 {
					return
				}
				length = read(1)
				if len(length) != 1 {
					return
				}
				name := read(int(length[0]))
				port := read(2)
				if len(port) != 2 || binary.BigEndian.Uint16(port) == 0 {
					return
				}
				names <- string(name)
				remote, err := net.DialTimeout("tcp", upstream.Host, time.Second)
				if err != nil {
					return
				}
				defer remote.Close()
				_, _ = conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 80})
				done := make(chan struct{})
				go func() { _, _ = io.Copy(remote, conn); close(done) }()
				_, _ = io.Copy(conn, remote)
				_ = conn.Close()
				<-done
			}()
		}
	}()
	for _, scheme := range []string{"socks5", "socks5h"} {
		result := egressRequest(context.Background(), egressInput{URL: "http://fixture.invalid:1234/", Method: "GET", Proxy: scheme + "://fixture:secret@" + listener.Addr().String()})
		if result.Status != 200 {
			t.Fatalf("SOCKS transport failed: %s", result.Error)
		}
		select {
		case name := <-names:
			if name != "fixture.invalid" {
				t.Fatal("wrong proxy destination")
			}
		default:
			t.Fatal("SOCKS proxy bypassed")
		}
	}
}

func TestAccountEgressHTTPProxyDirectAndNoFallback(t *testing.T) {
	var targets, proxies atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targets.Add(1)
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("proxy credentials reached target")
		}
		if r.Header.Get("X-OpenAI-Fedramp") != "true" {
			t.Error("Fedramp routing header changed before reaching target")
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer target.Close()
	direct := http.DefaultTransport.(*http.Transport).Clone()
	direct.Proxy = nil
	defer direct.CloseIdleConnections()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxies.Add(1)
		if r.Header.Get("Proxy-Authorization") != "Basic Zml4dHVyZTpzZWNyZXQ=" {
			w.WriteHeader(407)
			return
		}
		clone := r.Clone(r.Context())
		clone.RequestURI = ""
		clone.Header.Del("Proxy-Authorization")
		result, err := direct.RoundTrip(clone)
		if err != nil {
			t.Error(err)
			w.WriteHeader(502)
			return
		}
		defer result.Body.Close()
		w.WriteHeader(result.StatusCode)
		_, _ = io.Copy(w, result.Body)
	}))
	defer proxy.Close()
	address, _ := url.Parse(proxy.URL)
	address.User = url.UserPassword("fixture", "secret")
	request := egressInput{URL: target.URL, Method: "GET", Proxy: address.String(), Headers: map[string]string{"Authorization": "Bearer fixture-token", "X-OpenAI-Fedramp": "true"}}
	result := egressRequest(context.Background(), request)
	if result.Status != 200 || !bytes.Contains(result.Body, []byte(`"ok":true`)) || proxies.Load() != 1 || targets.Load() != 1 {
		t.Fatal("request did not pass through authenticated proxy")
	}
	request.Proxy = "direct"
	result = egressRequest(context.Background(), request)
	if result.Status != 200 || proxies.Load() != 1 || targets.Load() != 2 {
		t.Fatal("explicit direct did not bypass proxy")
	}
	request.Proxy = proxy.URL
	result = egressRequest(context.Background(), request)
	if result.Status != 407 || targets.Load() != 2 {
		t.Fatal("rejected proxy retried target")
	}
	request.Proxy = "http://fixture:secret@127.0.0.1:1"
	result = egressRequest(context.Background(), request)
	if result.Error != "network" || targets.Load() != 2 {
		t.Fatal("unavailable proxy fell back")
	}
	for _, value := range []string{"", "file://fixture-secret", "unknown://fixture-secret@localhost:1"} {
		request.Proxy = value
		result = egressRequest(context.Background(), request)
		if result.Error != "invalid" || targets.Load() != 2 {
			t.Fatal("invalid proxy used default network")
		}
	}
}

func TestAccountEgressLimitsRedirectTLSAndCancellation(t *testing.T) {
	var redirected atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			w.Header().Set("Location", "/target")
			w.WriteHeader(302)
		case "/target":
			redirected.Add(1)
			_, _ = io.WriteString(w, `{}`)
		case "/large":
			_, _ = io.WriteString(w, strings.Repeat("x", egressOutputLimit+1))
		case "/wait":
			<-r.Context().Done()
		default:
			w.WriteHeader(401)
			_, _ = io.WriteString(w, `{"error":"invalid_task_id"}`)
		}
	}))
	defer server.Close()
	input := egressInput{URL: server.URL + "/redirect", Method: "GET", Proxy: "direct"}
	if got := egressRequest(context.Background(), input); got.Status != 302 || redirected.Load() != 0 {
		t.Fatal("redirect followed")
	}
	input.URL = server.URL + "/large"
	if got := egressRequest(context.Background(), input); got.Error != "response" {
		t.Fatal("unbounded body")
	}
	input.URL = server.URL
	got := egressRequest(context.Background(), input)
	if got.Status != 401 || !bytes.Contains(got.Body, []byte("invalid_task_id")) {
		t.Fatal("HTTP classification discarded")
	}
	input.URL = server.URL + "/wait"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if got := egressRequest(ctx, input); got.Error != "network" {
		t.Fatal("cancelled request succeeded")
	}
	tlsServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted TLS accepted") }))
	defer tlsServer.Close()
	input.URL = tlsServer.URL
	if got := egressRequest(context.Background(), input); got.Error != "network" {
		t.Fatal("TLS verification bypassed")
	}
	input.URL = server.URL
	input.Proxy = tlsServer.URL
	if got := egressRequest(context.Background(), input); got.Error != "network" {
		t.Fatal("proxy TLS verification bypassed")
	}
}

func TestAccountEgressStrictInputAndBlockedRuntimeTransport(t *testing.T) {
	var out bytes.Buffer
	for _, raw := range []string{`{} {}`, `{"unknown":"fixture-secret"}`, strings.Repeat("a", egressInputLimit+1)} {
		out.Reset()
		err := runEgressHelper(context.Background(), strings.NewReader(raw), &out)
		if err == nil || strings.Contains(err.Error(), "fixture-secret") || out.Len() != 0 {
			t.Fatal("invalid helper input was not rejected")
		}
	}
	for _, input := range []egressInput{{URL: "file:///fixture-secret", Method: "GET", Proxy: "direct"}, {URL: "http://fixture:secret@localhost", Method: "GET", Proxy: "direct"}, {URL: "http://localhost", Method: "DELETE", Proxy: "direct"}, {URL: "http://localhost", Method: "GET", Proxy: "direct", Headers: map[string]string{"Proxy-Authorization": "fixture-secret"}}} {
		raw, _ := json.Marshal(input)
		out.Reset()
		if err := runEgressHelper(context.Background(), bytes.NewReader(raw), &out); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), `"error":"invalid"`) || strings.Contains(out.String(), "fixture-secret") {
			t.Fatal("helper validation failed")
		}
	}
	provider := newSidecarRoundTripperProvider()
	transport := provider.RoundTripperFor(&coreauth.Auth{ProxyURL: "broken://fixture-secret"})
	if transport == nil {
		t.Fatal("invalid account proxy selected default transport")
	}
	request, _ := http.NewRequest("GET", "http://127.0.0.1:1", nil)
	_, err := transport.RoundTrip(request)
	if err == nil || strings.Contains(err.Error(), "fixture-secret") {
		t.Fatal("invalid proxy not blocked safely")
	}
	if provider.RoundTripperFor(&coreauth.Auth{}) != nil {
		t.Fatal("unconfigured account defaults changed")
	}
}
