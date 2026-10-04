package executor

import (
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor/helps"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
)

func applyManagedServiceTier(body, original []byte, auth *coreauth.Auth) []byte {
	if auth == nil {
		return body
	}
	tier, _ := auth.Metadata["cml_default_service_tier"].(string)
	return helps.ApplyManagedServiceTier(body, original, tier)
}
