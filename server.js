#!/usr/bin/env node

const http = require('http');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 11480;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';

function formatMessages(messages) {
  // Helper to extract text from content (string or array)
  const getContentText = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n');
    }
    return String(content);
  };

  if (messages.length === 1 && messages[0].role === 'user') {
    return getContentText(messages[0].content);
  }
  return messages.map(m => {
    const text = getContentText(m.content);
    if (m.role === 'system') return `[System: ${text}]`;
    if (m.role === 'assistant') return `Assistant: ${text}`;
    return text;
  }).join('\n\n');
}

function callClaude(prompt) {
  // Escape single quotes in prompt
  const escaped = prompt.replace(/'/g, "'\\''");
  const cmd = `claude -p '${escaped}' --output-format text --dangerously-skip-permissions --model ${CLAUDE_MODEL}`;

  console.log(`[${new Date().toISOString()}] Running: claude -p '${prompt.substring(0, 50)}...'`);

  try {
    const result = execSync(cmd, {
      encoding: 'utf8',
      timeout: 120000, // 2 min timeout (reduce if rate-limited)
      maxBuffer: 10 * 1024 * 1024 // 10MB
    });
    return result.trim();
  } catch (err) {
    if (err.killed) {
      throw new Error('Claude timed out after 2 minutes - possible rate limiting');
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

  if (!messages || !Array.isArray(messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'messages array required' }));
    return;
  }

  const prompt = formatMessages(messages);
  console.log(`[${new Date().toISOString()}] Request: ${prompt.substring(0, 100)}...`);

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
