package main

// Independent stdin boundary for the native graph produced by the parent.
// Option list: Cockpit ee816002 codex_proxy_mihomo.rs, Mihomo v1.19.31.
import (
	"bytes"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

//go:embed native_proxy_options.json
var nativeProxyOptionsJSON []byte
var nativeProxyOptions = func() map[string][]string {
	var result map[string][]string
	if json.Unmarshal(nativeProxyOptionsJSON, &result) != nil {
		panic("invalid native option list")
	}
	return result
}()
var proxyOpaqueName = regexp.MustCompile(`^(account-node|resource-[1-9][0-9]*)$`)

type frozenProxyGraph struct {
	Version       int               `json:"version"`
	Proxies       []map[string]any  `json:"proxies"`
	Groups        []map[string]any  `json:"groups"`
	Names         map[string]string `json:"names"`
	InsecureNames []string          `json:"insecureNames"`
}

func optionHas(options []string, name string) bool {
	for _, v := range options {
		if v == name {
			return true
		}
	}
	return false
}
func proxyNumber(value any, max int64) bool {
	n, ok := value.(json.Number)
	if !ok {
		return false
	}
	i, err := n.Int64()
	return err == nil && i >= 0 && i <= max
}
func proxyShort(s string) bool {
	return len(s) > 0 && len(s) <= 256 && strings.IndexFunc(s, unicode.IsControl) < 0 && !strings.Contains(s, "://") && !strings.Contains(strings.ToLower(s), "token=") && !strings.Contains(strings.ToLower(s), "password=")
}
func proxyRanges(value any) bool {
	raw, ok := value.(string)
	if !ok || raw == "" {
		return false
	}
	for _, part := range strings.Split(raw, ",") {
		pieces := strings.Split(strings.TrimSpace(part), "-")
		if len(pieces) > 2 {
			return false
		}
		numbers := []uint64{}
		for _, piece := range pieces {
			if piece == "" || strings.IndexFunc(piece, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
				return false
			}
			n, err := strconv.ParseUint(piece, 10, 16)
			if err != nil || n == 0 {
				return false
			}
			numbers = append(numbers, n)
		}
		if len(numbers) == 2 && numbers[0] > numbers[1] {
			return false
		}
	}
	return true
}
func proxyNativeSafe(v any, depth int, budget *int) bool {
	*budget--
	if depth > 24 || *budget < 0 {
		return false
	}
	switch value := v.(type) {
	case map[string]any:
		for raw, item := range value {
			key := strings.ReplaceAll(strings.ToLower(raw), "_", "-")
			if optionHas([]string{"dialer-proxy", "interface-name", "routing-mark", "detour", "bind-interface", "config-path", "ca", "ca-str", "client-cert", "client-key"}, key) || strings.HasSuffix(key, "-path") || strings.HasSuffix(key, "-file") {
				return false
			}
			if key == "insecure" || key == "skip-cert-verify" {
				if _, ok := item.(bool); !ok {
					return false
				}
			}
			if key == "certificate" || key == "private-key" {
				text, ok := item.(string)
				if !ok {
					return false
				}
				inline := strings.HasPrefix(text, "-----BEGIN ")
				if key == "private-key" && value["type"] == "wireguard" {
					b, e := base64.StdEncoding.Strict().DecodeString(text)
					inline = inline || (e == nil && len(b) == 32 && base64.StdEncoding.EncodeToString(b) == text)
				}
				if !inline {
					return false
				}
			}
			if !proxyNativeSafe(item, depth+1, budget) {
				return false
			}
		}
	case []any:
		if len(value) > 4096 {
			return false
		}
		for _, item := range value {
			if !proxyNativeSafe(item, depth+1, budget) {
				return false
			}
		}
	case string:
		if len(value) > 65536 || strings.ContainsRune(value, 0) {
			return false
		}
	case json.Number:
		if _, err := value.Float64(); err != nil {
			return false
		}
	case bool, nil:
	default:
		return false
	}
	return true
}
func proxyIsInsecure(v any) bool {
	switch value := v.(type) {
	case map[string]any:
		for raw, item := range value {
			key := strings.ReplaceAll(strings.ToLower(raw), "_", "-")
			if (key == "insecure" || key == "skip-cert-verify") && item == true || proxyIsInsecure(item) {
				return true
			}
		}
	case []any:
		for _, item := range value {
			if proxyIsInsecure(item) {
				return true
			}
		}
	}
	return false
}
func validNativeProxy(p map[string]any) bool {
	kind, _ := p["type"].(string)
	options, ok := nativeProxyOptions[kind]
	if !ok {
		return false
	}
	budget := 100000
	if !proxyNativeSafe(p, 0, &budget) {
		return false
	}
	for key := range p {
		if !optionHas(options, key) && !optionHas([]string{"type", "tfo", "mptcp", "ip-version", "smux"}, key) {
			return false
		}
	}
	name, _ := p["name"].(string)
	if !proxyOpaqueName.MatchString(name) {
		return false
	}
	_, peers := p["peers"]
	if kind != "wireguard" || !peers {
		host, _ := p["server"].(string)
		if host == "" || len(host) > 253 || strings.IndexFunc(host, func(r rune) bool {
			return unicode.IsSpace(r) || unicode.IsControl(r) || strings.ContainsRune("/@?#\\", r)
		}) >= 0 {
			return false
		}
		if (!proxyNumber(p["port"], 65535) || p["port"] == json.Number("0")) && !(kind == "mieru" && proxyRanges(p["port-range"])) {
			return false
		}
	}
	if kind == "hysteria2" {
		if udp, present := p["udp"]; present && udp != true {
			return false
		}
	}
	if kind == "ssh" {
		keys, ok := p["host-key"].([]any)
		if !ok || len(keys) == 0 {
			return false
		}
		for _, key := range keys {
			if text, ok := key.(string); !ok || text == "" {
				return false
			}
		}
	}
	if plugin, present := p["plugin"]; present {
		v, ok := plugin.(string)
		if !ok || !optionHas([]string{"obfs", "v2ray-plugin", "shadow-tls", "restls"}, v) {
			return false
		}
	}
	if ports, present := p["ports"]; present && !proxyRanges(ports) {
		return false
	}
	if ech, present := p["ech-opts"]; present && ech != nil {
		opts, ok := ech.(map[string]any)
		if !ok {
			return false
		}
		if query, present := opts["query-server-name"]; present {
			host, ok := query.(string)
			if !ok {
				return false
			}
			host = strings.TrimSuffix(host, ".")
			if host == "" || len(host) > 253 {
				return false
			}
			for _, label := range strings.Split(host, ".") {
				if label == "" || len(label) > 63 || strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") || strings.IndexFunc(label, func(r rune) bool {
					return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-')
				}) >= 0 {
					return false
				}
			}
		}
	}
	return true
}
func nativeGroupMembers(g map[string]any) ([]string, bool) {
	kind, _ := g["type"].(string)
	name, _ := g["name"].(string)
	if !proxyOpaqueName.MatchString(name) || !optionHas([]string{"select", "url-test", "fallback", "load-balance"}, kind) || g["empty-fallback"] != "REJECT" {
		return nil, false
	}
	allowed := []string{"name", "type", "proxies", "url", "interval", "timeout", "max-failed-times", "lazy", "disable-udp", "expected-status", "hidden", "icon", "tolerance", "strategy", "empty-fallback", "interrupt-exist-connections", "default-selected"}
	for key := range g {
		if !optionHas(allowed, key) {
			return nil, false
		}
	}
	if v, present := g["interrupt-exist-connections"]; present && v != false {
		return nil, false
	}
	raw, ok := g["proxies"].([]any)
	if !ok || len(raw) == 0 || len(raw) > 512 || kind == "select" && len(raw) != 1 {
		return nil, false
	}
	members := []string{}
	seen := map[string]bool{}
	for _, v := range raw {
		s, ok := v.(string)
		if !ok || seen[s] || !(proxyOpaqueName.MatchString(s) || s == "REJECT" || s == "REJECT-DROP") {
			return nil, false
		}
		members = append(members, s)
		seen[s] = true
	}
	if v, present := g["default-selected"]; present {
		s, ok := v.(string)
		if !ok || !seen[s] {
			return nil, false
		}
	}
	if v, present := g["url"]; present {
		raw, ok := v.(string)
		if !ok || len(raw) > 2048 || strings.IndexFunc(raw, unicode.IsControl) >= 0 {
			return nil, false
		}
		u, e := url.Parse(raw)
		if e != nil || u.Hostname() == "" || u.User != nil || strings.Contains(raw, "#") || !(u.Scheme == "http" || u.Scheme == "https") {
			return nil, false
		}
	}
	for _, key := range []string{"interval", "timeout", "max-failed-times", "tolerance"} {
		if v, present := g[key]; present && !proxyNumber(v, 120000) {
			return nil, false
		}
	}
	for _, key := range []string{"lazy", "hidden", "disable-udp"} {
		if v, present := g[key]; present {
			if _, ok := v.(bool); !ok {
				return nil, false
			}
		}
	}
	return members, true
}
func decodeProxyGraph(raw []byte) (*frozenProxyGraph, error) {
	if len(raw) > 512*1024 {
		return nil, errProxyEngine
	}
	var graph frozenProxyGraph
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	if decoder.Decode(&graph) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, errProxyEngine
	}
	count := len(graph.Proxies) + len(graph.Groups)
	if graph.Version != 1 || count == 0 || count > 512 || len(graph.Names) != count {
		return nil, errProxyEngine
	}
	edges := map[string][]string{}
	insecure := map[string]bool{}
	add := func(p map[string]any, members []string) bool {
		name, _ := p["name"].(string)
		if !proxyOpaqueName.MatchString(name) || !proxyShort(graph.Names[name]) {
			return false
		}
		if _, exists := edges[name]; exists {
			return false
		}
		edges[name] = members
		return true
	}
	for _, p := range graph.Proxies {
		if !validNativeProxy(p) || !add(p, nil) {
			return nil, errProxyEngine
		}
		if proxyIsInsecure(p) {
			insecure[p["name"].(string)] = true
		}
	}
	for _, g := range graph.Groups {
		members, ok := nativeGroupMembers(g)
		if !ok || !add(g, members) {
			return nil, errProxyEngine
		}
	}
	if len(graph.InsecureNames) != len(insecure) {
		return nil, errProxyEngine
	}
	for _, tag := range graph.InsecureNames {
		if !insecure[tag] {
			return nil, errProxyEngine
		}
		delete(insecure, tag)
	}
	active := map[string]bool{}
	depths := map[string]int{}
	var visit func(string, int) bool
	visit = func(name string, depth int) bool {
		if name == "REJECT" || name == "REJECT-DROP" {
			return true
		}
		members, exists := edges[name]
		if !exists || depth > 16 || active[name] {
			return false
		}
		if old, ok := depths[name]; ok && old >= depth {
			return true
		}
		active[name] = true
		for _, member := range members {
			if !visit(member, depth+1) {
				return false
			}
		}
		delete(active, name)
		depths[name] = depth
		return true
	}
	if !visit("account-node", 0) || len(depths) != count {
		return nil, errProxyEngine
	}
	return &graph, nil
}
