import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { runCli } from '../src/index.js';
import { parseCommandLine } from '../src/cli-options.js';

const quiet = { log() {}, error() {} };
const readline = { question: async () => '/quit', close() {} };

test('CLI rejects missing values, typos, and contradictory prompt options', () => {
  for (const args of [['--file'], ['--file', '--auto'], ['--output', ''], ['--typo'], ['unexpected'],
    ['--prompt', 'x', '--prompt-file', 'y'], ['--provider', 'chatgpt', '--providers', 'gemini']]) {
    assert.throws(() => parseCommandLine(args));
  }
  assert.deepEqual(parseCommandLine(['--file', 'one.md', '--file', 'two.md']).file, ['one.md', 'two.md']);
});

test('quit and invalid CLI input never connect to Chrome', async () => {
  let connections = 0;
  const dependencies = { readline, logger: quiet, connect: async () => { connections++; throw new Error('Must not connect'); } };
  assert.equal(await runCli(['--prompt', '/quit'], dependencies), 0);
  assert.equal(await runCli([], dependencies), 0);
  assert.equal(await runCli(['--file'], dependencies), 1);
  assert.equal(await runCli(['--prompt', ''], dependencies), 1);
  assert.equal(connections, 0);
});

test('CLI rejects ZIP for Qwen and DeepSeek before connecting, including mixed jobs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-injector-zip-test-'));
  const filename = path.join(directory, 'review.ZIP');
  await fs.writeFile(filename, 'Synthetic ZIP policy test');
  let connections = 0;
  try {
    for (const providers of ['qwen', 'deepseek', 'chatgpt,qwen']) {
      const messages = [];
      assert.equal(await runCli(['--providers', providers, '--prompt', 'review', '--file', filename, '--auto'], {
        readline, logger: { log() {}, error: text => messages.push(text) }, connect: async () => { connections++; },
      }), 1);
      assert.match(messages.join('\n'), /does not accept ZIP/);
    }
    assert.equal(connections, 0);
  } finally { await fs.unlink(filename); await fs.rmdir(directory); }
});

function fixture() {
  const actions = [];
  let provider;
  const dependencies = {
    readline, logger: quiet,
    connect: async () => ({ close: async () => { actions.push('close'); } }),
    select: async (_, value) => { provider = value; },
    tool: async (_, name, { code }) => {
      let value = {};
      if (code.includes('const patterns =')) value = { available: true };
      if (code.includes('const receipt = await')) {
        actions.push('send:' + provider.id);
        value = { submitted: true, url: provider.url };
      }
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    },
  };
  return { actions, dependencies };
}

test('CLI sends to selected providers and stops after submission', async () => {
  const { actions, dependencies } = fixture();
  const status = await runCli(['--providers', 'chatgpt,gemini', '--prompt', 'test', '--auto'], dependencies);
  assert.equal(status, 0);
  assert.deepEqual(actions, ['send:chatgpt', 'send:gemini', 'close']);
});

test('dry run prevents sending even with --auto', async () => {
  const { actions, dependencies } = fixture();
  assert.equal(await runCli(['--provider', 'chatgpt', '--prompt', 'test', '--auto', '--dry-run'], dependencies), 0);
  assert.deepEqual(actions, ['close']);
});

test('an uncertain send is never retried and later providers still run', async () => {
  const { actions, dependencies } = fixture();
  const original = dependencies.tool;
  let sends = 0;
  dependencies.tool = async (...args) => {
    if (args[2].code.includes('const receipt = await') && ++sends === 1) throw new Error('send confirmation timed out after click');
    return original(...args);
  };
  assert.equal(await runCli(['--providers', 'chatgpt,gemini', '--prompt', 'test', '--auto'], dependencies), 1);
  assert.equal(sends, 2);
  assert.deepEqual(actions, ['send:gemini', 'close']);
});

test('a confirmed disconnect stops remaining sends without retrying', async () => {
  const { actions, dependencies } = fixture();
  const original = dependencies.tool;
  let sends = 0;
  dependencies.tool = async (...args) => {
    if (args[2].code.includes('const receipt = await') && ++sends === 2) throw new Error('Transport closed after click');
    return original(...args);
  };
  assert.equal(await runCli(['--providers', 'chatgpt,gemini,qwen', '--prompt', 'test', '--auto'], dependencies), 1);
  assert.equal(sends, 2);
  assert.deepEqual(actions, ['send:chatgpt', 'close']);
});

test('--continue rejects non-ChatGPT and mixed providers before opening Chrome', async () => {
  for (const providers of ['gemini', 'chatgpt,claude']) {
    let opened = false;
    const status = await runCli(['--continue', '--providers', providers, '--prompt', 'test'], {
      readline, logger: quiet, connect: async () => { opened = true; },
    });
    assert.equal(status, 1); assert.equal(opened, false);
  }
});

test('CLI defaults to all six providers with no response or output operations', async () => {
  const { actions, dependencies } = fixture();
  assert.equal(await runCli(['--prompt', 'same prompt', '--auto'], dependencies), 0);
  assert.deepEqual(actions, ['send:chatgpt', 'send:gemini', 'send:deepseek', 'send:kimi', 'send:claude', 'send:qwen', 'close']);
  for (const args of [['--output', 'reply.md'], ['--timeout', '600'], ['--send-only']]) assert.throws(() => parseCommandLine(args));
});
