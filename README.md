# Claude Code Proxy

OpenAI-compatible API proxy that routes requests to Claude Code CLI.
Created to use free work Claude Code access with Clawdbot.

## What it does
- Exposes `http://127.0.0.1:11480/v1/chat/completions`
- Forwards requests to `claude -p` CLI
- Returns responses in OpenAI format

## Quick Start

```bash
cd ~/.clawdbot/claude-code-proxy
node server.js
```

Or with a specific model:
```bash
CLAUDE_MODEL=haiku node server.js
```

## Clawdbot Config

Already configured in `~/.clawdbot/clawdbot.json`:
- Provider: `claude-code`
- Model: `claude-code/claude-code`
- Endpoint: `http://127.0.0.1:11480/v1`

## Files
- `server.js` - The proxy server
- `package.json` - Node package info

## Issues Fixed During Setup

1. **Ollama config error** - `api: "openai"` was invalid, changed to `api: "openai-completions"` inside model definition

2. **Node spawn hanging** - Changed from `spawn()` to `execSync()` which works correctly

3. **Array content format** - Added handling for OpenAI's array content format `[{type: "text", text: "..."}]`

4. **Session corruption** - After timeouts, clawdbot sessions can get stuck. Fix: restart clawdbot

## Timeout Settings
- Proxy: 2 minute timeout per request
- Clawdbot: 10 minute timeout per agent run

## Notes
- Multiple Claude sessions running = slower responses (rate limiting)
- Proxy must be running before clawdbot uses it
- Works with both WhatsApp and web dashboard

## Test
```bash
curl http://127.0.0.1:11480/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-code","messages":[{"role":"user","content":"Hi"}]}'
```
