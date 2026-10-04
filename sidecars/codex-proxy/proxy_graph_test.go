package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func graphFixture() map[string]any {
	return map[string]any{"version": 1, "proxies": []any{map[string]any{"name": "resource-1", "type": "http", "server": "localhost", "port": 8080, "password": "synthetic-secret"}}, "groups": []any{map[string]any{"name": "account-node", "type": "fallback", "proxies": []any{"resource-1", "REJECT"}, "empty-fallback": "REJECT", "url": "http://127.0.0.1:8000/status", "interval": 0}}, "names": map[string]string{"account-node": "Root", "resource-1": "Node"}, "insecureNames": []string{}}
}
func encodeGraph(t *testing.T, v map[string]any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func TestFrozenGraphConfigurationAndValidation(t *testing.T) {
	v := engineFixtureInput(t)
	v.Proxy = nil
	v.Graph = encodeGraph(t, graphFixture())
	if !v.valid() {
		t.Fatal("valid graph rejected")
	}
	b, e := v.config()
	if e != nil {
		t.Fatal(e)
	}
	var c map[string]any
	if json.Unmarshal(b, &c) != nil {
		t.Fatal("invalid config")
	}
	if len(c["proxies"].([]any)) != 1 || len(c["proxy-groups"].([]any)) != 1 || c["rules"].([]any)[0] != "MATCH,account-node" {
		t.Fatal("graph lost or default route changed")
	}
	if bytes.Contains(b, []byte(`"names"`)) || bytes.Contains(b, []byte(`"Root"`)) {
		t.Fatal("display metadata became runtime configuration")
	}
	v.Proxy = json.RawMessage(`{}`)
	if v.valid() {
		t.Fatal("both graph and node accepted")
	}
}
func TestFrozenGraphRejectsTampering(t *testing.T) {
	cases := map[string]func(map[string]any){
		"direct":    func(g map[string]any) { g["groups"].([]any)[0].(map[string]any)["proxies"] = []any{"DIRECT"} },
		"cycle":     func(g map[string]any) { g["groups"].([]any)[0].(map[string]any)["proxies"] = []any{"account-node"} },
		"missing":   func(g map[string]any) { g["groups"].([]any)[0].(map[string]any)["proxies"] = []any{"resource-2"} },
		"orphan":    func(g map[string]any) { g["groups"].([]any)[0].(map[string]any)["proxies"] = []any{"REJECT"} },
		"duplicate": func(g map[string]any) { g["proxies"] = append(g["proxies"].([]any), g["proxies"].([]any)[0]) },
		"file":      func(g map[string]any) { g["proxies"].([]any)[0].(map[string]any)["certificate"] = "/tmp/secret" },
		"nested file": func(g map[string]any) {
			g["proxies"].([]any)[0].(map[string]any)["headers"] = map[string]any{"nested": map[string]any{"client_key": "/tmp/secret"}}
		},
		"udp ignored": func(g map[string]any) {
			n := g["proxies"].([]any)[0].(map[string]any)
			n["type"] = "hysteria2"
			n["udp"] = false
		},
		"ssh unverified":   func(g map[string]any) { g["proxies"].([]any)[0].(map[string]any)["type"] = "ssh" },
		"dynamic provider": func(g map[string]any) { g["groups"].([]any)[0].(map[string]any)["include-all-providers"] = true },
		"fallback":         func(g map[string]any) { g["groups"].([]any)[0].(map[string]any)["empty-fallback"] = "DIRECT" },
		"url credentials": func(g map[string]any) {
			g["groups"].([]any)[0].(map[string]any)["url"] = "http://user:synthetic-secret@localhost/"
		},
		"permission missing": func(g map[string]any) { g["proxies"].([]any)[0].(map[string]any)["skip-cert-verify"] = true },
		"permission extra":   func(g map[string]any) { g["insecureNames"] = []string{"resource-1"} },
		"global config":      func(g map[string]any) { g["rules"] = []string{"MATCH,DIRECT"} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			g := graphFixture()
			mutate(g)
			if _, e := decodeProxyGraph(encodeGraph(t, g)); e == nil {
				t.Fatal("tampered graph accepted")
			}
		})
	}
	g := graphFixture()
	g["proxies"].([]any)[0].(map[string]any)["skip-cert-verify"] = true
	g["insecureNames"] = []string{"resource-1"}
	if _, e := decodeProxyGraph(encodeGraph(t, g)); e != nil {
		t.Fatal("explicit TLS permission rejected")
	}
}
