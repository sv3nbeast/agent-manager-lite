package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	internallogging "github.com/router-for-me/CLIProxyAPI/v7/internal/logging"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

func writeProviderImageSelectionError(c *gin.Context, err error, status int, message, code string) {
	var selectionErr *coreauth.Error
	if errors.As(err, &selectionErr) && selectionErr != nil && selectionErr.Code == "account_concurrency_exceeded" {
		// Saturation is temporary, not a missing route or rejected account.
		// Keep its stable code without exposing account-specific diagnostics.
		status = http.StatusTooManyRequests
		message = "image provider account concurrency limit reached; retry after active requests finish"
		code = selectionErr.Code
	}
	writeAPIError(c, status, message, code)
}

func (s *relayServer) providerImagesSelector() coreauth.Selector {
	s.imageProviderOnce.Do(func() {
		var tracker *requestUsageTracker
		if s.policy != nil {
			tracker = s.policy.tracker
		}
		base := &cockpitSelector{manifest: s.manifest, emitter: s.emitter, tracker: tracker, nativeProviderImages: true}
		if s.manifest != nil {
			base.locale = normalizeCockpitLocale(s.manifest.Locale)
		}
		// Images already bypass conversation affinity. Keep the shared quota,
		// account scope, model exclusions and concurrency wrappers intact.
		s.imageProviderSelector = buildCoreAuthSelectorWithConcurrency(nil, base, s.manifest, nil, tracker)
	})
	return s.imageProviderSelector
}

func (s *relayServer) selectAutomaticImageRoute(c *gin.Context, spec *apiKeySpec, input providerImageInput) (*modelRouteSpec, string, error) {
	if !automaticClientModelVisible(s.manifest, spec, input.model) {
		return nil, "", fmt.Errorf("image model is not available for this API key")
	}
	candidates := s.automaticCandidates(spec, input.model)
	auths := make([]*coreauth.Auth, 0, len(candidates))
	for _, candidate := range candidates {
		account := s.manifest.accountByID[candidate.route.ProviderAccountID]
		if providerImageModelAllowed(s.manifest, spec, input.model, candidate.upstream) &&
			providerImageAccountAllowed(c.Request.Context(), s.manifest, spec, account, candidate.auth, input.model, candidate.upstream) {
			auths = append(auths, candidate.auth)
		}
	}
	if len(auths) == 0 {
		return nil, "", fmt.Errorf("no provider image route is available")
	}
	selected, err := s.providerImagesSelector().Pick(c.Request.Context(), "codex", stripModelPrefix(input.model, spec), cliproxyexecutor.Options{Headers: c.Request.Header, OriginalRequest: input.body}, auths)
	if err != nil {
		return nil, "", err
	}
	if selected != nil {
		for _, candidate := range candidates {
			if candidate.auth.ID == selected.ID {
				account := s.manifest.accountByID[candidate.route.ProviderAccountID]
				if !providerImageAccountAllowed(c.Request.Context(), s.manifest, spec, account, candidate.auth, input.model, candidate.upstream) {
					return nil, "", fmt.Errorf("image provider account is no longer eligible")
				}
				s.recordProviderImageAccount(c, account, selected.ID)
				return candidate.route, candidate.upstream, nil
			}
		}
	}
	return nil, "", fmt.Errorf("no provider image route is available")
}

func (s *relayServer) admitProviderImageAccount(c *gin.Context, spec *apiKeySpec, route *modelRouteSpec, gateway *providerGatewaySpec, requested, upstream string) error {
	if s.manifest == nil {
		return nil
	}
	var account *accountSpec
	ctx := c.Request.Context()
	scopeSpec := spec
	if route != nil && route.ProviderAccountID != "" {
		account = s.manifest.accountByID[route.ProviderAccountID]
		if account == nil {
			return fmt.Errorf("image route account is not available")
		}
		// The explicit route is the key's authorization for this bound account.
		bound := *spec
		bound.AccountIDs = []string{route.ProviderAccountID}
		scopeSpec = &bound
		ctx = context.WithValue(ctx, clientAPIKeyContextKey, &bound)
	} else {
		account = s.manifest.accountByAPIKey[gateway.APIKey]
		if len(spec.AccountIDs) > 0 {
			account = nil
			for _, id := range spec.AccountIDs {
				candidate := s.manifest.accountByID[id]
				if candidate != nil && candidate.UpstreamAPIKey == gateway.APIKey {
					account = candidate
					break
				}
			}
			if account == nil {
				return fmt.Errorf("image provider account is outside this API key's scope")
			}
		}
	}
	// Older standalone manifests need not carry account metadata. Their local
	// key and provider model rules still govern access in the caller.
	if account == nil {
		return nil
	}
	auth := &coreauth.Auth{ID: "cockpit-provider:" + account.ID, Provider: "codex", Status: coreauth.StatusActive, Attributes: map[string]string{"account_id": account.ID}}
	if !providerImageAccountAllowed(ctx, s.manifest, scopeSpec, account, auth, requested, upstream) {
		return fmt.Errorf("image provider account is not eligible")
	}
	selected, err := s.providerImagesSelector().Pick(ctx, "codex", stripModelPrefix(requested, spec), cliproxyexecutor.Options{Headers: c.Request.Header}, []*coreauth.Auth{auth})
	if err != nil {
		return err
	}
	if selected == nil || !providerImageAccountAllowed(ctx, s.manifest, scopeSpec, account, auth, requested, upstream) {
		return fmt.Errorf("image provider account is unavailable")
	}
	s.recordProviderImageAccount(c, account, selected.ID)
	return nil
}

// The concurrency wait wrapper can reserve from its original input list after
// an initial full-slot result. Pass only fully admitted image candidates to it,
// and recheck the selected candidate before issuing any upstream operation.
func providerImageAccountAllowed(ctx context.Context, m *manifest, spec *apiKeySpec, account *accountSpec, auth *coreauth.Auth, requested, upstream string) bool {
	if account == nil || auth == nil || spec == nil || ctx.Err() != nil {
		return false
	}
	if len(spec.AccountIDs) > 0 {
		inScope := false
		for _, id := range spec.AccountIDs {
			inScope = inScope || strings.TrimSpace(id) == account.ID
		}
		if !inScope {
			return false
		}
	}
	if target, _ := ctx.Value(targetAccountIDContextKey).(string); target != "" && !authMatchesTargetAccount(auth, target, account) {
		return false
	}
	if strings.EqualFold(account.AuthKind, "api_key") {
		policy := strings.TrimSpace(account.ImageGenerationPolicy)
		if policy != "" && !strings.EqualFold(policy, "enabled") {
			return false
		}
	} else if !imageGenerationAllowedForAccount(account) {
		return false
	}
	if authModelExcluded(m, auth, stripModelPrefix(requested, spec)) || authModelExcluded(m, auth, upstream) {
		return false
	}
	now := time.Now()
	return !accountQuotaExhausted(m, account, now) && quotaReserveBlockReasonWithState(account, nil, now) == ""
}

func (s *relayServer) recordProviderImageAccount(c *gin.Context, account *accountSpec, authID string) {
	if s.policy != nil && s.policy.tracker != nil {
		s.policy.tracker.recordSelectedAccount(internallogging.GetRequestID(c.Request.Context()), account, strings.TrimSpace(authID))
	}
}
