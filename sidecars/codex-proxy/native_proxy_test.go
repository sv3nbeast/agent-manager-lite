package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type nativeProxyFixture struct {
	url      string
	input    *io.PipeWriter
	finished chan struct{}
	err      error
}

func startNativeProxyFixture(t *testing.T, upstream string) *nativeProxyFixture {
	t.Helper()
	input, writer := io.Pipe()
	output, outputWriter := io.Pipe()
	fixture := &nativeProxyFixture{input: writer, finished: make(chan struct{})}
	go func() {
		fixture.err = runNativeProxy(context.Background(), input, outputWriter)
		_ = outputWriter.Close()
		close(fixture.finished)
	}()
	t.Cleanup(func() {
		fixture.stop(t)
		_ = output.Close()
	})
	if err := json.NewEncoder(writer).Encode(nativeProxyInput{Proxy: upstream}); err != nil {
		t.Fatal(err)
	}
	type ready struct {
		Type string `json:"type"`
		URL  string `json:"url"`
	}
	result := make(chan ready, 1)
	go func() {
		var value ready
		_ = json.NewDecoder(output).Decode(&value)
		result <- value
	}()
	select {
	case value := <-result:
		parsed, err := url.Parse(value.URL)
		if value.Type != "ready" || err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.User != nil {
			t.Fatalf("invalid public bridge endpoint: %+v", value)
		}
		fixture.url = value.URL
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not become ready")
	}
	return fixture
}

func (fixture *nativeProxyFixture) stop(t *testing.T) {
	t.Helper()
	_ = fixture.input.Close()
	select {
	case <-fixture.finished:
		if fixture.err != nil {
			t.Errorf("bridge returned unsafe/unexpected error: %v", fixture.err)
		}
	case <-time.After(3 * time.Second):
		t.Error("bridge survived owner EOF")
	}
}

func nativeFixtureRelay(client, remote net.Conn, reader io.Reader) {
	defer client.Close()
	defer remote.Close()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(remote, reader); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, remote); done <- struct{}{} }()
	<-done
	_ = client.Close()
	_ = remote.Close()
	<-done
}

func nativeFixtureTarget(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Proxy-Authorization") != "" {
			t.Error("upstream proxy credentials escaped into the native target")
		}
		if request.Header.Get("Authorization") != "Bearer native-fixture" {
			t.Error("native target authentication changed")
		}
		if request.Header.Get("Upgrade") == "fixture" {
			conn, buffer, err := w.(http.Hijacker).Hijack()
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n")
			_, _ = io.Copy(conn, buffer)
			return
		}
		_, _ = io.WriteString(w, "native-account-response")
	}))
	t.Cleanup(server.Close)
	return server
}

func nativeHTTPProxyFixture(t *testing.T, target, scheme string) (string, *atomic.Int32) {
	t.Helper()
	parsed, _ := url.Parse(target)
	var requests atomic.Int32
	transport := &http.Transport{Proxy: nil}
	t.Cleanup(transport.CloseIdleConnections)
	forward := &httputil.ReverseProxy{Transport: transport, Rewrite: func(request *httputil.ProxyRequest) {
		request.Out.URL.Scheme = "http"
		request.Out.URL.Host = parsed.Host
		request.Out.Header.Del("Proxy-Authorization")
	}}
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Proxy-Authorization") != "Basic Zml4dHVyZTpzZWNyZXQ=" {
			http.Error(w, "fixture authentication failed", http.StatusProxyAuthRequired)
			return
		}
		requests.Add(1)
		if request.Method == http.MethodConnect {
			if request.Host != "fixture.invalid:443" {
				t.Errorf("unexpected CONNECT destination %q", request.Host)
			}
			remote, err := net.DialTimeout("tcp", parsed.Host, time.Second)
			if err != nil {
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			client, buffer, err := w.(http.Hijacker).Hijack()
			if err != nil {
				_ = remote.Close()
				return
			}
			_, _ = io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n")
			nativeFixtureRelay(client, remote, buffer)
			return
		}
		if request.URL.Hostname() != "fixture.invalid" {
			t.Errorf("unexpected absolute destination %q", request.URL.Host)
		}
		forward.ServeHTTP(w, request)
	}))
	if scheme == "https" {
		upstream.StartTLS()
		// This case runs in its own test process; the fixture CA must never change
		// global root selection for unrelated tests or disable verification.
		t.Setenv("GODEBUG", os.Getenv("GODEBUG")+",x509usefallbackroots=1")
		roots := x509.NewCertPool()
		roots.AddCert(upstream.Certificate())
		x509.SetFallbackRoots(roots)
	} else {
		upstream.Start()
	}
	t.Cleanup(upstream.Close)
	proxyURL, _ := url.Parse(upstream.URL)
	proxyURL.User = url.UserPassword("fixture", "secret")
	return proxyURL.String(), &requests
}

func exerciseNativeProxyForwarding(t *testing.T, fixture *nativeProxyFixture) {
	t.Helper()
	endpoint, _ := url.Parse(fixture.url)
	transport := &http.Transport{Proxy: http.ProxyURL(endpoint)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	request, _ := http.NewRequest(http.MethodGet, "http://fixture.invalid/native", nil)
	request.Header.Set("Authorization", "Bearer native-fixture")
	request.Header.Set("Proxy-Authorization", "untrusted-client-proxy-secret")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != 200 || string(body) != "native-account-response" {
		t.Fatalf("HTTP bridge response: %d %q", response.StatusCode, body)
	}
	conn, err := net.DialTimeout("tcp", endpoint.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	// Send the tunneled request in the same write to verify bytes already read
	// with CONNECT headers survive the hijack.
	_, _ = io.WriteString(conn, "CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\nProxy-Authorization: untrusted-client-proxy-secret\r\n\r\nGET /tunnel HTTP/1.1\r\nHost: fixture.invalid\r\nAuthorization: Bearer native-fixture\r\nConnection: close\r\n\r\n")
	reader := bufio.NewReader(conn)
	response, err = http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("CONNECT failed: response=%v, err=%v", response, err)
	}
	response, err = http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != 200 || string(body) != "native-account-response" {
		t.Fatalf("CONNECT lost native response: %d %q", response.StatusCode, body)
	}
}

func TestNativeProxyAuthenticatedHTTP(t *testing.T) {
	target := nativeFixtureTarget(t)
	upstream, requests := nativeHTTPProxyFixture(t, target.URL, "http")
	bridge := startNativeProxyFixture(t, upstream)
	exerciseNativeProxyForwarding(t, bridge)
	if requests.Load() != 2 {
		t.Fatalf("HTTP upstream was bypassed: %d requests", requests.Load())
	}
}

func TestNativeProxyAuthenticatedHTTPS(t *testing.T) {
	if os.Getenv("CML_NATIVE_HTTPS_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestNativeProxyAuthenticatedHTTPS$", "-test.v")
		command.Env = append(os.Environ(), "CML_NATIVE_HTTPS_FIXTURE=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("verified HTTPS upstream fixture failed: %v\n%s", err, output)
		}
		return
	}
	target := nativeFixtureTarget(t)
	upstream, requests := nativeHTTPProxyFixture(t, target.URL, "https")
	bridge := startNativeProxyFixture(t, upstream)
	exerciseNativeProxyForwarding(t, bridge)
	if requests.Load() != 2 {
		t.Fatalf("HTTPS upstream was bypassed: %d requests", requests.Load())
	}
}

func nativeSOCKSProxyFixture(t *testing.T, target string) (string, *atomic.Int32) {
	t.Helper()
	parsed, _ := url.Parse(target)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	var requests atomic.Int32
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer client.Close()
				_ = client.SetDeadline(time.Now().Add(5 * time.Second))
				read := func(size int) []byte {
					value := make([]byte, size)
					if _, err := io.ReadFull(client, value); err != nil {
						return nil
					}
					return value
				}
				hello := read(2)
				if len(hello) != 2 || hello[0] != 5 || read(int(hello[1])) == nil {
					return
				}
				_, _ = client.Write([]byte{5, 2})
				auth := read(2)
				if len(auth) != 2 || auth[0] != 1 {
					return
				}
				username := read(int(auth[1]))
				length := read(1)
				if len(length) != 1 {
					return
				}
				password := read(int(length[0]))
				if string(username) != "fixture" || string(password) != "secret" {
					_, _ = client.Write([]byte{1, 1})
					return
				}
				_, _ = client.Write([]byte{1, 0})
				request := read(4)
				if len(request) != 4 || request[0] != 5 || request[1] != 1 || request[3] != 3 {
					return
				}
				length = read(1)
				if len(length) != 1 {
					return
				}
				name := read(int(length[0]))
				port := read(2)
				if string(name) != "fixture.invalid" || len(port) != 2 || binary.BigEndian.Uint16(port) != 80 && binary.BigEndian.Uint16(port) != 443 {
					return
				}
				requests.Add(1)
				remote, err := net.DialTimeout("tcp", parsed.Host, time.Second)
				if err != nil {
					return
				}
				_, _ = client.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 80})
				nativeFixtureRelay(client, remote, client)
			}()
		}
	}()
	return listener.Addr().String(), &requests
}

func TestNativeProxyAuthenticatedSOCKSAndRemoteDNS(t *testing.T) {
	for _, scheme := range []string{"socks5", "socks5h"} {
		t.Run(scheme, func(t *testing.T) {
			target := nativeFixtureTarget(t)
			upstream, requests := nativeSOCKSProxyFixture(t, target.URL)
			bridge := startNativeProxyFixture(t, scheme+"://fixture:secret@"+upstream)
			exerciseNativeProxyForwarding(t, bridge)
			if requests.Load() != 2 {
				t.Fatalf("SOCKS upstream or remote DNS was bypassed: %d requests", requests.Load())
			}
		})
	}
}

func TestNativeProxyUpgradeAndEOFCloseHijackedConnections(t *testing.T) {
	target := nativeFixtureTarget(t)
	upstream, _ := nativeHTTPProxyFixture(t, target.URL, "http")
	bridge := startNativeProxyFixture(t, upstream)
	endpoint, _ := url.Parse(bridge.url)
	conn, err := net.DialTimeout("tcp", endpoint.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = io.WriteString(conn, "GET http://fixture.invalid/upgrade HTTP/1.1\r\nHost: fixture.invalid\r\nAuthorization: Bearer native-fixture\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n")
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade failed: response=%v err=%v", response, err)
	}
	_, _ = io.WriteString(conn, "upgrade-echo")
	payload := make([]byte, len("upgrade-echo"))
	if _, err := io.ReadFull(reader, payload); err != nil || string(payload) != "upgrade-echo" {
		t.Fatalf("upgrade relay failed: payload=%q err=%v", payload, err)
	}
	bridge.stop(t)
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("upgraded connection survived owner EOF")
	}
	if conn, err := net.DialTimeout("tcp", endpoint.Host, 100*time.Millisecond); err == nil {
		_ = conn.Close()
		t.Fatal("bridge listener survived owner EOF")
	}
}

func TestNativeProxyEOFCancelsPendingCONNECTDial(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan struct{})
	closed := make(chan struct{})
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		reader := bufio.NewReader(conn)
		if _, err := http.ReadRequest(reader); err != nil {
			return
		}
		close(accepted)
		_, _ = reader.ReadByte()
		close(closed)
	}()
	bridge := startNativeProxyFixture(t, "http://fixture:secret@"+listener.Addr().String())
	endpoint, _ := url.Parse(bridge.url)
	conn, err := net.DialTimeout("tcp", endpoint.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\n\r\n")
	select {
	case <-accepted:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream CONNECT never started")
	}
	bridge.stop(t)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("pending upstream dial survived owner EOF")
	}
}

func TestNativeProxyFailureNeverFallsBackAndRedactsSecrets(t *testing.T) {
	var directRequests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { directRequests.Add(1) }))
	defer target.Close()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "private-upstream-name fixture-secret", http.StatusProxyAuthRequired)
	}))
	defer upstream.Close()
	upstreamURL, _ := url.Parse(upstream.URL)
	upstreamURL.User = url.UserPassword("fixture", "fixture-secret")
	bridge := startNativeProxyFixture(t, upstreamURL.String())
	endpoint, _ := url.Parse(bridge.url)
	transport := &http.Transport{Proxy: http.ProxyURL(endpoint)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	response, err := client.Get(target.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusBadGateway || string(body) != "native proxy request failed\n" || directRequests.Load() != 0 {
		t.Fatalf("unsafe proxy failure: status=%d body=%q direct=%d", response.StatusCode, body, directRequests.Load())
	}
	// Ordinary localhost requests cannot use this bridge as a reverse proxy.
	direct := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: time.Second}
	response, err = direct.Get(bridge.url + "/")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("origin-form request accepted: %d", response.StatusCode)
	}
}

func TestNativeProxyRejectsInvalidOrUnboundedConfiguration(t *testing.T) {
	for _, raw := range []string{
		`{"proxy":"direct"}`,
		`{"proxy":""}`,
		`{"proxy":"ftp://fixture:fixture-secret@127.0.0.1:80"}`,
		`{"proxy":"http://fixture:fixture-secret@127.0.0.1:0"}`,
		`{"proxy":"http://fixture:%0Asecret@127.0.0.1:80"}`,
		`{"proxy":"http://fixture:fixture-secret@127.0.0.1:80/path"}`,
		`{"proxy":"http://127.0.0.1:80","unexpected":"fixture-secret"}`,
		`{"proxy":"http://127.0.0.1:80"} {}`,
		fmt.Sprintf(`{"proxy":"http://%s@127.0.0.1:80"}`, strings.Repeat("secret", nativeProxyInputLimit)),
	} {
		var output bytes.Buffer
		err := runNativeProxy(context.Background(), strings.NewReader(raw+"\n"), &output)
		if err != errNativeProxy || output.Len() != 0 {
			t.Fatalf("configuration was accepted or leaked: error=%v output=%q", err, output.String())
		}
	}
}
