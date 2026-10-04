//go:build !windows

package main

import (
	"context"
	"os"
	"time"
)

func monitorParentProcessPlatform(ctx context.Context, parentPID int, cancel context.CancelFunc, emitter *eventEmitter) {
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if os.Getppid() == parentPID {
					continue
				}
				if emitter != nil {
					emitter.emit(map[string]any{
						"type":      "parent_exit",
						"parentPid": parentPID,
					})
				}
				cancel()
				return
			}
		}
	}()
}
