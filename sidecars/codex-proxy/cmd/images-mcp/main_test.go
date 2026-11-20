package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="

func fixture(t *testing.T, url string) (string, func(string)) {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.json")
	write := func(model string) {
		data, _ := json.Marshal(config{BaseURL: url, APIKey: "fixture-secret", Model: model, OutputDir: filepath.Join(dir, "images"), HTTPTimeout: 10, ToolTimeout: 15})
		// The manager uses atomic replacement while the MCP process stays alive.
		temp := path + ".tmp"
		if err := os.WriteFile(temp, data, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(temp, path); err != nil {
			t.Fatal(err)
		}
	}
	write("configured/image-v1")
	return path, write
}

func TestStdioReloadsModelWithoutRestartAndHonorsExplicitOverride(t *testing.T) {
	models := make(chan string, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/generations" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer fixture-secret" {
			t.Error("wrong Images API request")
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid body")
		}
		models <- body["model"].(string)
		fmt.Fprintf(w, `{"data":[{"b64_json":%q}]}`, testPNG)
	}))
	defer server.Close()
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	path, write := fixture(t, server.URL+"/v1/")
	inReader, inWriter := io.Pipe()
	outReader, outWriter := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- serve(path, inReader, outWriter); outWriter.Close() }()
	reader := bufio.NewReader(outReader)
	rpc := func(id int, method string, params string) string {
		t.Helper()
		fmt.Fprintf(inWriter, `{"jsonrpc":"2.0","id":%d,"method":%q,"params":%s}`+"\n", id, method, params)
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		return line
	}
	init := rpc(1, "initialize", `{"protocolVersion":"2025-06-18"}`)
	if !strings.Contains(init, `"name":"images-api"`) {
		t.Fatal(init)
	}
	list := rpc(2, "tools/list", `{}`)
	if !strings.Contains(list, `"name":"imagegen"`) || strings.Contains(list, "configured/image-v1") {
		t.Fatal("schema must not freeze the configured model")
	}
	for index, want := range []string{"configured/image-v1", "future/image-v2", "explicit/image-v3"} {
		args := `{"name":"imagegen","arguments":{"prompt":"test"}}`
		if index == 1 {
			write(want)
		}
		if index == 2 {
			args = `{"name":"imagegen","arguments":{"prompt":"test","model":"explicit/image-v3"}}`
		}
		result := rpc(index+3, "tools/call", args)
		if strings.Contains(result, `"isError":true`) || !strings.Contains(result, `"type":"image"`) {
			t.Fatal(result)
		}
		if got := <-models; got != want {
			t.Fatalf("got %s want %s", got, want)
		}
		if strings.Contains(result, "fixture-secret") {
			t.Fatal("secret exposed")
		}
	}
	inWriter.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(filepath.Dir(path), "images"))
	if err != nil || len(entries) != 3 {
		t.Fatalf("missing image files: %v", err)
	}
	for _, entry := range entries {
		stat, _ := entry.Info()
		if stat.Mode().Perm() != 0600 {
			t.Fatal("image must be private")
		}
	}
}

func TestSafeHTTPFailuresAndNoRedirectOrAutomaticPaidRetry(t *testing.T) {
	for _, status := range []int{302, 401, 403, 429, 502, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Location", "https://redirect.invalid/secret")
				w.WriteHeader(status)
				fmt.Fprint(w, `private-upstream-body fixture-secret`)
			}))
			defer server.Close()
			path, _ := fixture(t, server.URL)
			_, err := generate(context.Background(), path, map[string]any{"prompt": "test"})
			if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("HTTP %d", status)) || strings.Contains(err.Error(), "fixture-secret") || strings.Contains(err.Error(), "private-upstream-body") {
				t.Fatalf("unsafe error: %v", err)
			}
			if calls.Load() != 1 {
				t.Fatalf("unexpected retry: %d", calls.Load())
			}
		})
	}
}

func TestConfigPermissionsAndInvalidResponseDoNotProduceFiles(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, `{"data":[{"url":"https://other.invalid/image.png"}]}`)
	}))
	defer server.Close()
	path, _ := fixture(t, server.URL)
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := generate(context.Background(), path, map[string]any{"prompt": "test"}); err == nil {
		t.Fatal("public credentials accepted")
	}
	if calls.Load() != 0 {
		t.Fatal("network request before config validation")
	}
	os.Chmod(path, 0600)
	if _, err := generate(context.Background(), path, map[string]any{"prompt": "test"}); err == nil || !strings.Contains(err.Error(), "b64_json") {
		t.Fatalf("unexpected result: %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), "images")); !os.IsNotExist(err) {
		t.Fatal("failed request created output directory")
	}
	link := path + "-link"
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readConfig(link); err == nil {
		t.Fatal("symlink accepted")
	}
}

func TestCancellationStopsRequestAndReleasesServer(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer server.Close()
	path, _ := fixture(t, server.URL)
	inReader, inWriter := io.Pipe()
	outReader, outWriter := io.Pipe()
	defer outReader.Close()
	done := make(chan error, 1)
	go func() { done <- serve(path, inReader, outWriter); outWriter.Close() }()
	fmt.Fprintln(inWriter, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"imagegen","arguments":{"prompt":"test"}}}`)
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("request did not start")
	}
	fmt.Fprintln(inWriter, `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}`)
	line, err := bufio.NewReader(outReader).ReadString('\n')
	if err != nil || !strings.Contains(line, `"isError":true`) {
		t.Fatalf("no cancellation result: %s %v", line, err)
	}
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream request not cancelled")
	}
	inWriter.Close()
	<-done
}

func TestEndpointAndInputValidation(t *testing.T) {
	for _, base := range []string{"https://compatible.invalid", "https://compatible.invalid/v1/", "http://127.0.0.1:1234/v1", "http://external.invalid"} {
		if _, err := endpoint(base); err != nil {
			t.Fatal(err)
		}
	}
	for _, base := range []string{"file://external.invalid", "https://user:secret@compatible.invalid", "https://compatible.invalid/?key=secret", "https://compatible.invalid/other/v1"} {
		if _, err := endpoint(base); err == nil {
			t.Fatalf("accepted %s", base)
		}
	}
	if !validModel("provider/future-image:preview") || validModel("two models") || validModel("bad\nmodel") {
		t.Fatal("model validation mismatch")
	}
}
