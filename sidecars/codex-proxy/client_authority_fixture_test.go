package main

import (
	"crypto/x509"
	"encoding/json"
	"flag"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// Test-only entry point for the Electron/Node authority integration. macOS
// platform roots ignore SSL_CERT_FILE, so this isolated child uses an explicit
// ephemeral fallback pool. No certificate or trust override is shipped.
func TestNativeAuthorityFixture(t *testing.T) {
	raw := os.Getenv("CML_AUTHORITY_FIXTURE_ARGS")
	if raw == "" {
		t.Skip("launched only by the Node authority integration")
	}
	var args []string
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		t.Fatal("invalid fixture arguments")
	}
	var configPath string
	for i, arg := range args {
		if arg == "-config" && i+1 < len(args) {
			configPath = args[i+1]
		}
	}
	if !filepath.IsAbs(configPath) {
		t.Fatal("fixture requires an absolute temporary config")
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Proxy string `json:"proxy-url"`
	}
	if json.Unmarshal(data, &config) != nil {
		t.Fatal("invalid fixture config")
	}
	proxy, err := url.Parse(config.Proxy)
	if err != nil || proxy.Scheme != "http" || proxy.Hostname() != "127.0.0.1" {
		t.Fatal("fixture requires a loopback proxy")
	}
	pem, err := os.ReadFile(os.Getenv("CML_AUTHORITY_FIXTURE_CERT"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		t.Fatal("invalid fixture root")
	}
	t.Setenv("GODEBUG", "x509usefallbackroots=1")
	x509.SetFallbackRoots(roots)
	flag.CommandLine = flag.NewFlagSet("authority-fixture", flag.ExitOnError)
	os.Args = append([]string{os.Args[0]}, args...)
	main()
}
