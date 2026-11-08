// Stands in for the `claude` CLI in the chat session tests. Controlled by the environment:
// FAKE_CLAUDE_VERSION      output of --version (default "2.1.316 (Claude Code)")
// FAKE_CLAUDE_LOGGED_IN    "false" makes `auth status --json` report loggedIn false
// FAKE_CLAUDE_RECORD       file that gets one JSON line per run: argv, cwd and environment
// FAKE_CLAUDE_MODE         "crash" (stderr and exit 3 at start), "stubborn" (ignores stdin end and SIGTERM)
// In the stream-json loop a user message "hang" starts a turn that only an interrupt ends, "big image"
// answers with a tool result carrying a 2 MB image, "ask" sends a control request to the host.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? '';
const record = process.env.FAKE_CLAUDE_RECORD;
if (record) appendFileSync(record, `${JSON.stringify({ argv: args, cwd: process.cwd(), pid: process.pid, env: process.env })}\n`);

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.316 (Claude Code)'}\n`);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_IN !== 'false';
  process.stdout.write(`${JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' }, null, 2)}\n`);
  process.exit(loggedIn ? 0 : 1);
}
if (mode === 'crash') {
  process.stderr.write('fatal: something broke\n');
  process.exit(3);
}

const session = 'fake-session';
let hanging = false;
emit({ type: 'system', subtype: 'init', session_id: session, tools: ['mcp__firefox__navigate'], cwd: process.cwd() });
process.stdout.write('this line is not JSON\n');

function textOf(content) {
  if (typeof content === 'string') return content;
  return content.find((block) => block.type === 'text')?.text ?? '';
}

function finishTurn(subtype) {
  emit({ type: 'result', subtype, is_error: subtype !== 'success', session_id: session });
}

function handle(message) {
  if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    if (hanging) {
      hanging = false;
      finishTurn('error_during_execution');
    }
    return;
  }
  if (message.type === 'control_response') {
    emit({ type: 'system', subtype: 'fake_control_response', response: message.response });
    return;
  }
  if (message.type !== 'user') return;
  const text = textOf(message.message.content);
  emit({ type: 'stream_event', event: { type: 'message_start' }, session_id: session });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `echo: ${text}` } } });
  if (text === 'hang') {
    hanging = true;
    return;
  }
  if (text === 'ask') {
    emit({ type: 'control_request', request_id: 'cli-1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    return;
  }
  if (text === 'big image') {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(2 * 1024 * 1024) } };
    emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'shot' }, image] }] },
    });
  }
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${text}` }] }, session_id: session });
  finishTurn('success');
}

if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim() !== '') handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => {
  if (mode !== 'stubborn') process.exit(0);
});
