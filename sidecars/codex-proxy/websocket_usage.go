package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sync"

	coreusage "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/usage"
)

type websocketUsageKey struct{}

var websocketUsageContextKey websocketUsageKey

// Owned by the request context, so queued callbacks remain valid after the
// socket closes without retaining connection state in the global tracker.
type websocketUsageSink struct {
	mu           sync.Mutex
	connectionID string
	seen         map[string]struct{}
	emit         func(usagePayload)
}

func newWebsocketUsageSink(id string, emit func(usagePayload)) *websocketUsageSink {
	return &websocketUsageSink{connectionID: id, seen: make(map[string]struct{}), emit: emit}
}

func (s *websocketUsageSink) record(record coreusage.Record, payload usagePayload) {
	// The SDK has no response ID. Its per-execution start time has nanosecond
	// precision; account and model distinguish separate upstream attempts.
	identity, _ := json.Marshal([]string{s.connectionID, record.AuthID, record.Model, record.RequestedAt.UTC().Format("2006-01-02T15:04:05.000000000Z")})
	if record.RequestedAt.IsZero() {
		// Missing execution identity must not silently collapse independent usage.
		identity = []byte(rand.Text())
	}
	id := fmt.Sprintf("%s:execution:%x", s.connectionID, sha256.Sum256(identity))
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.seen[id]; ok {
		return
	}
	s.seen[id] = struct{}{}
	payload.RequestID = id
	s.emit(payload)
}
