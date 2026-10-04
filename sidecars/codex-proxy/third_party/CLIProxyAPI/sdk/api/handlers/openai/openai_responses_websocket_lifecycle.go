package openai

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/tidwall/gjson"
)

type responsesWebsocketInput struct {
	kind int
	data []byte
}

// Keep reading control/close frames while a turn is waiting on its upstream.
// Execution remains serial; a small bounded queue accepts pipelined turns.
func readResponsesWebsocket(ctx context.Context, cancel context.CancelCauseFunc, conn *websocket.Conn) <-chan responsesWebsocketInput {
	input := make(chan responsesWebsocketInput, 8)
	go func() {
		defer close(input)
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				cancel(err)
				return
			}
			select {
			case <-ctx.Done():
				return
			case input <- responsesWebsocketInput{kind: kind, data: data}:
			default:
				cancel(fmt.Errorf("responses websocket: too many pending turns"))
				_ = conn.Close()
				return
			}
		}
	}()
	return input
}

type responsesWebsocketTurn struct {
	ctx        context.Context
	cancel     context.CancelCauseFunc
	writer     *responsesWebsocketWriter
	mu         sync.Mutex
	timer      *time.Timer
	generation uint64
	finished   bool
	idle       time.Duration
}

func beginResponsesWebsocketTurn(parent context.Context, cfg *config.SDKConfig, body []byte, writer *responsesWebsocketWriter) *responsesWebsocketTurn {
	open, idle := 30*time.Second, 5*time.Minute
	if cfg != nil {
		if ms := cfg.Streaming.StreamOpenTimeoutMS; ms > 0 {
			open = time.Duration(ms) * time.Millisecond
		}
		if ms := cfg.Streaming.StreamIdleTimeoutMS; ms > 0 {
			idle = time.Duration(ms) * time.Millisecond
		}
		image := strings.HasPrefix(gjson.GetBytes(body, "model").String(), "gpt-image-") || gjson.GetBytes(body, `tools.#(type=="image_generation")`).Exists()
		if image {
			if ms := cfg.Streaming.ImageStreamOpenTimeoutMS; ms > 0 {
				open = time.Duration(ms) * time.Millisecond
			}
			if ms := cfg.Streaming.ImageStreamIdleTimeoutMS; ms > 0 {
				idle = time.Duration(ms) * time.Millisecond
			}
		}
	}
	ctx, cancel := context.WithCancelCause(parent)
	turn := &responsesWebsocketTurn{ctx: ctx, cancel: cancel, writer: writer, idle: idle}
	turn.arm(open, "stream_open")
	return turn
}

func (t *responsesWebsocketTurn) arm(timeout time.Duration, phase string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.finished {
		return
	}
	t.generation++
	generation := t.generation
	if t.timer != nil {
		t.timer.Stop()
	}
	t.timer = time.AfterFunc(timeout, func() {
		t.mu.Lock()
		if t.finished || t.generation != generation {
			t.mu.Unlock()
			return
		}
		t.finished = true
		t.mu.Unlock()
		t.cancel(fmt.Errorf("responses websocket: %s timeout after %s", phase, timeout))
		// Match the existing transport-failure contract: terminate the socket.
		// Closing also releases a writer blocked behind a non-reading client.
		_, _ = t.writer.closeWithoutError()
	})
}

func (t *responsesWebsocketTurn) progress() {
	if t != nil {
		t.arm(t.idle, "stream_idle")
	}
}
func (t *responsesWebsocketTurn) stop() {
	t.mu.Lock()
	t.finished = true
	t.generation++
	if t.timer != nil {
		t.timer.Stop()
	}
	t.mu.Unlock()
	t.cancel(nil)
}
