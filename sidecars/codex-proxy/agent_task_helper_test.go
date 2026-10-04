package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/nacl/box"
)

func TestAgentTaskHelperSealedBoxAndStrictInput(t *testing.T) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha512.Sum512(key.Seed())
	public, err := curve25519.X25519(digest[:32], curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	var publicKey [32]byte
	copy(publicKey[:], public)
	sealed, err := box.SealAnonymous(nil, []byte("task-helper-fixture"), &publicKey, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encodedKey := base64.StdEncoding.EncodeToString(der)
	encodedTask := base64.StdEncoding.EncodeToString(sealed)
	input, _ := json.Marshal(map[string]string{"privateKey": encodedKey, "encryptedTaskId": encodedTask})
	var output bytes.Buffer
	if err = runAgentTaskDecrypt(bytes.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "{\"taskId\":\"task-helper-fixture\"}\n" {
		t.Fatalf("unexpected helper result")
	}
	for _, raw := range []string{
		string(input) + "{}", strings.Repeat("a", 65537), "{}", `{"privateKey":"not-a-key","encryptedTaskId":"secret"}`,
		strings.TrimSuffix(string(input), "}") + `,"unknown":true}`,
		strings.Replace(string(input), encodedTask, "invalid-ciphertext", 1),
	} {
		output.Reset()
		err = runAgentTaskDecrypt(strings.NewReader(raw), &output)
		if err == nil || output.Len() != 0 {
			t.Fatal("helper accepted malformed input")
		}
		if strings.Contains(err.Error(), encodedKey) || strings.Contains(err.Error(), "secret") {
			t.Fatal("helper error leaked input")
		}
	}
}
