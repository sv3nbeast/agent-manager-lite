package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"strings"
	"testing"
)

func engineFixtureInput(t *testing.T) proxyEngineInput {
	t.Helper()
	return proxyEngineInput{Binary: filepath.Join(t.TempDir(), "engine"), Root: filepath.Join(t.TempDir(), "runtime"), Port: 34567, ControllerPort: 34568, Username: strings.Repeat("a", 48), Password: strings.Repeat("b", 48), Secret: strings.Repeat("c", 64), Proxy: json.RawMessage(`{"name":"account-node","type":"vless","server":"localhost","port":1234,"uuid":"11111111-2222-3333-4444-555555555555"}`)}
}

func TestProxyEngineConfigIsIsolated(t *testing.T) {
	v := engineFixtureInput(t)
	if !v.valid() {
		t.Fatal("fixture should validate")
	}
	b, err := v.config()
	if err != nil {
		t.Fatal(err)
	}
	var c map[string]any
	if json.Unmarshal(b, &c) != nil {
		t.Fatal("invalid JSON")
	}
	if c["allow-lan"] != false || c["bind-address"] != "127.0.0.1" || c["external-controller"] != "127.0.0.1:34568" || len(c["skip-auth-prefixes"].([]any)) != 0 {
		t.Fatal("listener must require authentication on loopback")
	}
	for _, feature := range []string{"tun", "dns", "sniffer"} {
		if c[feature].(map[string]any)["enable"] != false {
			t.Fatal("unexpected system/network feature")
		}
	}
	if c["rules"].([]any)[0] != "MATCH,account-node" || len(c["proxy-groups"].([]any)) != 0 {
		t.Fatal("unexpected fallback")
	}
	if bytes.Contains(b, []byte(v.Binary)) || bytes.Contains(b, []byte(v.Root)) {
		t.Fatal("config contains filesystem paths")
	}
	v.ControllerPort = v.Port
	if v.valid() {
		t.Fatal("overlapping ports accepted")
	}
}

func TestProxyEngineFramingRejectsInvalidInputWithoutEcho(t *testing.T) {
	for _, raw := range []string{"{\"password\":\"fixture-secret\"}\n", strings.Repeat("x", 1024*1024+2) + "\n", "{} {}\n", "{}"} {
		var out bytes.Buffer
		if runProxyEngine(context.Background(), strings.NewReader(raw), &out) == nil {
			t.Fatal("invalid frame accepted")
		}
		if out.Len() != 0 {
			t.Fatal("untrusted input echoed")
		}
	}
}

func TestProxyEngineReadinessRequiresMatchingAuthentication(t *testing.T) {
	for _, mode := range []string{"none", "reject", "accept"} {
		t.Run(mode, func(t *testing.T) {
			v := engineFixtureInput(t)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			v.Port = listener.Addr().(*net.TCPAddr).Port
			done := make(chan struct{})
			go func() {
				defer close(done)
				c, err := listener.Accept()
				if err != nil {
					return
				}
				defer c.Close()
				greeting := make([]byte, 3)
				if _, err = io.ReadFull(c, greeting); err != nil {
					return
				}
				if mode == "none" {
					_, _ = c.Write([]byte{5, 0})
					return
				}
				_, _ = c.Write([]byte{5, 2})
				request := make([]byte, 3+len(v.Username)+len(v.Password))
				if _, err = io.ReadFull(c, request); err != nil {
					return
				}
				if string(request[2:2+len(v.Username)]) != v.Username || string(request[3+len(v.Username):]) != v.Password {
					return
				}
				if mode == "accept" {
					_, _ = c.Write([]byte{1, 0})
				} else {
					_, _ = c.Write([]byte{1, 1})
				}
			}()
			err = authenticateProxyEngine(context.Background(), v)
			<-done
			if (err == nil) != (mode == "accept") {
				t.Fatalf("unexpected readiness: %v", err)
			}
		})
	}
}
