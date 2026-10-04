package main

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

// Only the parent application's internal key can reload existing credential
// projections. Callers cannot supply a path, enroll an account, or change scope.
func (s *relayServer) handleReloadManagedCredentials(c *gin.Context) {
	spec, ok := s.requireAPIKey(c)
	if !ok {
		return
	}
	if !spec.Internal {
		writeAPIError(c, http.StatusForbidden, "internal management key required", "forbidden")
		return
	}
	runtime, ok := s.runtime.(interface {
		ReloadManagedCredentials(context.Context, []string) error
	})
	if !ok {
		writeAPIError(c, http.StatusServiceUnavailable, "credential reload unavailable", "service_unavailable")
		return
	}
	var req resetAuthStateRequest
	if c.ShouldBindJSON(&req) != nil || len(req.AccountIDs) == 0 || len(req.AccountIDs) > 1000 {
		writeAPIError(c, http.StatusBadRequest, "accountIds is required", "invalid_request")
		return
	}
	ids := normalizeStringList(req.AccountIDs)
	for _, id := range ids {
		if !stringSliceContainsFold(spec.AccountIDs, id) {
			writeAPIError(c, http.StatusForbidden, "account outside key scope", "forbidden")
			return
		}
	}
	if err := runtime.ReloadManagedCredentials(c.Request.Context(), ids); err != nil {
		writeAPIError(c, http.StatusConflict, "credential projection could not be applied", "credential_reload_failed")
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "reloaded": len(ids)})
}

func (r *sidecarRuntime) ReloadManagedCredentials(ctx context.Context, ids []string) error {
	if r == nil || r.cfg == nil || r.manifest == nil || r.service == nil {
		return fmt.Errorf("runtime unavailable")
	}
	r.reloadMu.Lock()
	defer r.reloadMu.Unlock()
	prepared := make([]*coreauth.Auth, 0, len(ids))
	for _, id := range ids {
		account := r.manifest.accountByID[strings.TrimSpace(id)]
		if account == nil || account.AuthID == "" || manifestAccountAuthKind(account) == "api_key" {
			return fmt.Errorf("account unavailable")
		}
		path := account.AuthID
		if !filepath.IsAbs(path) {
			path = filepath.Join(r.cfg.AuthDir, path)
		}
		auth, err := readManifestCodexTokenAuth(account, r.cfg.AuthDir, path)
		if err != nil {
			return err
		}
		previous, exists := r.manager.GetByID(auth.ID)
		if !exists || previous == nil || previous.Provider != auth.Provider {
			return fmt.Errorf("existing auth required")
		}
		// Account ID in a rotated token projection must stay bound to its manifest.
		if account.ChatGPTAccountID != "" && metadataString(auth.Metadata, "account_id") != account.ChatGPTAccountID {
			return fmt.Errorf("identity mismatch")
		}
		prepared = append(prepared, auth)
	}
	for _, auth := range prepared {
		if _, err := r.service.UpsertRuntimeAuth(coreauth.WithSkipPersist(ctx), auth); err != nil {
			return err
		}
		registerManifestModelsForAuth(r.manager, r.manifest, auth)
	}
	return nil
}
