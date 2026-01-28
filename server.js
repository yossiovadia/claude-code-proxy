#!/usr/bin/env node

const http = require('http');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 11480;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';

// Minimal executor prefix - keeps responses action-oriented
const EXECUTOR_PREFIX = 'Execute this task and report what you did: ';

function formatMessages(messages) {
  // Helper to extract text from content (string or array)
  const getContentText = (content) => {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n');
    }
    return String(content);
  };

  // Get just the user messages to understand the task
  const userMessages = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = getContentText(m.content);
      // Skip Clawdbot's compaction messages
      if (text.startsWith('The conversation history before this point was compacted')) {
        continue;
      }
      // Strip timestamp prefix from ClawdBot messages [WhatsApp +xxx ...]
      const cleanText = text.replace(/^\[WhatsApp[^\]]+\]\s*/i, '').trim();
      if (cleanText) {
        userMessages.push(cleanText);
      }
    }
  }

  // Use the last few user messages for context, but prioritize the most recent
  const recentMessages = userMessages.slice(-3);
  if (recentMessages.length === 0) {
    return '';
  }

  // If there are multiple messages, provide brief context
  if (recentMessages.length > 1) {
    const context = recentMessages.slice(0, -1).join(' | ');
    const task = recentMessages[recentMessages.length - 1];
    return EXECUTOR_PREFIX + `Context from earlier: ${context}\n\nCurrent task: ${task}`;
  }

  return EXECUTOR_PREFIX + recentMessages[0];
}

function callClaude(prompt) {
  // Escape single quotes in prompt
  const escaped = prompt.replace(/'/g, "'\\''");
  // Enable tools with --tools default, use JSON output to parse result
  const cmd = `claude -p '${escaped}' --tools default --output-format json --dangerously-skip-permissions --model ${CLAUDE_MODEL}`;

  console.log(`[${new Date().toISOString()}] Running: claude -p '${prompt.substring(0, 50)}...'`);

  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      timeout: 300000, // 5 min timeout for tool use
      maxBuffer: 10 * 1024 * 1024 // 10MB
    });

    // Parse JSON output and extract result
    try {
      const json = JSON.parse(output.trim());
      if (json.result) {
        console.log(`[${new Date().toISOString()}] Turns: ${json.num_turns}, Cost: $${json.total_cost_usd?.toFixed(4) || '0'}`);
        return json.result;
      }
      // Fallback if no result field
      return json.error || output.trim();
    } catch (parseErr) {
      // If not JSON, return raw output
      return output.trim();
    }
  } catch (err) {
    if (err.killed) {
      throw new Error('Claude timed out after 5 minutes');
    }
    throw new Error(`Claude failed: ${err.message.substring(0, 200)}`);
  }
}

async function handleChatCompletions(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  await new Promise(resolve => req.on('end', resolve));

  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const { messages, stream } = data;
  // Ignore tools and tool_choice - Claude Code has its own tools

  if (!messages || !Array.isArray(messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'messages array required' }));
    return;
  }

  // Filter to only user/assistant messages, skip system and tool messages
  const cleanMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');

  const prompt = formatMessages(cleanMessages);
  console.log(`[${new Date().toISOString()}] Request: ${prompt.substring(0, 150)}...`);

  try {
    const response = callClaude(prompt);

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      const chunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'claude-code',
        choices: [{ index: 0, delta: { role: 'assistant', content: response }, finish_reason: null }]
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const result = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'claude-code',
        choices: [{ index: 0, message: { role: 'assistant', content: response }, finish_reason: 'stop' }],
        usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(response.length / 4), total_tokens: Math.ceil((prompt.length + response.length) / 4) }
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }

    console.log(`[${new Date().toISOString()}] Response: ${response.substring(0, 100)}...`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error:`, err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleModels(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    object: 'list',
    data: [{ id: 'claude-code', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' }]
  }));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];

  if (url === '/v1/chat/completions' && req.method === 'POST') {
    await handleChatCompletions(req, res);
  } else if (url === '/v1/models' && req.method === 'GET') {
    handleModels(req, res);
  } else if (url === '/health' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'claude-code-proxy', model: CLAUDE_MODEL }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 Claude Code Proxy running at http://127.0.0.1:${PORT}`);
  console.log(`📦 Using model: ${CLAUDE_MODEL}`);
  console.log(`\nClawdbot config:\n`);
  console.log(JSON.stringify({
    models: {
      providers: {
        "claude-code": {
          baseUrl: `http://127.0.0.1:${PORT}/v1`,
          apiKey: "not-needed",
          models: [{ id: "claude-code", name: "Claude Code CLI", api: "openai-completions" }]
        }
      }
    }
  }, null, 2));
  console.log('\n');
});
