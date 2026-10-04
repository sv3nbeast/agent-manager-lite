package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
)

// A one-shot offline helper. Private keys travel through inherited stdin, never
// argv, files, logs or a listening endpoint.
func runAgentTaskDecrypt(input io.Reader, output io.Writer) error {
	data, err := io.ReadAll(io.LimitReader(input, 65537))
	if err != nil || len(data) > 65536 {
		return errors.New("invalid helper input size")
	}
	var request struct {
		PrivateKey      string `json:"privateKey"`
		EncryptedTaskID string `json:"encryptedTaskId"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&request); err != nil {
		return errors.New("invalid helper input")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return errors.New("unexpected trailing helper input")
	}
	taskID, err := executor.DecryptCodexAgentTaskID(request.PrivateKey, request.EncryptedTaskID)
	if err != nil || len(taskID) == 0 || len(taskID) > 4096 || !utf8.ValidString(taskID) {
		return errors.New("agent task decryption failed")
	}
	return json.NewEncoder(output).Encode(map[string]string{"taskId": taskID})
}
