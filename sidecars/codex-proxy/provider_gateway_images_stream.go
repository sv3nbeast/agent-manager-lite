package main

import (
	"bytes"
	"io"
)

// Image completion events contain large base64 strings before their usage.
// Keep the wire bytes untouched; shorten strings only in the observation copy
// so the existing bounded usage parser can still read the terminal and tokens.
type providerImageMetadataReader struct {
	body                        io.Reader
	observer                    *providerUsageObserver
	prefix                      []byte
	lineKind                    int // 0: pending field, 1: data, 2: other SSE field
	quoted                      bool
	escaped                     bool
	long                        bool
	value                       []byte
	unicodeDigits               int
	skipLF                      bool
	pendingData                 bool
	wireLineOpen, wireEventOpen bool
}

func (r *providerImageMetadataReader) Read(p []byte) (int, error) {
	n, err := r.body.Read(p)
	r.observe(p[:n])
	if err != nil && err != io.EOF {
		r.observer.readErr = err
	}
	return n, err
}

func (r *providerImageMetadataReader) observe(data []byte) {
	metadata := make([]byte, 0, len(data))
	for _, ch := range data {
		// SSE accepts CR, LF and CRLF, including a pair split across reads.
		// Normalize only the observation copy; Read returns the original bytes.
		if r.skipLF && ch == '\n' {
			r.skipLF = false
			continue
		}
		r.skipLF = ch == '\r'
		if r.skipLF {
			ch = '\n'
		}
		switch ch {
		case '\n':
			if !r.wireLineOpen {
				r.wireEventOpen = false
				r.pendingData = false
			}
			r.wireLineOpen = false
		default:
			r.wireLineOpen, r.wireEventOpen = true, true
		}
		if ch == '\n' {
			if r.lineKind == 0 {
				metadata = append(metadata, r.prefix...)
			} else if r.quoted {
				// A literal newline inside a JSON string is invalid; do not turn
				// a malformed upstream completion into a successful one.
				r.observer.failed = true
				metadata = append(metadata, '"')
			}
			metadata = append(metadata, ch)
			r.lineKind, r.prefix = 0, r.prefix[:0]
			r.quoted, r.escaped, r.long = false, false, false
			r.unicodeDigits = 0
			r.value = r.value[:0]
			continue
		}
		if r.lineKind == 0 {
			r.prefix = append(r.prefix, ch)
			if len(r.prefix) < len("data:") {
				continue
			}
			r.lineKind = 2
			if bytes.Equal(r.prefix, []byte("data:")) {
				r.lineKind = 1
				r.pendingData = true
			}
			metadata = append(metadata, r.prefix...)
			r.prefix = r.prefix[:0]
			continue
		}
		if r.lineKind != 1 {
			metadata = append(metadata, ch)
			continue
		}
		if !r.quoted {
			if ch == '"' {
				r.quoted = true
				r.value = append(r.value[:0], ch)
			} else {
				metadata = append(metadata, ch)
			}
			continue
		}
		// Long strings are omitted from the metadata copy, so JSON validation
		// of that copy cannot catch invalid escapes or control bytes for us.
		if ch < 0x20 {
			r.observer.failed = true
		}
		if r.unicodeDigits > 0 {
			if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) {
				r.observer.failed = true
			}
			r.unicodeDigits--
		} else if r.escaped {
			switch ch {
			case 'u':
				r.unicodeDigits = 4
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
			default:
				r.observer.failed = true
			}
		}
		if !r.long {
			if len(r.value) >= 2048 {
				r.long = true
				r.value = r.value[:0]
			} else {
				r.value = append(r.value, ch)
			}
		}
		if ch == '"' && !r.escaped {
			if r.long {
				metadata = append(metadata, '"', '"')
			} else {
				metadata = append(metadata, r.value...)
			}
			r.quoted, r.escaped, r.long = false, false, false
			r.value = r.value[:0]
			r.unicodeDigits = 0
		} else if ch == '\\' && !r.escaped {
			r.escaped = true
		} else {
			r.escaped = false
		}
	}
	r.observer.observeSSE(metadata)
}

// The already-forwarded prefix cannot be retracted on a mid-frame disconnect.
// Invalidate its unfinished data and label it as an error before emitting a
// separate JSON error. Just adding a blank line or changing the event name can
// still report completion to clients that dispatch by the JSON payload's type.
func (r *providerImageMetadataReader) finishInterruptedEvent(w io.Writer) error {
	if !r.wireEventOpen {
		return nil
	}
	if r.wireLineOpen {
		if _, err := io.WriteString(w, "\n"); err != nil {
			return err
		}
	}
	_, err := io.WriteString(w, "event: error\ndata: [INCOMPLETE]\n\n")
	return err
}
