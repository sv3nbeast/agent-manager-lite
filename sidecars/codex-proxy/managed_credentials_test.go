package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
)

func TestManagedCredentialReloadAppliesOnlyScopedExistingIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	root := t.TempDir()
	authDir := filepath.Join(root, "auth")
	if err := os.MkdirAll(authDir, 0700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, "config.json")
	if err := os.WriteFile(configPath, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(authDir, "test-auth.json")
	write := func(token, identity string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(fmt.Sprintf(`{"type":"codex","access_token":%q,"account_id":%q}`, token, identity)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("old-token-fixture", "chat-account")
	account := &accountSpec{ID: "account-one", AuthID: "test-auth.json", AuthKind: "oauth", ChatGPTAccountID: "chat-account"}
	internal := &apiKeySpec{ID: "control", Key: "control-fixture", Enabled: true, Internal: true, AccountIDs: []string{account.ID}}
	public := &apiKeySpec{ID: "public", Key: "public-fixture", Enabled: true, AccountIDs: []string{account.ID}}
	m := &manifest{Accounts: []accountSpec{*account}, accountByID: map[string]*accountSpec{account.ID: account}, accountByAuthID: map[string]*accountSpec{account.AuthID: account}, apiKeyByValue: map[string]*apiKeySpec{internal.Key: internal, public.Key: public}, ModelIDs: []string{"gpt-5.5"}}
	cfg := &config.Config{AuthDir: authDir}
	manager := buildCoreAuthManager(cfg, &cockpitSelector{manifest: m}, &authHook{manifest: m}, m, nil, newRequestUsageTracker())
	runtime, err := newSidecarRuntime(context.Background(), configPath, cfg, m, manager)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Stop()
	router := (&relayServer{runtime: runtime, cfg: cfg, manifest: m, policy: &requestPolicy{manifest: m}}).router()
	call := func(key, body string) int {
		req := httptest.NewRequest(http.MethodPost, "/v1/cockpit/auth/reload", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+key)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res.Code
	}
	write("new-token-fixture", "chat-account")
	if status := call(public.Key, `{"accountIds":["account-one"]}`); status != 403 {
		t.Fatalf("public key status=%d", status)
	}
	if status := call(internal.Key, `{"accountIds":["outside-scope"]}`); status != 403 {
		t.Fatalf("scope status=%d", status)
	}
	auth, _ := manager.GetByID(account.AuthID)
	if auth.Metadata["access_token"] != "old-token-fixture" {
		t.Fatal("unauthorized reload mutated auth")
	}
	if status := call(internal.Key, `{"accountIds":["account-one"]}`); status != 200 {
		t.Fatalf("reload status=%d", status)
	}
	auth, _ = manager.GetByID(account.AuthID)
	if auth.Metadata["access_token"] != "new-token-fixture" {
		t.Fatal("new token was not applied to runtime")
	}
	write("wrong-identity-token", "another-chat-account")
	if status := call(internal.Key, `{"accountIds":["account-one"]}`); status != 409 {
		t.Fatalf("identity status=%d", status)
	}
	auth, _ = manager.GetByID(account.AuthID)
	if auth.Metadata["access_token"] != "new-token-fixture" {
		t.Fatal("identity mismatch replaced token")
	}
}
