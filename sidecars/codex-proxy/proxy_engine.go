package main

// Lifecycle/configuration adapted from Cockpit codex_proxy_engine.rs. Main
// validates share links and verifies the pinned binary. A dedicated supervisor
// owns the engine so losing Electron's stdin pipe also reaps its child.
import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var errProxyEngine = errors.New("proxy engine failed") // never expose config/stderr

type proxyEngineInput struct {
	Binary         string          `json:"binary"`
	Root           string          `json:"root"`
	Port           int             `json:"port"`
	Username       string          `json:"username"`
	Password       string          `json:"password"`
	ControllerPort int             `json:"controllerPort"`
	Secret         string          `json:"secret"`
	Proxy          json.RawMessage `json:"proxy"`
	Graph          json.RawMessage `json:"graph"`
}

func (v proxyEngineInput) valid() bool {
	if !filepath.IsAbs(v.Binary) || !filepath.IsAbs(v.Root) || v.Port < 1 || v.Port > 65535 || v.ControllerPort < 1 || v.ControllerPort > 65535 || v.Port == v.ControllerPort {
		return false
	}
	for _, s := range []string{v.Username, v.Password, v.Secret} {
		if len(s) < 32 || len(s) > 128 || strings.IndexFunc(s, func(r rune) bool { return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') }) >= 0 {
			return false
		}
	}
	_, _, err := v.parts()
	return err == nil
}

func (v proxyEngineInput) parts() ([]map[string]any, []map[string]any, error) {
	if len(v.Graph) > 0 {
		if len(v.Proxy) > 0 {
			return nil, nil, errProxyEngine
		}
		graph, err := decodeProxyGraph(v.Graph)
		if err != nil {
			return nil, nil, err
		}
		return graph.Proxies, graph.Groups, nil
	}
	var node map[string]any
	decoder := json.NewDecoder(bytes.NewReader(v.Proxy))
	decoder.UseNumber()
	if decoder.Decode(&node) != nil || decoder.Decode(new(any)) != io.EOF || node["name"] != "account-node" || !validNativeProxy(node) || proxyIsInsecure(node) {
		return nil, nil, errProxyEngine
	}
	return []map[string]any{node}, []map[string]any{}, nil
}

func (v proxyEngineInput) config() ([]byte, error) {
	proxies, groups, err := v.parts()
	if err != nil {
		return nil, err
	}
	if proxies == nil {
		proxies = []map[string]any{}
	}
	if groups == nil {
		groups = []map[string]any{}
	}
	return json.Marshal(map[string]any{
		"mixed-port": v.Port, "bind-address": "127.0.0.1", "allow-lan": false,
		"authentication": []string{v.Username + ":" + v.Password}, "skip-auth-prefixes": []string{},
		"external-controller": fmt.Sprintf("127.0.0.1:%d", v.ControllerPort), "secret": v.Secret,
		"external-controller-cors": map[string]any{"allow-origins": []string{"https://codex-manager.invalid"}, "allow-private-network": false},
		"mode":                     "rule", "log-level": "silent", "ipv6": true,
		"find-process-mode": "off", "geo-auto-update": false,
		"profile": map[string]bool{"store-selected": false, "store-fake-ip": false},
		"tun":     map[string]bool{"enable": false}, "sniffer": map[string]bool{"enable": false}, "dns": map[string]bool{"enable": false},
		"proxies": proxies, "proxy-groups": groups, "rules": []string{"MATCH,account-node"},
	})
}

// A listening port is insufficient: an unrelated process may have won the
// allocation race. Authenticate against this launch's random SOCKS credential.
func authenticateProxyEngine(ctx context.Context, v proxyEngineInput) error {
	c, err := (&net.Dialer{Timeout: 250 * time.Millisecond}).DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", v.Port))
	if err != nil {
		return err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(250 * time.Millisecond))
	if _, err = c.Write([]byte{5, 1, 2}); err != nil {
		return err
	}
	var reply [2]byte
	if _, err = io.ReadFull(c, reply[:]); err != nil || reply != [2]byte{5, 2} {
		return errProxyEngine
	}
	request := append([]byte{1, byte(len(v.Username))}, []byte(v.Username)...)
	request = append(request, byte(len(v.Password)))
	request = append(request, []byte(v.Password)...)
	if _, err = c.Write(request); err != nil {
		return err
	}
	if _, err = io.ReadFull(c, reply[:]); err != nil || reply != [2]byte{1, 0} {
		return errProxyEngine
	}
	return nil
}

func runProxyEngine(parent context.Context, input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	reader := bufio.NewReaderSize(input, 1024*1024+1)
	type frame struct {
		data []byte
		err  error
	}
	frames := make(chan frame, 1)
	go func() { data, err := reader.ReadSlice('\n'); frames <- frame{data, err} }()
	var initial frame
	select {
	case initial = <-frames:
	case <-ctx.Done():
		return errProxyEngine
	case <-time.After(5 * time.Second):
		return errProxyEngine
	}
	if initial.err != nil || len(initial.data) > 1024*1024 {
		return errProxyEngine
	}
	var v proxyEngineInput
	decoder := json.NewDecoder(bytes.NewReader(initial.data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&v) != nil || !v.valid() {
		return errProxyEngine
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return errProxyEngine
	}
	// No further messages are legal. EOF, extra bytes or a read error all close
	// the lifetime pipe; no credentials are written to files or process arguments.
	go func() { var b [1]byte; _, _ = reader.Read(b[:]); cancel() }()
	if info, err := os.Lstat(v.Binary); err != nil || !info.Mode().IsRegular() {
		return errProxyEngine
	}
	if os.MkdirAll(v.Root, 0700) != nil {
		return errProxyEngine
	}
	if info, err := os.Lstat(v.Root); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errProxyEngine
	}
	if os.Chmod(v.Root, 0700) != nil {
		return errProxyEngine
	}
	directory, err := os.MkdirTemp(v.Root, "tunnel-")
	if err != nil {
		return errProxyEngine
	}
	defer os.RemoveAll(directory)
	config, err := v.config()
	if err != nil {
		return errProxyEngine
	}
	cmd := exec.Command(v.Binary, "-f", "-", "-d", directory)
	cmd.Dir = directory
	cmd.Stdin = bytes.NewReader(config)
	cmd.Env = []string{"PATH=/usr/bin:/bin"}
	if runtime.GOOS == "windows" {
		cmd.Env = []string{"SystemRoot=" + os.Getenv("SystemRoot")}
	}
	// exec's nil output streams point to the null device (no unbounded buffers).
	if ctx.Err() != nil || cmd.Start() != nil {
		return errProxyEngine
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	finished := false
	defer func() {
		if !finished {
			_ = cmd.Process.Signal(os.Interrupt)
			select {
			case <-exited:
			case <-time.After(2 * time.Second):
				_ = cmd.Process.Kill()
				<-exited
			}
		}
	}()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	ready := false
	for !ready {
		select {
		case <-ctx.Done():
			return errProxyEngine
		case <-deadline.C:
			return errProxyEngine
		case <-exited:
			finished = true
			return errProxyEngine
		case <-tick.C:
			ready = authenticateProxyEngine(ctx, v) == nil
		}
	}
	if ctx.Err() != nil {
		return errProxyEngine
	}
	if json.NewEncoder(output).Encode(map[string]any{"type": "ready", "pid": cmd.Process.Pid}) != nil {
		return errProxyEngine
	}
	select {
	case <-ctx.Done():
		return nil
	case <-exited:
		finished = true
		return errProxyEngine
	}
}
