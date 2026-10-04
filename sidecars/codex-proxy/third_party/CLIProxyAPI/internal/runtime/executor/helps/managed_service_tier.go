package helps

import (
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
	"strings"
)

// ApplyManagedServiceTier applies a selected account's default without changing
// the original request used for inbound-tier reporting. Explicit client values
// retain precedence; validation remains at the HTTP/WS boundary.
func ApplyManagedServiceTier(body, original []byte, tier string) []byte {
	value := gjson.GetBytes(original, "service_tier")
	if value.Exists() && value.Type != gjson.Null && (value.Type != gjson.String || strings.TrimSpace(value.String()) != "") {
		return body
	}
	switch tier {
	case "priority", "default", "auto", "flex", "scale", "ultrafast":
	default:
		return body
	}
	out, err := sjson.SetBytes(body, "service_tier", tier)
	if err != nil {
		return body
	}
	return out
}
