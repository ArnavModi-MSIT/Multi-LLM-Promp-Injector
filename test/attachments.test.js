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
    const editor = { first() { return this; }, async fill() {}, async evaluate() { return true; } };
    const input = {
      last() { return this; },
      async count() { return 1; },
      async getAttribute() { return 'multiple'; },
      async setInputFiles(payloads) { uploaded = payloads; },
    };
    const page = {
      url: () => provider.url,
      locator: selector => selector === 'input[type="file"]' ? { evaluateAll: async () => false } : selector.startsWith('input[type="file"]') ? input : editor,
      getByRole: () => ({ filter() { return this; }, count: async () => 0 }),
      getByText: () => ({ first() { return this; }, async count() { return 1; }, async isVisible() { return true; }, async waitFor() {} }),
    };
    const result = await prepare(page);
    assert.deepEqual(uploaded.map(file => file.name), ['plan.md', 'notes.txt']);
    assert.equal(result.attachmentCount, 2);
  }
});

test('refuses stale attachments before changing the prompt, even with no new files', async () => {
  for (const id of ['chatgpt', 'gemini', 'deepseek', 'kimi', 'claude']) {
    for (const selectedFiles of [false, true]) {
      const provider = getProvider(id);
      let filled = false;
      const editor = { first() { return this; }, fill: async () => { filled = true; } };
      const page = {
        url: () => provider.url,
        locator: selector => selector === 'input[type="file"]' ? { evaluateAll: async () => selectedFiles } : editor,
        getByRole: () => ({ filter() { return this; }, count: async () => selectedFiles ? 0 : 1 }),
      };
      const prepare = new Function('return ' + await providerPrepareCode(provider, 'new prompt'))();
      await assert.rejects(prepare(page), /Existing attachments/);
      assert.equal(filled, false);
    }
  }
});

test('recognizes full filename metadata behind a truncated attachment card', async () => {
  const { attachmentVisible } = await import('../src/attachment-visible.js');
  const card = { tagName: 'DIV', getClientRects: () => [1], textContent: 'GlucoTwin_...', getAttribute: attribute => attribute === 'title' ? 'GlucoTwin_AI_Review_2026-10-10.zip' : null };
  const scope = { querySelectorAll: () => [card] };
  const editor = { parentElement: { ...scope, querySelector: () => null }, contains: () => false };
  assert.equal(attachmentVisible(editor, 'GlucoTwin_AI_Review_2026-10-10.zip'), true);
  assert.equal(attachmentVisible(editor, 'missing.zip'), false);
});

test('does not accept ambiguous truncation or a selected file input as upload confirmation', async () => {
  const { attachmentVisible } = await import('../src/attachment-visible.js');
  const nodes = [
    { tagName: 'DIV', getClientRects: () => [1], textContent: 'GlucoTwin_...', getAttribute: () => null },
    { tagName: 'INPUT', files: [{ name: 'GlucoTwin_AI_Review.zip' }] },
  ];
  const editor = { parentElement: { querySelector: () => null, querySelectorAll: () => nodes }, contains: () => false };
  assert.equal(attachmentVisible(editor, 'GlucoTwin_AI_Review.zip'), false);
});

test('finds attachment cards outside an inner form without searching history', async () => {
  const { attachmentVisible } = await import('../src/attachment-visible.js');
  const card = { tagName: 'DIV', getClientRects: () => [1], textContent: 'MAE_REVIEW_HANDOFF.md', getAttribute: () => null };
  const main = { tagName: 'MAIN', querySelector: () => ({}) };
  const draft = { tagName: 'DIV', parentElement: main, querySelector: () => null, querySelectorAll: () => [card] };
  const form = { tagName: 'FORM', parentElement: draft, querySelector: () => null, querySelectorAll: () => [] };
  const editor = { parentElement: form, contains: () => false };
  assert.equal(attachmentVisible(editor, 'MAE_REVIEW_HANDOFF.md'), true);
  draft.querySelectorAll = () => [];
  assert.equal(attachmentVisible(editor, 'MAE_REVIEW_HANDOFF.md'), false);
});
