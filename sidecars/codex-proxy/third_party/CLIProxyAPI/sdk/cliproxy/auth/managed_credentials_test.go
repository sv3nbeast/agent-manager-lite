package auth

import (
	"context"
	"testing"
)

func TestDesktopCredentialAuthorityPreventsStaleGenericPersistence(t *testing.T) {
	store := &countingStore{}
	manager := NewManager(store, nil, nil)
	for _, mode := range []string{"oauth", "agentIdentity"} {
		auth := &Auth{ID: mode, Provider: "codex", Metadata: map[string]any{"refresh_owner": "codex_manager_lite", "auth_mode": mode, "task_id": "stale-task", "access_token": "stale-token"}}
		if err := manager.persist(context.Background(), auth); err != nil {
			t.Fatal(err)
		}
	}
	if store.saveCount.Load() != 0 {
		t.Fatal("generic persistence overwrote desktop-owned credentials")
	}
	unmanaged := &Auth{ID: "ordinary", Provider: "codex", Metadata: map[string]any{"access_token": "ordinary-token"}}
	if err := manager.persist(context.Background(), unmanaged); err != nil {
		t.Fatal(err)
	}
	if store.saveCount.Load() != 1 {
		t.Fatal("unmanaged credential persistence changed")
	}
}
