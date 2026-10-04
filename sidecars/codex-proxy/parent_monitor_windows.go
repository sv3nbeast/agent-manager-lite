//go:build windows

package main

import (
	"context"
	"time"

	"golang.org/x/sys/windows"
)

func monitorParentProcessPlatform(ctx context.Context, parentPID int, cancel context.CancelFunc, emitter *eventEmitter) {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(parentPID))
	if err != nil {
		if emitter != nil {
			emitter.emit(map[string]any{
				"type":      "parent_monitor_error",
				"reason":    "windows_open_process_failed",
				"parentPid": parentPID,
				"error":     err.Error(),
			})
		}
		cancel()
		return
	}

	go func() {
		defer windows.CloseHandle(handle)
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}

			status, waitErr := windows.WaitForSingleObject(handle, uint32(time.Second/time.Millisecond))
			switch status {
			case windows.WAIT_OBJECT_0:
				if emitter != nil {
					emitter.emit(map[string]any{
						"type":      "parent_exit",
						"parentPid": parentPID,
					})
				}
				cancel()
				return
			case uint32(windows.WAIT_TIMEOUT):
				continue
			default:
				if emitter != nil {
					message := "unknown_wait_status"
					if waitErr != nil {
						message = waitErr.Error()
					}
					emitter.emit(map[string]any{
						"type":      "parent_monitor_error",
						"reason":    "windows_wait_failed",
						"parentPid": parentPID,
						"status":    status,
						"error":     message,
					})
				}
				cancel()
				return
			}
		}
	}()
}
