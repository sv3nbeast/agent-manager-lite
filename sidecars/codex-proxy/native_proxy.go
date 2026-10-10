package main

// This bridge carries native clients' HTTP and CONNECT traffic without changing
// account authentication or decrypting TLS. Only its credential-free loopback
// address reaches client arguments/environment; upstream secrets stay on stdin.
import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
	"golang.org/x/net/proxy"
)

const nativeProxyInputLimit = 8 * 1024

var errNativeProxy = errors.New("native proxy failed")

type nativeProxyInput struct {
	Proxy string `json:"proxy"`
}

func validNativeProxyURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.Opaque != "" || u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	switch u.Scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return false
		}
	} else if u.Scheme == "socks5" || u.Scheme == "socks5h" || strings.HasSuffix(u.Host, ":") {
		return false
	}
	if strings.IndexFunc(raw, func(r rune) bool { return r <= ' ' || r == 127 }) >= 0 {
		return false
	}
	if u.User != nil {
		password, _ := u.User.Password()
		if strings.IndexFunc(u.User.Username()+password, func(r rune) bool { return r < ' ' || r == 127 }) >= 0 {
			return false
		}
	}
	return true
}

// http.Server.Close deliberately leaves hijacked connections open. Track both
// sides, including upgrade sockets and transport dials, so losing the owner pipe
// closes every active stream and cannot leave an orphaned proxy behind.
type nativeProxyConnections struct {
	mu     sync.Mutex
	closed bool
	all    map[*nativeProxyConnection]struct{}
}

type nativeProxyConnection struct {
	net.Conn
	owner *nativeProxyConnections
	once  sync.Once
}

func (c *nativeProxyConnection) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() {
		c.owner.mu.Lock()
		delete(c.owner.all, c)
		c.owner.mu.Unlock()
	})
	return err
}

func (p *nativeProxyConnections) track(conn net.Conn) (net.Conn, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		_ = conn.Close()
		return nil, errNativeProxy
	}
	tracked := &nativeProxyConnection{Conn: conn, owner: p}
	if p.all == nil {
		p.all = make(map[*nativeProxyConnection]struct{})
	}
	p.all[tracked] = struct{}{}
	p.mu.Unlock()
	return tracked, nil
}

func (p *nativeProxyConnections) close() {
	p.mu.Lock()
	p.closed = true
	all := make([]*nativeProxyConnection, 0, len(p.all))
	for c := range p.all {
		all = append(all, c)
	}
	p.mu.Unlock()
	for _, c := range all {
		_ = c.Close()
	}
}

type nativeProxyListener struct {
	net.Listener
	connections *nativeProxyConnections
}

func (l nativeProxyListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return l.connections.track(conn)
}

func nativeProxyDestination(authority string) bool {
	host, port, err := net.SplitHostPort(authority)
	if err != nil || host == "" || strings.ContainsAny(host, "/\\@?# \t\r\n") {
		return false
	}
	n, err := strconv.Atoi(port)
	return err == nil && n > 0 && n <= 65535
}

func nativeProxyFailure(w http.ResponseWriter, status int) {
	http.Error(w, "native proxy request failed", status)
}

func nativeProxyHandler(ctx context.Context, raw string, connections *nativeProxyConnections) (http.Handler, func(), error) {
	if !validNativeProxyURL(raw) {
		return nil, nil, errNativeProxy
	}
	transport, mode, err := proxyutil.BuildHTTPTransport(raw)
	if err != nil || mode != proxyutil.ModeProxy || transport == nil {
		return nil, nil, errNativeProxy
	}
	dialer, mode, err := proxyutil.BuildDialer(raw)
	contextDialer, ok := dialer.(proxy.ContextDialer)
	if err != nil || mode != proxyutil.ModeProxy || !ok {
		transport.CloseIdleConnections()
		return nil, nil, errNativeProxy
	}
	// Transport can detach a reusable dial from an individual request's context.
	// Tie every dial to the instance lifetime and track TLS handshake sockets too.
	dialContext := transport.DialContext
	if dialContext == nil {
		dialContext = (&net.Dialer{Timeout: 30 * time.Second}).DialContext
	}
	transport.DialContext = func(requestContext context.Context, network, address string) (net.Conn, error) {
		dialCtx, cancel := context.WithTimeout(requestContext, 30*time.Second)
		stop := context.AfterFunc(ctx, cancel)
		defer stop()
		defer cancel()
		conn, err := dialContext(dialCtx, network, address)
		if err != nil {
			return nil, errNativeProxy
		}
		return connections.track(conn)
	}
	transport.MaxResponseHeaderBytes = 64 * 1024
	transport.ResponseHeaderTimeout = 60 * time.Second
	transport.DisableCompression = true
	forward := &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(request *httputil.ProxyRequest) {
			// Preserve the native destination and authentication, without appending
			// forwarding metadata or accepting credentials for this local bridge.
			request.Out.Host = request.In.Host
			request.Out.Header.Del("Proxy-Authorization")
		},
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			nativeProxyFailure(w, http.StatusBadGateway)
		},
		ModifyResponse: func(response *http.Response) error {
			if response.StatusCode == http.StatusProxyAuthRequired {
				return errNativeProxy
			}
			return nil
		},
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodConnect {
			// Origin-form requests (such as a web page accessing localhost) do not
			// have proxy semantics and must never become forwarding requests.
			if !request.URL.IsAbs() || request.URL.Hostname() == "" || request.URL.User != nil || request.URL.Fragment != "" || request.URL.Scheme != "http" && request.URL.Scheme != "https" {
				nativeProxyFailure(w, http.StatusBadRequest)
				return
			}
			forward.ServeHTTP(w, request)
			return
		}
		if !nativeProxyDestination(request.Host) || request.URL.Host != request.Host {
			nativeProxyFailure(w, http.StatusBadRequest)
			return
		}
		dialCtx, cancel := context.WithTimeout(request.Context(), 30*time.Second)
		remote, err := contextDialer.DialContext(dialCtx, "tcp", request.Host)
		cancel()
		if err != nil {
			nativeProxyFailure(w, http.StatusBadGateway)
			return
		}
		remote, err = connections.track(remote)
		if err != nil {
			nativeProxyFailure(w, http.StatusBadGateway)
			return
		}
		defer remote.Close()
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			nativeProxyFailure(w, http.StatusInternalServerError)
			return
		}
		client, buffered, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer client.Close()
		if _, err = buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil || buffered.Flush() != nil {
			return
		}
		done := make(chan struct{}, 2)
		go func() { _, _ = io.Copy(remote, buffered); done <- struct{}{} }()
		go func() { _, _ = io.Copy(client, remote); done <- struct{}{} }()
		<-done
		_ = remote.Close()
		_ = client.Close()
		<-done
	})
	return handler, transport.CloseIdleConnections, nil
}

func runNativeProxy(parent context.Context, input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	if closer, ok := input.(io.Closer); ok {
		defer closer.Close()
	}
	reader := bufio.NewReaderSize(input, nativeProxyInputLimit+1)
	type frame struct {
		data []byte
		err  error
	}
	frames := make(chan frame, 1)
	go func() { data, err := reader.ReadSlice('\n'); frames <- frame{data, err} }()
	var initial frame
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case initial = <-frames:
	case <-ctx.Done():
		return errNativeProxy
	case <-timer.C:
		return errNativeProxy
	}
	if initial.err != nil || len(initial.data) > nativeProxyInputLimit {
		return errNativeProxy
	}
	var value nativeProxyInput
	decoder := json.NewDecoder(bytes.NewReader(initial.data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil || decoder.Decode(new(any)) != io.EOF {
		return errNativeProxy
	}
	connections := &nativeProxyConnections{}
	defer connections.close()
	handler, closeTransport, err := nativeProxyHandler(ctx, value.Proxy, connections)
	if err != nil {
		return errNativeProxy
	}
	defer closeTransport()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return errNativeProxy
	}
	defer listener.Close()
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    32 * 1024,
		ErrorLog:          log.New(io.Discard, "", 0),
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	defer server.Close()
	serving := make(chan error, 1)
	go func() { serving <- server.Serve(nativeProxyListener{Listener: listener, connections: connections}) }()
	// EOF, extra messages and pipe errors all end the lease. There is no fallback
	// route, persistent credential file or child which can survive this owner.
	go func() { var trailing [1]byte; _, _ = reader.Read(trailing[:]); cancel() }()
	if ctx.Err() != nil {
		return nil
	}
	if json.NewEncoder(output).Encode(map[string]string{"type": "ready", "url": "http://" + listener.Addr().String()}) != nil {
		return errNativeProxy
	}
	select {
	case <-ctx.Done():
		return nil
	case <-serving:
		return errNativeProxy
	}
}
