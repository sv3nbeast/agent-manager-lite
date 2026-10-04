package main

import (
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	coreusage "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/usage"
)

// Other upstream runtime tests shut down the process-wide usage dispatcher.
// A fresh process tests the real lifecycle without resetting production globals.
func runTierTestIsolated(t *testing.T) bool {
	if os.Getenv("CML_USAGE_TEST_PROCESS") == t.Name() {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^"+t.Name()+"$", "-test.count=1")
	cmd.Env = append(os.Environ(), "CML_USAGE_TEST_PROCESS="+t.Name())
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("isolated usage regression: %v\n%s", err, output)
	}
	return true
}

type tierRecordCollector struct {
	authID  string
	records chan coreusage.Record
}

func (p tierRecordCollector) HandleUsage(_ context.Context, record coreusage.Record) {
	if record.AuthID == p.authID {
		select {
		case p.records <- record:
		default:
		}
	}
}
func assertTierRecord(t *testing.T, records <-chan coreusage.Record, raw, outgoing string) {
	t.Helper()
	incoming := strings.Trim(raw, `"`)
	if incoming == "null" {
		incoming = ""
	}
	if incoming == "fast" {
		incoming = "priority"
	}
	select {
	case record := <-records:
		if record.InboundServiceTier == nil || *record.InboundServiceTier != incoming || record.OutboundServiceTier == nil || *record.OutboundServiceTier != outgoing || record.ResponseServiceTier != "default" {
			t.Fatalf("tier evidence incorrect: in=%v out=%v response=%s; want=%q -> %q -> default", record.InboundServiceTier, record.OutboundServiceTier, record.ResponseServiceTier, incoming, outgoing)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("usage evidence was not emitted")
	}
}

type oneByteReader struct{ io.ReadCloser }

func (r oneByteReader) Read(p []byte) (int, error) { return r.ReadCloser.Read(p[:1]) }
func TestProviderUsageObserverDoesNotChangeUnicodeSSE(t *testing.T) {
	raw := "data: {\"type\":\"response.output_text.delta\",\"delta\":\"中文🧪\\n\"}\r\n\r\n" +
		"data: {\"type\":\"response.completed\",\n" + "data: \"response\":{\"service_tier\":\"default\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}}\n\n"
	observer := &providerUsageObserver{body: oneByteReader{io.NopCloser(strings.NewReader(raw))}}
	output, err := io.ReadAll(observer)
	if err != nil || string(output) != raw {
		t.Fatalf("observer changed the stream: %v", err)
	}
	if !observer.terminal || observer.responseTier != "default" || observer.detail.InputTokens != 5 || observer.detail.OutputTokens != 2 {
		t.Fatalf("metadata missing: %#v", observer)
	}
}
func TestProviderUsageObserverBoundsOversizedEvents(t *testing.T) {
	raw := "data: " + strings.Repeat("x", (4<<20)+1) + "\n\n" + "data: {\"type\":\"response.completed\",\"response\":{\"service_tier\":\"priority\"}}\n\n"
	observer := &providerUsageObserver{body: io.NopCloser(strings.NewReader(raw))}
	n, err := io.Copy(io.Discard, observer)
	if err != nil || n != int64(len(raw)) || observer.responseTier != "priority" || !observer.terminal {
		t.Fatalf("stream did not recover after bounded observation: %v", err)
	}
}
