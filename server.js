#!/usr/bin/env node
// Claude Code Proxy — OpenAI-compatible API backed by Claude Code CLI
// Supports structured tool calling: parses <tool_call> from model output
// and returns proper OpenAI tool_calls format for OpenClaw to execute.
// Run from terminal (not launchd) to inherit full environment.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = process.env.PORT || 11480;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-6[1m]';
const TIMEOUT_MS = 300000; // 5 minutes
let callCounter = 0;

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ============================================================
// Message helpers
// ============================================================

function getContentText(c) {
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(p => p.type === 'text').map(p => p.text).join('\n');
  return String(c);
}

function stripPrefix(t) {
  return t.replace(/^\[(WhatsApp|Telegram|Discord|Slack|Signal)[^\]]*\]\s*/i, '')
    .replace(/\[message_id:[^\]]+\]\s*/gi, '').trim();
}

function extractSystemPrompt(msgs) {
  const s = msgs.find(m => m.role === 'system');
  return s ? getContentText(s.content) : null;
}

function extractSkills(systemPrompt) {
  if (!systemPrompt) return [];
  const skills = [];
  const re = /<skill>\s*<name>([^<]+)<\/name>\s*<description>([^<]+)<\/description>\s*<location>([^<]+)<\/location>\s*<\/skill>/g;
  let m;
  while ((m = re.exec(systemPrompt)) !== null) {
    skills.push({ name: m[1].trim(), description: m[2].trim(), location: m[3].trim() });
  }
  return skills;
}

// Format full conversation (all messages, system prompt handled separately)
function formatConversation(msgs) {
  const parts = [];
  for (const m of msgs) {
    if (m.role === 'system') continue;
    const t = getContentText(m.content);
    if (!t || t.startsWith('The conversation history before this point was compacted')) continue;

    if (m.role === 'user') {
      parts.push(`User: ${stripPrefix(t)}`);
    } else if (m.role === 'assistant') {
      const truncated = t.length > 2000 ? t.substring(0, 2000) + '\n[...]' : t;
      parts.push(`Assistant: ${truncated}`);
    } else if (m.role === 'tool') {
      // Tool results from OpenClaw — include them so the model sees execution output
      const toolId = m.tool_call_id || 'unknown';
      parts.push(`Tool result (${toolId}): ${t}`);
    }
  }
  return parts.join('\n\n');
}

// ============================================================
// Tool schema formatting — convert OpenAI tool defs to prompt text
// ============================================================

function formatToolsForPrompt(tools) {
  if (!tools || !tools.length) return '';

  const lines = [
    '',
    '## Available Tools',
    'When you want to use a tool, output EXACTLY this format (you may include text before/after):',
    '<tool_call>',
    '{"name": "tool_name", "arguments": {"param1": "value1"}}',
    '</tool_call>',
    '',
    'You can make multiple tool calls in one response. Each must be in its own <tool_call> block.',
    'IMPORTANT: Only use tools listed below. Output the tool call, then STOP — wait for the result before continuing.',
    '',
  ];

  for (const tool of tools) {
    const fn = tool.function || tool;
    const name = fn.name;
    const desc = fn.description || '';
    const params = fn.parameters?.properties || {};
    const required = fn.parameters?.required || [];

    const paramList = Object.entries(params).map(([k, v]) => {
      const req = required.includes(k) ? ' (required)' : '';
      const type = v.type || 'any';
      const pdesc = v.description ? ` — ${v.description}` : '';
      return `    ${k}: ${type}${req}${pdesc}`;
    }).join('\n');

    lines.push(`### ${name}`);
    if (desc) lines.push(desc);
    if (paramList) lines.push(`Parameters:\n${paramList}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// Tool call parsing — extract <tool_call> blocks from model output
// ============================================================

function parseToolCalls(text) {
  const toolCalls = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;

  while ((match = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name) {
        toolCalls.push({
          id: `call_${++callCounter}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments || {})
          }
        });
      }
    } catch (e) {
      log(`Failed to parse tool_call: ${match[1].substring(0, 100)}`);
    }
  }

  // Extract text content (everything outside <tool_call> blocks)
  const contentText = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();

  return { toolCalls, contentText };
}

// ============================================================
// Skill handling
// ============================================================

function findSkill(text, skills) {
  const lower = text.toLowerCase();
  const variants = new Map();
  for (const skill of skills) {
    for (const v of [skill.name.toLowerCase(), skill.name.replace(/-/g, '').toLowerCase(),
      skill.name.replace('claude-code-', '').toLowerCase(), skill.name.replace(/-/g, ' ').toLowerCase()]) {
      variants.set(v, skill);
    }
  }
  const m = lower.match(/use\s+(\w+(?:-\w+)*)\s+skill/i) ||
            lower.match(/(\w+(?:-\w+)*)\s+skill\s+to/i) ||
            lower.match(/use\s+(\w+(?:-\w+)*)\s+to\b/i);
  if (m) {
    const req = m[1].toLowerCase();
    for (const [v, skill] of variants) {
      if (v === req || v.startsWith(req) || req.startsWith(v.substring(0, 4))) return skill;
    }
  }
  return null;
}

function readSkill(location) {
  try {
    const p = location.replace(/^~/, process.env.HOME);
    let content = fs.readFileSync(p, 'utf8');
    let root = p.replace(/\/SKILL\.md$/, '').replace(/\/clawdbot-skill$/, '');
    return content.replace(/<SKILL_ROOT>/g, root);
  } catch { return null; }
}

// ============================================================
// Model resolution — map incoming model names to Claude CLI names
// ============================================================

function resolveModel(requested) {
  if (!requested) return CLAUDE_MODEL;
  const lower = requested.toLowerCase();
  if (lower === 'claude-code' || lower === 'claude-code/claude-code') return CLAUDE_MODEL;
  if (lower.includes('opus')) return 'claude-opus-4-6[1m]';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.startsWith('claude-')) return requested; // pass through full model names
  log(`Unknown model "${requested}", using default ${CLAUDE_MODEL}`);
  return CLAUDE_MODEL;
}

// ============================================================
// Core: call Claude CLI
// ============================================================

function callClaude(prompt, systemPrompt, model) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-'));
  const useModel = model || CLAUDE_MODEL;

  const args = ['-p', prompt, '--output-format', 'json', '--model', useModel,
    '--no-session-persistence', '--tools', '', '--effort', 'high'];

  // --system-prompt replaces Claude Code's default coding persona entirely
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  log(`claude | ${useModel} | ${path.basename(tmpDir)} | prompt=${prompt.length}c | sys=${systemPrompt ? systemPrompt.length + 'c' : 'none'}`);

  try {
    const out = execFileSync('claude', args, {
      cwd: tmpDir, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024
    });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try {
      const j = JSON.parse(out.trim());
      if (j.result !== undefined && j.result !== null) {
        const r = j.result || '(no output)';
        log(`OK (${j.num_turns || '?'}t $${j.total_cost_usd?.toFixed(4) || 0}): ${r.substring(0, 80)}`);
        return r;
      }
      return j.error || '(unexpected response format)';
    } catch { return out.trim(); }
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    const stderr = (err.stderr || '').trim();
    if (stderr) log(`stderr: ${stderr.substring(0, 300)}`);
    throw new Error(stderr || (err.killed ? 'Timeout' : `Exit ${err.status}`));
  }
}

// ============================================================
// HTTP handler
// ============================================================

async function handleChat(req, res) {
  let body = '';
  req.on('data', c => body += c);
  await new Promise(r => req.on('end', r));

  let data;
  try { data = JSON.parse(body); } catch { return send(res, 400, { error: 'Bad JSON' }); }
  const { messages, stream, tools, model: requestedModel } = data;
  if (!messages?.length) return send(res, 400, { error: 'No messages' });
  const resolvedModel = resolveModel(requestedModel);

  try { fs.writeFileSync(`${__dirname}/last-request.json`, JSON.stringify(data, null, 2)); } catch {}

  const systemPrompt = extractSystemPrompt(messages);
  const skills = extractSkills(systemPrompt);
  const lastText = (() => {
    const u = messages.filter(m => m.role === 'user');
    return u.length ? stripPrefix(getContentText(u[u.length - 1].content)) : '';
  })();

  log(`--- ${messages.length} msgs | ${stream ? 'stream' : 'sync'} | ${tools?.length || 0} tools | model=${resolvedModel} | "${lastText.substring(0, 50)}" ---`);

  // Build conversation prompt
  let prompt = formatConversation(messages);

  // Skill injection
  const skill = findSkill(lastText, skills);
  if (skill) {
    log(`Skill: ${skill.name}`);
    const content = readSkill(skill.location);
    if (content) prompt += `\n\n[Skill instructions for "${skill.name}"]:\n${content}`;
  }

  // Build enhanced system prompt with tool schemas and persona rules
  let enhancedSystem = null;
  if (systemPrompt) {
    const toolPrompt = formatToolsForPrompt(tools);
    enhancedSystem = [
      'IMPORTANT RULES:',
      '- NEVER fabricate or invent command/tool output. When a tool returns results, relay them EXACTLY.',
      '- NEVER read files to determine your identity. Your identity is defined below.',
      '- Follow the persona and character defined below fully — voice, mannerisms, attitude.',
      '- When you want to use a tool, output a <tool_call> block as described in Available Tools.',
      '- After outputting a tool call, STOP and wait for the result. Do not guess what the result will be.',
      '',
      systemPrompt,
      toolPrompt
    ].join('\n');
  }

  try {
    const result = callClaude(prompt, enhancedSystem, resolvedModel);

    // Parse response for <tool_call> blocks
    const { toolCalls, contentText } = parseToolCalls(result);

    if (toolCalls.length > 0) {
      log(`Tool calls: ${toolCalls.map(t => t.function.name).join(', ')}`);
      sendToolCallResponse(res, contentText, toolCalls, stream);
    } else {
      sendOK(res, result, stream);
    }
  } catch (err) {
    log(`Error: ${err.message}`);
    sendOK(res, `[Error: ${err.message}]`, stream);
  }
}

// ============================================================
// Response formatting
// ============================================================

function sendOK(res, content, stream) {
  if (res.writableEnded) return;
  const id = `chatcmpl-${Date.now()}`, t = Math.floor(Date.now() / 1000);
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: t, model: 'claude-code', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: t, model: 'claude-code', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created: t, model: 'claude-code',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
  }
}

// Send response with structured tool_calls (OpenAI format)
function sendToolCallResponse(res, content, toolCalls, stream) {
  if (res.writableEnded) return;
  const id = `chatcmpl-${Date.now()}`, t = Math.floor(Date.now() / 1000);

  const message = {
    role: 'assistant',
    content: content || null,
    tool_calls: toolCalls
  };

  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    // Send content first if any
    if (content) {
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: t, model: 'claude-code', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
    }
    // Send each tool call
    for (const tc of toolCalls) {
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: t, model: 'claude-code', choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: t, model: 'claude-code', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created: t, model: 'claude-code',
      choices: [{ index: 0, message, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
  }
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ============================================================
// Server
// ============================================================

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  const url = req.url.split('?')[0];
  if (url === '/v1/chat/completions' && req.method === 'POST') await handleChat(req, res);
  else if (url === '/v1/models') send(res, 200, { object: 'list', data: [
    { id: 'claude-code', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' },
    { id: 'opus', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' },
    { id: 'sonnet', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' },
    { id: 'haiku', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' },
  ] });
  else if (url === '/health' || url === '/') send(res, 200, { status: 'ok', model: CLAUDE_MODEL });
  else send(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Claude Code Proxy | http://127.0.0.1:${PORT} | model=${CLAUDE_MODEL}`);
  log(`Features: --system-prompt override, tool call parsing (<tool_call> → OpenAI format), --effort high`);
});
