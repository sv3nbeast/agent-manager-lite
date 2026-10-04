package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
)

func TestOfflineCatalogValidation(t *testing.T) {
	var output bytes.Buffer
	if err := runModelCatalogValidation(bytes.NewReader(registry.GetCodexClientModelsJSON()), &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "{\"valid\":true}\n" {
		t.Fatalf("unexpected helper response: %q", output.String())
	}
	for _, source := range []string{`{"models":[]}`, `{"private":"fixture-secret"}`, strings.Repeat("x", 16*1024*1024+1)} {
		output.Reset()
		if err := runModelCatalogValidation(strings.NewReader(source), &output); err == nil || output.Len() != 0 || strings.Contains(err.Error(), "fixture-secret") {
			t.Fatal("invalid catalog was accepted or leaked input")
		}
	}
}
