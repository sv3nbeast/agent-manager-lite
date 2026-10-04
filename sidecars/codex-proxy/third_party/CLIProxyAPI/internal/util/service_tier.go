package util

import (
	"fmt"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
	"strings"
)

// NormalizeServiceTierRequest is the shared HTTP/WS protocol boundary. Missing,
// null and blank mean unspecified. Explicit valid tiers survive payload defaults.
// Reject malformed inputs before calling upstream; never infer Fast from them.
func NormalizeServiceTierRequest(body []byte) ([]byte, error) {
	if !gjson.ValidBytes(body) || !gjson.ParseBytes(body).IsObject() {
		return nil, fmt.Errorf("request body must be a JSON object")
	}
	count := 0
	gjson.ParseBytes(body).ForEach(func(key, _ gjson.Result) bool {
		if key.String() == "service_tier" {
			count++
		}
		return count < 2
	})
	if count > 1 {
		return nil, fmt.Errorf("duplicate service_tier field")
	}
	value := gjson.GetBytes(body, "service_tier")
	if !value.Exists() {
		return body, nil
	}
	if value.Type == gjson.Null {
		return sjson.DeleteBytes(body, "service_tier")
	}
	if value.Type != gjson.String {
		return nil, fmt.Errorf("service_tier must be a string")
	}
	tier := strings.TrimSpace(value.String())
	if tier == "" {
		return sjson.DeleteBytes(body, "service_tier")
	}
	if tier == "fast" {
		tier = "priority"
	}
	switch tier {
	case "priority", "default", "auto", "flex", "scale", "ultrafast":
		return sjson.SetBytes(body, "service_tier", tier)
	default:
		return nil, fmt.Errorf("unsupported service_tier")
	}
}
