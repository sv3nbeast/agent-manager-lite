// images-mcp is a small, dependency-free stdio adapter for compatible Images
// APIs. The legacy server key remains usable; no Sub2API-specific API is used.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"hash/crc32"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

const maxImage = 32 << 20

type config struct {
	BaseURL     string  `json:"base_url"`
	APIKey      string  `json:"api_key"`
	Model       string  `json:"model"`
	OutputDir   string  `json:"output_dir"`
	Quality     string  `json:"quality"`
	Size        string  `json:"size"`
	HTTPTimeout float64 `json:"http_timeout_seconds"`
	ToolTimeout float64 `json:"tool_timeout_seconds"`
	Active      *bool   `json:"active,omitempty"`
}

var sizePattern = regexp.MustCompile(`^(auto|[1-9][0-9]{1,4}x[1-9][0-9]{1,4})$`)

func validModel(model string) bool {
	return model != "" && len([]rune(model)) <= 200 && !strings.ContainsFunc(model, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
}

func readConfig(path string) (config, error) {
	var cfg config
	// Reject symbolic links, devices and hard links before reading credentials.
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return cfg, errors.New("图片插件配置不可读取，请在管理器中重新保存图片设置")
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 || st.Size() > 64<<10 {
		return cfg, errors.New("图片插件配置必须为当前用户的私有普通文件（0600）")
	}
	if stat, ok := st.Sys().(*syscall.Stat_t); !ok || stat.Uid != uint32(os.Getuid()) || stat.Nlink != 1 {
		return cfg, errors.New("图片插件配置所有者或链接不安全")
	}
	data, err := io.ReadAll(io.LimitReader(f, (64<<10)+1))
	if err != nil || len(data) > 64<<10 || json.Unmarshal(data, &cfg) != nil {
		return cfg, errors.New("图片插件配置无效")
	}
	if cfg.Active != nil && !*cfg.Active {
		return cfg, errors.New("此图片插件的实例网关未启动，请以 API 转发方式启动实例")
	}
	if !validModel(cfg.Model) || cfg.APIKey == "" || strings.ContainsAny(cfg.APIKey, "\r\n") || !filepath.IsAbs(cfg.OutputDir) {
		return cfg, errors.New("图片模型、连接或输出目录尚未正确配置")
	}
	if cfg.HTTPTimeout == 0 {
		cfg.HTTPTimeout = 180
	}
	if cfg.ToolTimeout == 0 {
		cfg.ToolTimeout = 240
	}
	if cfg.HTTPTimeout <= 0 || cfg.HTTPTimeout > 900 || cfg.ToolTimeout <= 0 || cfg.ToolTimeout > 900 {
		return cfg, errors.New("图片插件超时配置无效")
	}
	return cfg, nil
}

func endpoint(base string) (string, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("Images API 地址无效")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", errors.New("Images API 需要 HTTP(S) 地址")
	}
	path := strings.TrimRight(u.EscapedPath(), "/")
	if path != "" && path != "/v1" {
		return "", errors.New("Images API 地址应为服务根地址或 /v1")
	}
	u.Path, u.RawPath = "/v1/images/generations", ""
	return u.String(), nil
}

func imageType(data []byte) (string, string, error) {
	if c, format, err := image.DecodeConfig(bytes.NewReader(data)); err == nil && c.Width > 0 && c.Height > 0 && int64(c.Width)*int64(c.Height) <= 100_000_000 {
		if format == "png" {
			seenData := false
			for pos := 8; pos+12 <= len(data); {
				length := int(binary.BigEndian.Uint32(data[pos : pos+4]))
				end := pos + 12 + length
				if end > len(data) || crc32.ChecksumIEEE(data[pos+4:end-4]) != binary.BigEndian.Uint32(data[end-4:end]) {
					break
				}
				kind := string(data[pos+4 : pos+8])
				if kind == "IDAT" {
					seenData = true
				}
				if kind == "IEND" {
					if length == 0 && end == len(data) && seenData {
						return "image/png", ".png", nil
					}
					break
				}
				pos = end
			}
		}
		if format == "jpeg" && len(data) > 2 && bytes.Equal(data[len(data)-2:], []byte{0xff, 0xd9}) {
			return "image/jpeg", ".jpg", nil
		}
	}
	// WebP is validated without adding a decoder dependency or allocating pixels.
	if len(data) >= 30 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP" && (string(data[12:16]) == "VP8 " || string(data[12:16]) == "VP8L" || string(data[12:16]) == "VP8X") {
		size := uint64(data[4]) | uint64(data[5])<<8 | uint64(data[6])<<16 | uint64(data[7])<<24
		if size+8 == uint64(len(data)) {
			return "image/webp", ".webp", nil
		}
	}
	return "", "", errors.New("Images API 返回的内容不是有效 PNG、JPEG 或 WebP 图片")
}

func outputDirectory(path string) error {
	// Create only absent directories; never follow a symlink into another home.
	current := string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(filepath.Clean(path), current), string(filepath.Separator)) {
		current = filepath.Join(current, part)
		st, err := os.Lstat(current)
		if os.IsNotExist(err) {
			if err = os.Mkdir(current, 0700); err != nil && !os.IsExist(err) {
				return errors.New("图片输出目录无法创建")
			}
			st, err = os.Lstat(current)
		}
		if err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return errors.New("图片输出目录不安全或不可访问")
		}
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm()&0022 != 0 {
		return errors.New("图片输出目录不可由其他用户写入")
	}
	if info, ok := st.Sys().(*syscall.Stat_t); !ok || info.Uid != uint32(os.Getuid()) {
		return errors.New("图片输出目录所有者不正确")
	}
	return nil
}

func generate(ctx context.Context, path string, arguments map[string]any) ([]map[string]any, error) {
	// Reload on every call. A saved model applies to the next request, while an
	// already-running request keeps its initial configuration and credentials.
	cfg, err := readConfig(path)
	if err != nil {
		return nil, err
	}
	prompt, ok := arguments["prompt"].(string)
	if !ok || strings.TrimSpace(prompt) == "" || len(prompt) > 100_000 {
		return nil, errors.New("请提供有效的图片描述（最多 100000 字节）")
	}
	payload := map[string]any{"model": cfg.Model, "prompt": prompt, "n": 1}
	options := map[string]any{"quality": "auto", "size": "auto"}
	if cfg.Quality != "" {
		options["quality"] = cfg.Quality
	}
	if cfg.Size != "" {
		options["size"] = cfg.Size
	}
	for key, value := range arguments {
		options[key] = value
	}
	for key, value := range options {
		text, ok := value.(string)
		if !ok {
			return nil, errors.New("图片工具参数必须为文本")
		}
		switch key {
		case "prompt":
		case "model":
			if !validModel(text) {
				return nil, errors.New("图片模型 ID 无效")
			}
			payload[key] = text
		case "quality":
			if text != "auto" && text != "low" && text != "medium" && text != "high" {
				return nil, errors.New("图片质量参数无效")
			}
			payload[key] = text
		case "size":
			if !sizePattern.MatchString(text) {
				return nil, errors.New("图片尺寸参数无效")
			}
			payload[key] = text
		default:
			return nil, errors.New("图片工具包含不支持的参数")
		}
	}
	address, err := endpoint(cfg.BaseURL)
	if err != nil {
		return nil, err
	}
	data, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(ctx, time.Duration(min(cfg.HTTPTimeout, cfg.ToolTimeout)*float64(time.Second)))
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, address, bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("图片请求无法构建")
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	// The instance gateway owns network proxy policy. Legacy external endpoints
	// remain direct; inherited HTTP_PROXY must never leak loopback credentials.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("图片请求已取消或超过配置的等待时间")
		}
		return nil, errors.New("Images API 网络连接失败，请检查实例网络和供应商连接")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("Images API 返回 HTTP %d；请检查供应商模型权限及上游可用性（未重试，未暴露响应正文）", res.StatusCode)
	}
	limit := int64(maxImage*4/3 + 64<<10)
	body, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil || int64(len(body)) > limit {
		return nil, errors.New("Images API 响应读取失败或超过大小限制")
	}
	var result struct {
		Data []struct {
			Base64 string `json:"b64_json"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &result) != nil || len(result.Data) != 1 || result.Data[0].Base64 == "" {
		return nil, errors.New("Images API 需返回一张 b64_json 图片；当前响应格式不兼容")
	}
	pixels, err := base64.StdEncoding.DecodeString(result.Data[0].Base64)
	if err != nil || len(pixels) > maxImage {
		return nil, errors.New("Images API 图片编码无效或超过大小限制")
	}
	mime, ext, err := imageType(pixels)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, errors.New("图片请求已取消")
	}
	if err = outputDirectory(cfg.OutputDir); err != nil {
		return nil, err
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return nil, errors.New("图片文件名生成失败")
	}
	file := filepath.Join(cfg.OutputDir, "image-"+hex.EncodeToString(nonce[:])+ext)
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, errors.New("图片无法保存")
	}
	_, writeErr := f.Write(pixels)
	closeErr := f.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(file)
		return nil, errors.New("图片保存失败")
	}
	return []map[string]any{{"type": "image", "data": base64.StdEncoding.EncodeToString(pixels), "mimeType": mime}, {"type": "text", "text": fmt.Sprintf("图片已保存：%s\n请求模型：%s", file, payload["model"])}}, nil
}

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func serve(configPath string, input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var writeMu, callMu sync.Mutex
	var workers sync.WaitGroup
	calls := map[string]context.CancelFunc{}
	reply := func(id json.RawMessage, result any, rpcError any) {
		response := map[string]any{"jsonrpc": "2.0", "id": id}
		if rpcError != nil {
			response["error"] = rpcError
		} else {
			response["result"] = result
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = json.NewEncoder(output).Encode(response)
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		var req request
		if json.Unmarshal(scanner.Bytes(), &req) != nil || req.JSONRPC != "2.0" {
			reply(json.RawMessage("null"), nil, map[string]any{"code": -32700, "message": "Invalid JSON-RPC request"})
			continue
		}
		if req.Method == "notifications/cancelled" {
			var params struct {
				RequestID json.RawMessage `json:"requestId"`
			}
			_ = json.Unmarshal(req.Params, &params)
			callMu.Lock()
			if stop := calls[string(params.RequestID)]; stop != nil {
				stop()
			}
			callMu.Unlock()
			continue
		}
		if len(req.ID) == 0 {
			continue
		}
		switch req.Method {
		case "initialize":
			var params struct {
				Protocol string `json:"protocolVersion"`
			}
			_ = json.Unmarshal(req.Params, &params)
			version := "2024-11-05"
			for _, supported := range []string{"2024-11-05", "2025-03-26", "2025-06-18"} {
				if params.Protocol == supported {
					version = supported
				}
			}
			reply(req.ID, map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "images-api", "version": "1.0.0"}, "instructions": "使用兼容的 Images API 生成图片。省略 model 时每次读取管理器保存的默认值，无需把默认模型写入调用参数。"}, nil)
		case "ping":
			reply(req.ID, map[string]any{}, nil)
		case "tools/list":
			reply(req.ID, map[string]any{"tools": []any{map[string]any{"name": "imagegen", "description": "通过已配置的 Images API 生成并保存图片（兼容 Sub2API 等供应商）。省略 model 使用管理器当前保存的默认模型。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"prompt": map[string]any{"type": "string", "description": "图片描述"}, "model": map[string]any{"type": "string", "description": "仅在明确需要覆盖默认模型时指定"}, "size": map[string]any{"type": "string", "pattern": sizePattern.String(), "description": "auto 或供应商支持的宽x高"}, "quality": map[string]any{"type": "string", "enum": []string{"auto", "low", "medium", "high"}}}, "required": []string{"prompt"}, "additionalProperties": false}}}}, nil)
		case "tools/call":
			var params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			}
			if json.Unmarshal(req.Params, &params) != nil || params.Name != "imagegen" {
				reply(req.ID, nil, map[string]any{"code": -32602, "message": "Unknown tool or invalid parameters"})
				continue
			}
			callMu.Lock()
			_, duplicate := calls[string(req.ID)]
			if len(calls) >= 2 || duplicate {
				callMu.Unlock()
				reply(req.ID, map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": "图片工具正忙，请等待当前调用完成"}}}, nil)
				continue
			}
			callCtx, stop := context.WithCancel(ctx)
			calls[string(req.ID)] = stop
			callMu.Unlock()
			workers.Add(1)
			go func(req request, args map[string]any) {
				defer workers.Done()
				defer stop()
				content, err := generate(callCtx, configPath, args)
				callMu.Lock()
				delete(calls, string(req.ID))
				callMu.Unlock()
				if err != nil {
					reply(req.ID, map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": err.Error()}}}, nil)
				} else {
					reply(req.ID, map[string]any{"content": content}, nil)
				}
			}(req, params.Arguments)
		default:
			reply(req.ID, nil, map[string]any{"code": -32601, "message": "Method not found"})
		}
	}
	cancel()
	workers.Wait()
	return scanner.Err()
}

func main() {
	path := flag.String("config", "", "Private Images API configuration file")
	flag.Parse()
	if *path == "" || !filepath.IsAbs(*path) {
		fmt.Fprintln(os.Stderr, "An absolute --config path is required")
		os.Exit(2)
	}
	if serve(*path, os.Stdin, os.Stdout) != nil {
		os.Exit(1)
	}
}
