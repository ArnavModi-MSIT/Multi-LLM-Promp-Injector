import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runCli } from '../src/index.js';
import { parseCommandLine, providerOutputPath } from '../src/cli-options.js';

const quiet = { log() {}, error() {} };
const readline = { question: async () => '/quit', close() {} };

test('CLI rejects missing values, typos, and contradictory prompt options', () => {
  for (const args of [['--file'], ['--file', '--auto'], ['--output', ''], ['--typo'], ['unexpected'],
    ['--prompt', 'x', '--prompt-file', 'y'], ['--provider', 'chatgpt', '--providers', 'gemini']]) {
    assert.throws(() => parseCommandLine(args));
  }
  assert.deepEqual(parseCommandLine(['--file', 'one.md', '--file', 'two.md']).file, ['one.md', 'two.md']);
});

test('provider output filenames get one suffix, with or without .md', () => {
  for (const output of ['review.md', 'review.MD', 'review']) {
    assert.equal(providerOutputPath(output, 'gemini', 2, 'stamp'), path.resolve('review-gemini.md'));
  }
  assert.equal(providerOutputPath('exact.md', 'gemini', 1, 'stamp'), path.resolve('exact.md'));
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

test('an existing output target is rejected before any provider submission', async () => {
  let connected = false;
  const status = await runCli(['--prompt', 'test', '--auto', '--output', 'package.json'], {
    readline, logger: quiet, connect: async () => { connected = true; },
  });
  assert.equal(status, 1);
  assert.equal(connected, false);
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
        value = { captureId: provider.id, url: provider.url, previousReplies: 0, previousCopyButtons: 0 };
      }
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    },
    selectCapture: async (_, value, captureId) => {
      assert.equal(captureId, value.id);
      actions.push('select-capture:' + value.id);
    },
    captureAll: async (_, tasks) => {
      const outcomes = [];
      for (const task of tasks) {
        await task.beforePoll(); actions.push('capture:' + task.receipt.captureId);
        const response = { url: task.receipt.url };
        await task.onComplete(response); outcomes.push({ task, response });
      }
      return outcomes;
    },
  };
  return { actions, dependencies };
}

test('CLI sends every selected provider before capture and selects each submitted tab', async () => {
  const { actions, dependencies } = fixture();
  const status = await runCli(['--providers', 'chatgpt,gemini', '--prompt', 'test', '--auto'], dependencies);
  assert.equal(status, 0);
  assert.deepEqual(actions, ['send:chatgpt', 'send:gemini', 'select-capture:chatgpt', 'capture:chatgpt', 'select-capture:gemini', 'capture:gemini', 'close']);
});

test('dry run prevents sending even with --auto', async () => {
  const { actions, dependencies } = fixture();
  assert.equal(await runCli(['--prompt', 'test', '--auto', '--dry-run'], dependencies), 0);
  assert.deepEqual(actions, ['close']);
});

test('an uncertain send is never retried and later providers still run', async () => {
  const { actions, dependencies } = fixture();
  const original = dependencies.tool;
  let sends = 0;
  dependencies.tool = async (...args) => {
    if (args[2].code.includes('const receipt = await') && ++sends === 1) throw new Error('disconnected after click');
    return original(...args);
  };
  assert.equal(await runCli(['--providers', 'chatgpt,gemini', '--prompt', 'test', '--auto'], dependencies), 1);
  assert.equal(sends, 2);
  assert.deepEqual(actions, ['send:gemini', 'select-capture:gemini', 'capture:gemini', 'close']);
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
