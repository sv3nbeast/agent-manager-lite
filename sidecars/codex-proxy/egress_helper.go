package main

// Bounded account HTTP helper. Shares the sidecar's HTTP/SOCKS transport and
// receives credentials only over stdin; no URL or secret is printed on errors.
import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

const egressInputLimit = 1024 * 1024
const egressOutputLimit = 2 * 1024 * 1024

type egressInput struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	Proxy   string            `json:"proxy"`
}
type egressOutput struct {
	Status int    `json:"status,omitempty"`
	Body   []byte `json:"body,omitempty"`
	Error  string `json:"error,omitempty"`
}

func egressRequest(ctx context.Context, input egressInput) egressOutput {
	invalid := egressOutput{Error: "invalid"}
	target, err := url.Parse(input.URL)
	if err != nil || target.Hostname() == "" || target.User != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Fragment != "" {
		return invalid
	}
	if input.Method != "GET" && input.Method != "POST" {
		return invalid
	}
	transport, mode, err := proxyutil.BuildHTTPTransport(input.Proxy)
	if err != nil || transport == nil || (mode != proxyutil.ModeDirect && mode != proxyutil.ModeProxy) {
		return invalid
	}
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, input.Method, input.URL, strings.NewReader(input.Body))
	if err != nil {
		return invalid
	}
	for key, value := range input.Headers {
		switch strings.ToLower(key) {
		case "authorization", "content-type", "accept", "user-agent", "originator", "chatgpt-account-id", "referer", "x-openai-target-path", "x-openai-target-route", "x-openai-fedramp":
			request.Header.Set(key, value)
		default:
			return invalid
		}
	}
	client := &http.Client{Transport: transport, Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return egressOutput{Error: "network"}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, egressOutputLimit+1))
	if err != nil || len(body) > egressOutputLimit {
		return egressOutput{Error: "response"}
	}
	return egressOutput{Status: response.StatusCode, Body: body}
}
func runEgressHelper(ctx context.Context, input io.Reader, output io.Writer) error {
	raw, err := io.ReadAll(io.LimitReader(input, egressInputLimit+1))
	if err != nil || len(raw) > egressInputLimit {
		return errors.New("invalid request")
	}
	var value egressInput
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil || decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid request")
	}
	return json.NewEncoder(output).Encode(egressRequest(ctx, value))
}
