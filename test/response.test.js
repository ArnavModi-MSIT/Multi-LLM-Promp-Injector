import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectResponse } from '../src/response.js';

function fixture(states) {
  let time = 0;
  let index = 0;
  return {
    client: { callTool: async () => {
      const state = states[Math.min(index++, states.length - 1)];
      if (state instanceof Error) throw state;
      return { content: [{ type: 'text', text: JSON.stringify(state) }] };
    } },
    clock: { now: () => time, wait: async ms => { time += ms; } },
  };
}

test('capture preserves and saves partial text on browser failure after a rerender', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-injector-response-'));
  try {
    const target = path.join(root, 'reply.md');
    const { client, clock } = fixture([
      { text: 'partial reply', generating: true, complete: false, url: 'https://chatgpt.com/c/test' },
      { text: '', generating: true, complete: false },
      new Error('connection closed'),
    ]);
    await assert.rejects(collectResponse(client, { url: '' }, target, 10000, () => '', 'ChatGPT', () => {}, clock), error => {
      assert.equal(error.partial.text, 'partial reply');
      assert.match(error.message, /Partial response saved/);
      return true;
    });
    const partial = await fs.readFile(target + '.partial.md', 'utf8');
    assert.match(partial, /\(partial\)/);
    assert.match(partial, /partial reply/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('completion requires quiet text and no active generation, even with Copy controls', async () => {
  const { client, clock } = fixture([{ text: 'unfinished', complete: false, generating: true, finishedControls: true }]);
  await assert.rejects(collectResponse(client, {}, null, 12000, () => '', 'ChatGPT', () => {}, clock), error => {
    assert.equal(error.partial.text, 'unfinished');
    assert.match(error.message, /completion was not confirmed/);
    return true;
  });
});

test('a stable completed response is returned after the required observations', async () => {
  const { client, clock } = fixture([{ text: 'done', complete: true, generating: false, finishedControls: true }]);
  const response = await collectResponse(client, {}, null, 12000, () => '', 'ChatGPT', () => {}, clock);
  assert.equal(response.text, 'done');
  assert.equal(clock.now(), 8000);
});

test('a raced output collision preserves the existing file and saves the reply separately', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-injector-response-'));
  try {
    const target = path.join(root, 'reply.md');
    await fs.writeFile(target, 'existing output');
    const { client, clock } = fixture([{ text: 'new reply', complete: true, finishedControls: true }]);
    await assert.rejects(collectResponse(client, {}, target, 12000, () => '', 'ChatGPT', () => {}, clock), error => {
      assert.equal(error.partial.text, 'new reply');
      assert.match(error.message, /Partial response saved/);
      return true;
    });
    assert.equal(await fs.readFile(target, 'utf8'), 'existing output');
    assert.match(await fs.readFile(target + '.partial.md', 'utf8'), /new reply/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
