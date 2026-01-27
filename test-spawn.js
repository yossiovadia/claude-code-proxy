#!/usr/bin/env node

const { spawn, execSync } = require('child_process');

// Test 1: execSync (blocking)
console.log('Test 1: execSync...');
try {
  const result = execSync('claude -p "Say OK" --output-format text --dangerously-skip-permissions', {
    encoding: 'utf8',
    timeout: 30000
  });
  console.log('execSync result:', result.trim());
} catch (e) {
  console.log('execSync error:', e.message);
}

// Test 2: spawn with shell
console.log('\nTest 2: spawn with shell...');
const proc = spawn('claude', ['-p', 'Say OK', '--output-format', 'text', '--dangerously-skip-permissions'], {
  shell: true,
  stdio: ['pipe', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';

proc.stdout.on('data', (data) => {
  stdout += data.toString();
  console.log('stdout chunk:', data.toString());
});

proc.stderr.on('data', (data) => {
  stderr += data.toString();
  console.log('stderr chunk:', data.toString());
});

proc.on('close', (code) => {
  console.log('spawn exited with code:', code);
  console.log('stdout:', stdout.trim());
  console.log('stderr:', stderr.trim());
});

proc.on('error', (err) => {
  console.log('spawn error:', err);
});
