// Local LaunchServices fixture only; never included in application resources.
package main

import (
 "encoding/json"
 "os"
 "os/signal"
 "path/filepath"
 "syscall"
 "time"
)

func main() {
 profile := os.Getenv("CODEX_HOME")
 cwd, _ := os.Getwd()
 data, _ := json.Marshal(map[string]any{"home": profile, "cwd": cwd, "argv0": os.Args[0], "inheritedKey": os.Getenv("OPENAI_API_KEY"), "desktop": os.Getenv("CODEX_ELECTRON_USER_DATA_PATH"), "pid": os.Getpid(), "args": os.Args[1:], "packageRoot": os.Getenv("CODEX_MANAGED_PACKAGE_ROOT"), "managedByNpm": os.Getenv("CODEX_MANAGED_BY_NPM"), "managedByBun": os.Getenv("CODEX_MANAGED_BY_BUN"), "locale": os.Getenv("LC_ALL"), "nodeOptions": os.Getenv("NODE_OPTIONS"), "authCapture": os.Getenv("CML_TEMP_LOGIN_CAPTURE")})
 _ = os.WriteFile(filepath.Join(profile, "fixture-desktop.json"), data, 0600)
 signals := make(chan os.Signal, 1)
 signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
 // Bound fixture lifetime even if its test harness is killed.
 select {
 case <-signals:
 case <-time.After(75 * time.Second):
 }
 // Simulate the final client-side token rotation while handling SIGTERM.
 // Only the isolated test harness creates this fixture input.
 if rotation, err := os.ReadFile(filepath.Join(profile, "fixture-rotate-auth.json")); err == nil && json.Valid(rotation) {
  _ = os.WriteFile(filepath.Join(profile, "auth.json"), rotation, 0600)
 }
}
