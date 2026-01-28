#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 11480;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';

// Minimal executor prefix - keeps responses action-oriented
const EXECUTOR_PREFIX = 'Execute this task and report what you did: ';

// Extract workspace directory from ClawdBot's system message
function extractWorkspace(messages) {
  const systemMsg = messages.find(m => m.role === 'system');
  if (!systemMsg) return null;

  const content = typeof systemMsg.content === 'string'
    ? systemMsg.content
    : systemMsg.content?.map(p => p.text).join('\n') || '';

  // Look for "Your working directory is: /path"
  const workdirMatch = content.match(/Your working directory is:\s*(\S+)/);
  if (workdirMatch) {
    return workdirMatch[1].replace(/^~/, process.env.HOME);
  }

  return null;
}

// Extract persona (SOUL.md, IDENTITY.md) from ClawdBot's system message
function extractPersona(messages) {
  const systemMsg = messages.find(m => m.role === 'system');
  if (!systemMsg) return null;

  const content = typeof systemMsg.content === 'string'
    ? systemMsg.content
    : systemMsg.content?.map(p => p.text).join('\n') || '';

  // Extract key persona sections
  const sections = [];

  // IDENTITY.md
  const identityMatch = content.match(/## IDENTITY\.md\n([\s\S]*?)(?=\n## [A-Z]|\n# |$)/);
  if (identityMatch) sections.push(identityMatch[1].trim());

  // SOUL.md (abbreviated - just core truths)
  const soulMatch = content.match(/## SOUL\.md\n([\s\S]*?)(?=\n## [A-Z]|\n# |$)/);
  if (soulMatch) {
    // Extract just the first few paragraphs to keep it brief
    const soulContent = soulMatch[1].trim().split('\n\n').slice(0, 3).join('\n\n');
    sections.push(soulContent);
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

// Detect if request is conversational vs coding task
function isConversationalRequest(text) {
  // Strip platform prefixes first (WhatsApp, Telegram, etc.)
  let cleaned = text
    .replace(/^\[WhatsApp[^\]]+\]\s*/i, '')
    .replace(/^\[Telegram[^\]]+\]\s*/i, '')
    .replace(/^\[Discord[^\]]+\]\s*/i, '')
    .replace(/^\[Slack[^\]]+\]\s*/i, '')
    .replace(/^\[Signal[^\]]+\]\s*/i, '')
    .replace(/\[message_id:[^\]]+\]\s*/gi, '')
    .trim();

  const lower = cleaned.toLowerCase().trim();

  // Coding indicators
  const codingPatterns = [
    /\b(fix|implement|create|write|edit|refactor|debug|test|deploy|build|run|execute|compile|install)\b/,
    /\b(function|class|method|variable|file|code|script|program|api|endpoint|database|server)\b/,
    /\b(bug|error|issue|pr|pull request|commit|branch|merge|git)\b/,
    /\buse\s+\w+\s+skill\b/,
  ];

  for (const pattern of codingPatterns) {
    if (pattern.test(lower)) return false;
  }

  // Conversational indicators
  const conversationalPatterns = [
    /^(hi|hello|hey|what's up|how are you)/,
    /^(what is|what are|what's|who is|who are|where is|why|how does|can you explain)/,
    /\?$/,  // Questions
    /^(tell me|explain|describe|summarize)/,
    /^(thanks|thank you|ok|okay|great|cool|nice)/,
  ];

  for (const pattern of conversationalPatterns) {
    if (pattern.test(lower)) return true;
  }

  // Short messages are often conversational
  if (lower.length < 50 && !lower.includes('file') && !lower.includes('code')) {
    return true;
  }

  return false;
}

// Extract available skills from ClawdBot's system message
function extractSkills(messages) {
  const systemMsg = messages.find(m => m.role === 'system');
  if (!systemMsg) return [];

  const content = typeof systemMsg.content === 'string'
    ? systemMsg.content
    : systemMsg.content?.map(p => p.text).join('\n') || '';

  const skills = [];
  const skillRegex = /<skill>\s*<name>([^<]+)<\/name>\s*<description>([^<]+)<\/description>\s*<location>([^<]+)<\/location>\s*<\/skill>/g;

  let match;
  while ((match = skillRegex.exec(content)) !== null) {
    skills.push({
      name: match[1].trim(),
      description: match[2].trim(),
      location: match[3].trim()
    });
  }

  return skills;
}

// Check if user message mentions a skill and return the skill info
function findMentionedSkill(userMessage, skills) {
  const lower = userMessage.toLowerCase();

  // Build list of skill name variants for matching
  const skillVariantsMap = new Map();
  for (const skill of skills) {
    const variants = [
      skill.name.toLowerCase(),
      skill.name.replace(/-/g, '').toLowerCase(),
      skill.name.replace('claude-code-', '').toLowerCase(),
      skill.name.replace(/-/g, ' ').toLowerCase()
    ];
    for (const v of variants) {
      skillVariantsMap.set(v, skill);
    }
  }

  // Pattern 1: "use X skill" or "X skill to"
  const useSkillMatch = lower.match(/use\s+(\w+(?:-\w+)*)\s+skill/i) ||
                        lower.match(/(\w+(?:-\w+)*)\s+skill\s+to/i);

  if (useSkillMatch) {
    const requestedSkill = useSkillMatch[1].toLowerCase();
    console.log(`[${new Date().toISOString()}] Looking for skill (pattern 1): "${requestedSkill}"`);

    for (const [variant, skill] of skillVariantsMap) {
      if (variant === requestedSkill ||
          variant.startsWith(requestedSkill) ||
          requestedSkill.startsWith(variant.substring(0, 4))) {
        return skill;
      }
    }
  }

  // Pattern 2: "use [known-skill-name] to" without the word "skill"
  // Check if any known skill name appears after "use" and before "to"
  const useToMatch = lower.match(/use\s+(\w+(?:-\w+)*)\s+to\b/i);
  if (useToMatch) {
    const potentialSkill = useToMatch[1].toLowerCase();
    console.log(`[${new Date().toISOString()}] Looking for skill (pattern 2): "${potentialSkill}"`);

    for (const [variant, skill] of skillVariantsMap) {
      if (variant === potentialSkill ||
          variant.startsWith(potentialSkill) ||
          potentialSkill.startsWith(variant.substring(0, 4))) {
        return skill;
      }
    }
  }

  return null;
}

// Read a skill's SKILL.md file and expand path variables
function readSkillFile(location) {
  try {
    // Handle ~ in path
    const expandedPath = location.replace(/^~/, process.env.HOME);
    let content = fs.readFileSync(expandedPath, 'utf8');

    // Derive SKILL_ROOT from the file path
    // If path is /path/to/skill/clawdbot-skill/SKILL.md, root is /path/to/skill
    let skillRoot = expandedPath;
    if (skillRoot.endsWith('/SKILL.md')) {
      skillRoot = skillRoot.slice(0, -'/SKILL.md'.length);
    }
    if (skillRoot.endsWith('/clawdbot-skill')) {
      skillRoot = skillRoot.slice(0, -'/clawdbot-skill'.length);
    }

    // Replace <SKILL_ROOT> placeholder with actual path
    content = content.replace(/<SKILL_ROOT>/g, skillRoot);
    console.log(`[${new Date().toISOString()}] SKILL_ROOT resolved to: ${skillRoot}`);

    return content;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to read skill file: ${location}`, err.message);
    return null;
  }
}

// Helper to extract text from content (string or array)
function getContentText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n');
  }
  return String(content);
}

// Strip platform prefixes from messages
function stripPlatformPrefix(text) {
  return text
    .replace(/^\[WhatsApp[^\]]+\]\s*/i, '')
    .replace(/^\[Telegram[^\]]+\]\s*/i, '')
    .replace(/^\[Discord[^\]]+\]\s*/i, '')
    .replace(/^\[Slack[^\]]+\]\s*/i, '')
    .replace(/\[message_id:[^\]]+\]\s*/gi, '')
    .trim();
}

function formatMessages(messages, useExecutorPrefix = false) {
  // Build conversation history (last few exchanges)
  const exchanges = [];
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      const text = getContentText(m.content);
      // Skip compaction messages
      if (text.startsWith('The conversation history before this point was compacted')) {
        continue;
      }
      const cleanText = m.role === 'user' ? stripPlatformPrefix(text) : text;
      if (cleanText) {
        exchanges.push({ role: m.role, text: cleanText });
      }
    }
  }

  if (exchanges.length === 0) {
    return '';
  }

  // Get the current question (last user message)
  const lastUserIdx = exchanges.map(e => e.role).lastIndexOf('user');
  if (lastUserIdx === -1) return '';

  const currentQuestion = exchanges[lastUserIdx].text;
  const prefix = useExecutorPrefix ? EXECUTOR_PREFIX : '';

  // If only one message, just return it
  if (exchanges.length <= 1) {
    return prefix + currentQuestion;
  }

  // Build context from previous exchanges (limit to last 3 exchanges before current)
  const contextExchanges = exchanges.slice(Math.max(0, lastUserIdx - 4), lastUserIdx);

  if (contextExchanges.length === 0) {
    return prefix + currentQuestion;
  }

  // Format context concisely
  const contextLines = contextExchanges.map(e => {
    const label = e.role === 'user' ? 'User' : 'Assistant';
    // Truncate long messages in context
    const text = e.text.length > 300 ? e.text.substring(0, 300) + '...' : e.text;
    return `${label}: ${text}`;
  });

  console.log(`[${new Date().toISOString()}] Including ${contextExchanges.length} context exchanges`);

  // Frame context so Claude knows to use it only if relevant
  return `${prefix}[Recent conversation for context - use only if relevant to the current question]
${contextLines.join('\n')}

[Current question - answer this directly]
${currentQuestion}`;
}

function callClaude(prompt, options = {}) {
  const { workspace, useTools = true } = options;

  // Escape single quotes in prompt
  const escaped = prompt.replace(/'/g, "'\\''");

  // Build command - disable tools for conversational requests
  const toolsFlag = useTools ? '--tools default' : '';
  const cmd = `claude -p '${escaped}' ${toolsFlag} --output-format json --dangerously-skip-permissions --model ${CLAUDE_MODEL}`;

  // Determine working directory
  const cwd = workspace || process.env.HOME;

  console.log(`[${new Date().toISOString()}] Running from: ${cwd}`);
  console.log(`[${new Date().toISOString()}] Tools: ${useTools ? 'enabled' : 'disabled'}`);
  console.log(`[${new Date().toISOString()}] Running: claude -p '${prompt.substring(0, 50)}...'`);

  try {
    const output = execSync(cmd, {
      cwd,
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

  const { messages, stream, tools, tool_choice } = data;
  // Log full request for debugging
  fs.writeFileSync('last-request.json', JSON.stringify(data, null, 2));
  console.log(`[${new Date().toISOString()}] Tools present: ${tools?.length || 0}, tool_choice: ${JSON.stringify(tool_choice)}`)

  if (!messages || !Array.isArray(messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'messages array required' }));
    return;
  }

  // Extract context from ClawdBot's system message
  const skills = extractSkills(messages);
  const workspace = extractWorkspace(messages);
  const persona = extractPersona(messages);

  console.log(`[${new Date().toISOString()}] Found ${skills.length} ClawdBot skills`);
  console.log(`[${new Date().toISOString()}] Workspace: ${workspace || 'not specified'}`);
  console.log(`[${new Date().toISOString()}] Persona: ${persona ? 'extracted' : 'not found'}`);

  // Filter to only user/assistant messages, skip system and tool messages
  const cleanMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');

  // Only use executor prefix when client expects tool usage
  const hasTools = tools && tools.length > 0;
  let prompt = formatMessages(cleanMessages, false); // Don't use executor prefix by default

  // Check if user is asking to use a ClawdBot skill
  const lastUserMsg = cleanMessages.filter(m => m.role === 'user').pop();
  // Extract text from content (handle both string and array formats)
  let lastUserText = '';
  if (lastUserMsg?.content) {
    if (typeof lastUserMsg.content === 'string') {
      lastUserText = lastUserMsg.content;
    } else if (Array.isArray(lastUserMsg.content)) {
      lastUserText = lastUserMsg.content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
    }
  }
  console.log(`[${new Date().toISOString()}] Last user text: ${lastUserText.substring(0, 100)}...`);
  const mentionedSkill = findMentionedSkill(lastUserText, skills);

  // Determine request type and build appropriate prompt
  const isConversational = isConversationalRequest(lastUserText);
  let useTools = true;

  if (mentionedSkill) {
    // Skill request - inject skill instructions
    console.log(`[${new Date().toISOString()}] Skill detected: ${mentionedSkill.name} at ${mentionedSkill.location}`);
    const skillContent = readSkillFile(mentionedSkill.location);
    if (skillContent) {
      prompt = `You are helping with a ClawdBot skill called "${mentionedSkill.name}".

Here are the skill instructions (SKILL.md):
---
${skillContent}
---

User request: ${prompt}

Follow the skill instructions above to complete this task. Use bash commands as specified in the skill.`;
      console.log(`[${new Date().toISOString()}] Injected skill content (${skillContent.length} chars)`);
    }
  } else if (isConversational && persona) {
    // Conversational request - inject persona, disable tools
    console.log(`[${new Date().toISOString()}] Conversational request detected, injecting persona`);
    useTools = false;
    prompt = `${persona}

---

Respond naturally and conversationally. You are NOT in coding mode - just be helpful and friendly.

User: ${prompt}`;
  } else if (!isConversational) {
    // Coding request without specific skill - use executor prefix
    console.log(`[${new Date().toISOString()}] Coding request detected`);
    prompt = EXECUTOR_PREFIX + prompt;
  }

  console.log(`[${new Date().toISOString()}] Mode: ${mentionedSkill ? 'skill' : isConversational ? 'conversational' : 'coding'}`);
  console.log(`[${new Date().toISOString()}] Request: ${prompt.substring(0, 150)}...`);

  try {
    const response = callClaude(prompt, { workspace, useTools });

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
