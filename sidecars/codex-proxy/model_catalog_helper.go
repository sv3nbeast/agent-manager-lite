package main

import (
	"errors"
	"io"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
)

// Offline contract validation, also used by desktop integration tests. Never
// echo arbitrary catalog text (instructions and user metadata can be private).
func runModelCatalogValidation(input io.Reader, output io.Writer) error {
	const limit = 16 * 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(input, limit+1))
	if err != nil || len(data) > limit || registry.ValidateCodexClientModelEntriesJSON(data) != nil {
		return errors.New("invalid model catalog")
	}
	_, err = io.WriteString(output, "{\"valid\":true}\n")
	return err
}
