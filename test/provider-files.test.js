import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getProvider, validateProviderFiles, providerPrepareCode, providerSubmissionCode } from '../src/providers.js';

test('Qwen supports five files and rejects a sixth with its free-tier limit', () => {
  const files = Array.from({ length: 6 }, (_, index) => ({ name: `notes-${index}.txt` }));
  assert.doesNotThrow(() => validateProviderFiles(getProvider('qwen'), files.slice(0, 5)));
  assert.throws(() => validateProviderFiles(getProvider('qwen'), files), /Qwen free tier accepts at most 5 files/);
});

test('DeepSeek and Qwen reject ZIP extensions and MIME labels before preparation', async () => {
  for (const id of ['deepseek', 'qwen']) {
    const provider = getProvider(id);
    for (const file of [{ name: 'review.ZIP' }, { name: 'review.bin', mimeType: 'Application/Zip; charset=binary' },
      { name: 'review.bin', mimeType: 'application/x-zip-compressed' }]) {
      assert.throws(() => validateProviderFiles(provider, [file]), /does not accept ZIP/);
      await assert.rejects(providerPrepareCode(provider, 'review', [{ ...file, path: path.resolve(file.name) }]), /does not accept ZIP/);
    }
    assert.doesNotThrow(() => validateProviderFiles(provider, [{ name: 'notes.md', mimeType: 'text/markdown' }]));
  }
});

test('Send rechecks the prompt and manifest before clicking and marks the tab first', async () => {
  for (const id of ['chatgpt', 'qwen']) {
    let clicked = false;
    const file = { name: 'notes.md' };
    let changedPrompt = true;
    const composer = { first() { return this; }, evaluate: async (_, name) => name ? false : changedPrompt ? 'edited' : 'expected' };
    const page = { url: () => getProvider(id).url, locator: () => composer, getByRole() { clicked = true; throw new Error('Must reject before locating Send'); } };
    const send = new Function('return ' + providerSubmissionCode(getProvider(id), 'marked-before-send', 'expected', [file]))();
    await assert.rejects(send(page), /prompt changed before Send/);
    assert.equal(page.__promptInjectorCaptureId, 'marked-before-send');
    changedPrompt = false;
    await assert.rejects(send(page), /attachment is missing before Send/);
    assert.equal(clicked, false);
  }
});
