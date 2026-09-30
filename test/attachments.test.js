import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAttachmentList, maxFileBytes, maxTotalBytes } from '../src/attachments.js';
import { getProvider, providerPrepareCode } from '../src/providers.js';

test('accepts several distinct files within the shared size limit', () => {
  assert.equal(validateAttachmentList([
    { name: 'plan.md', size: 12 },
    { name: 'notes.txt', size: 30 },
  ]).length, 2);
});

test('rejects oversized and ambiguous attachment lists', () => {
  assert.throws(() => validateAttachmentList([{ name: 'large.pdf', size: maxFileBytes + 1 }]), /10 MB/);
  assert.throws(() => validateAttachmentList([
    { name: 'one.bin', size: maxFileBytes },
    { name: 'two.bin', size: maxTotalBytes - maxFileBytes + 1 },
  ]), /10 MB|20 MB/);
  assert.throws(() => validateAttachmentList([
    { name: 'plan.md', size: 1 },
    { name: 'plan.txt', size: 1 },
  ]), /distinct names/);
});

test('passes every file to a multi-file input for ChatGPT and Gemini', async () => {
  const files = [
    { name: 'plan.md', mimeType: 'text/markdown', buffer: Buffer.from('plan') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') },
  ];
  for (const id of ['chatgpt', 'gemini']) {
    const provider = getProvider(id);
    const code = await providerPrepareCode(provider, 'Summarize both', files);
    const prepare = new Function(`return ${code}`)();
    let uploaded;
    const editor = { first() { return this; }, async fill() {} };
    const input = {
      last() { return this; },
      async count() { return 1; },
      async getAttribute() { return 'multiple'; },
      async setInputFiles(payloads) { uploaded = payloads; },
    };
    const page = {
      url: () => provider.url,
      locator: selector => selector.startsWith('input[type="file"]') ? input : editor,
      getByText: () => ({ first() { return this; }, async count() { return 1; }, async isVisible() { return true; }, async waitFor() {} }),
    };
    const result = await prepare(page);
    assert.deepEqual(uploaded.map(file => file.name), ['plan.md', 'notes.txt']);
    assert.equal(result.attachmentCount, 2);
  }
});
