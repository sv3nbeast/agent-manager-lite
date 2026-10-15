// Synthetic native process used only by Claude lifecycle tests. It never
// reads a real home, connects to a model service, or ships in the application.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	program, _ := os.Executable()
	for _, arg := range os.Args[1:] {
		if arg == "--version" {
			if strings.Contains(filepath.Base(program), "version-two") {
				fmt.Println("2.2.0 (Claude Code lifecycle fixture)")
			} else {
				fmt.Println("2.1.999 (Claude Code lifecycle fixture)")
			}
			return
		}
		if arg == "--help" {
			_ = os.WriteFile(program+".help-probe", []byte("probed\n"), 0600)
			fmt.Println("--print --model --resume --session-id --settings --add-dir")
			if !strings.Contains(filepath.Base(program), "missing-flags") {
				fmt.Println("--setting-sources --strict-mcp-config --mcp-config")
			}
			return
		}
	}
	config := os.Getenv("CLAUDE_CONFIG_DIR")
	if config == "" || !filepath.IsAbs(config) {
		os.Exit(2)
	}
	if len(os.Args) >= 3 && os.Args[1] == "auth" && os.Args[2] == "status" {
		var credentials struct {
			OAuth struct {
				AccessToken string `json:"accessToken"`
			} `json:"claudeAiOauth"`
		}
		raw, err := os.ReadFile(filepath.Join(config, ".credentials.json"))
		if err == nil {
			_ = json.Unmarshal(raw, &credentials)
		}
		loggedIn := credentials.OAuth.AccessToken != ""
		method := "none"
		if loggedIn {
			method = "claude.ai"
		}
		data, _ := json.Marshal(map[string]any{"loggedIn": loggedIn, "authMethod": method, "configDirectory": config})
		fmt.Println(string(data))
		if !loggedIn {
			os.Exit(1)
		}
		return
	}
	cwd, _ := os.Getwd()
	data, _ := json.Marshal(map[string]any{
		"configDirectory": config, "home": os.Getenv("HOME"), "cwd": cwd,
		"argv0": os.Args[0], "args": os.Args[1:], "pid": os.Getpid(),
		"apiKey": os.Getenv("ANTHROPIC_API_KEY"), "bearer": os.Getenv("ANTHROPIC_AUTH_TOKEN"),
		"oauth": os.Getenv("CLAUDE_CODE_OAUTH_TOKEN"), "profile": os.Getenv("ANTHROPIC_PROFILE"),
		"model": os.Getenv("ANTHROPIC_MODEL"), "baseUrl": os.Getenv("ANTHROPIC_BASE_URL"),
		"bedrock": os.Getenv("CLAUDE_CODE_USE_BEDROCK"), "openAIKey": os.Getenv("OPENAI_API_KEY"),
		"codexHome": os.Getenv("CODEX_HOME"), "projectDirectoryOverride": os.Getenv("CLAUDE_CODE_PROJECT_DIR_NAME"),
		"nodeOptions": os.Getenv("NODE_OPTIONS"),
	})
	_ = os.WriteFile(filepath.Join(config, "fixture-claude.json"), data, 0600)
	_ = os.WriteFile(filepath.Join(config, ".claude.json"), []byte("{\"fixtureGlobalState\":true}\n"), 0600)
	projects := filepath.Join(config, "projects", "fixture-project")
	_ = os.MkdirAll(projects, 0700)
	transcript := filepath.Join(projects, "76be7829-ec9e-4577-94f6-e940c775f25f.jsonl")
	if _, err := os.Stat(transcript); os.IsNotExist(err) {
		_ = os.WriteFile(transcript, []byte("{\"type\":\"user\",\"sessionId\":\"76be7829-ec9e-4577-94f6-e940c775f25f\",\"message\":{\"role\":\"user\",\"content\":\"synthetic lifecycle transcript\"}}\n"), 0600)
	}
	if _, err := os.Stat(filepath.Join(config, "fixture-exit-immediately")); err == nil {
		os.Exit(3)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	// Bound the lifetime even if a test harness crashes.
	select {
	case <-signals:
	case <-time.After(75 * time.Second):
	}
	if settings, err := os.ReadFile(filepath.Join(config, "fixture-write-settings.json")); err == nil && json.Valid(settings) {
		_ = os.WriteFile(filepath.Join(config, "settings.json"), settings, 0600)
	}
}
