package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

func TestRoutingObservationsUpdateWithoutMutatingManifest(t *testing.T) {
	quotaA, quotaB := 20, 80
	a, b := &accountSpec{ID: "a", AuthID: "a.json", RemainingQuota: &quotaA}, &accountSpec{ID: "b", AuthID: "b.json", RemainingQuota: &quotaB}
	m := &manifest{Accounts: []accountSpec{*a, *b}, accountByID: map[string]*accountSpec{"a": a, "b": b}, accountByAuthID: map[string]*accountSpec{"a.json": a, "b.json": b}, RoutingStrategy: "quota_high_first"}
	path := filepath.Join(t.TempDir(), "quota-pool-state.json")
	m.quotaCooldowns = newQuotaCooldownStateStore(path, m)
	selector := &cockpitSelector{manifest: m}
	auths := []*coreauth.Auth{{ID: "a.json", Provider: "codex", Status: coreauth.StatusActive}, {ID: "b.json", Provider: "codex", Status: coreauth.StatusActive}}
	pick := func() string {
		selected, err := selector.Pick(context.Background(), "codex", "gpt-5.5", cliproxyexecutor.Options{}, auths)
		if err != nil {
			t.Error(err)
			return ""
		}
		return selected.ID
	}
	if pick() != "b.json" {
		t.Fatal("initial manifest quota ignored")
	}
	write := func(observed int64, quota int) {
		t.Helper()
		body := fmt.Sprintf(`{"accounts":{"a":{"routingUpdatedAtMs":%d,"remainingQuota":%d,"planRank":700,"subscriptionExpiryMs":1000},"foreign":{"routingUpdatedAtMs":999999,"remainingQuota":100}}}`, observed, quota)
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if err := m.quotaCooldowns.load(); err != nil {
			t.Fatal(err)
		}
	}
	write(2000, 90)
	if pick() != "a.json" {
		t.Fatal("fresh quota did not reorder selection")
	}
	if *a.RemainingQuota != 20 || a.PlanRank != nil {
		t.Fatal("live updates mutated the shared manifest")
	}
	if _, ok := m.quotaCooldowns.routingAccounts()["foreign"]; ok {
		t.Fatal("foreign routing observation accepted")
	}
	write(1000, 1)
	if pick() != "a.json" {
		t.Fatal("stale update overwrote newer routing observation")
	}
	if err := os.WriteFile(path, []byte(`{"accounts":`), 0600); err != nil {
		t.Fatal(err)
	}
	if m.quotaCooldowns.load() == nil {
		t.Fatal("corrupt snapshot should be rejected")
	}
	if pick() != "a.json" {
		t.Fatal("corrupt update discarded last good observation")
	}
	// Readers must see immutable snapshots while the watcher publishes updates.
	var workers sync.WaitGroup
	for i := 0; i < 4; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for j := 0; j < 100; j++ {
				id := pick()
				if id != "a.json" && id != "b.json" {
					t.Errorf("invalid selection %q", id)
				}
			}
		}()
	}
	for i := 0; i < 30; i++ {
		write(int64(3000+i), 10+(i%2)*80)
	}
	workers.Wait()
	m.RoutingStrategy = "plan_high_first"
	if pick() != "a.json" {
		t.Fatal("live plan rank did not apply")
	}
	m.RoutingStrategy = "expiry_soon_first"
	if pick() != "a.json" {
		t.Fatal("live subscription expiry did not apply")
	}
}
