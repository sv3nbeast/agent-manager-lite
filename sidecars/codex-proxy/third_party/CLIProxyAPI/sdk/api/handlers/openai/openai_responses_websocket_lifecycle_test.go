package openai

import (
	"context"
	"errors"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
)

func TestResponsesWebsocketNoOpenDeadlineBeyondFormerMinuteStillUsesIdleTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := &config.SDKConfig{}
		cfg.Streaming.StreamOpenTimeoutMS = -1
		cfg.Streaming.StreamIdleTimeoutMS = 2000
		turn := beginResponsesWebsocketTurn(t.Context(), cfg, []byte(`{"model":"gpt-5.5"}`), nil)
		defer turn.stop()

		time.Sleep(61 * time.Second)
		synctest.Wait()
		if err := turn.ctx.Err(); err != nil {
			t.Fatalf("disabled stream-open timeout ended the turn after 61 seconds: %v", err)
		}

		turn.progress()
		time.Sleep(2 * time.Second)
		synctest.Wait()
		if cause := context.Cause(turn.ctx); cause == nil || !strings.Contains(cause.Error(), "stream_idle timeout") {
			t.Fatalf("stream-idle timeout did not remain active: %v", cause)
		}
	})
}

func TestResponsesWebsocketImageNoOpenDeadlineAndDownstreamCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := &config.SDKConfig{}
		cfg.Streaming.StreamOpenTimeoutMS = 60_000
		cfg.Streaming.ImageStreamOpenTimeoutMS = -1
		turn := beginResponsesWebsocketTurn(t.Context(), cfg, []byte(`{"model":"gpt-image-2"}`), nil)
		defer turn.stop()

		time.Sleep(61 * time.Second)
		synctest.Wait()
		if err := turn.ctx.Err(); err != nil {
			t.Fatalf("image request inherited the normal one-minute open timeout: %v", err)
		}

		turn.cancel(context.Canceled)
		synctest.Wait()
		if cause := context.Cause(turn.ctx); !errors.Is(cause, context.Canceled) {
			t.Fatalf("downstream cancellation was not preserved: %v", cause)
		}
	})
}

func TestResponsesWebsocketUnsetOpenTimeoutKeepsStandaloneDefault(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		turn := beginResponsesWebsocketTurn(t.Context(), &config.SDKConfig{}, []byte(`{"model":"gpt-5.5"}`), nil)
		defer turn.stop()

		time.Sleep(31 * time.Second)
		synctest.Wait()
		if cause := context.Cause(turn.ctx); cause == nil || !strings.Contains(cause.Error(), "stream_open timeout") {
			t.Fatalf("omitted timeout should preserve the standalone default: %v", cause)
		}
	})
}
