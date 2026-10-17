import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { stageAttachmentPaths } from '../src/attachment-paths.js';
import { createAttachmentTransfer } from '../src/attachment-transfer.js';
import { getProvider, providerPrepareCode } from '../src/providers.js';

test('attachment transfer is token protected, bounded to staged files, and closed after use', async () => {
  const staged = await stageAttachmentPaths([{ name: 'notes.md', buffer: Buffer.from('Local transfer fixture') }]);
  const transfer = await createAttachmentTransfer(staged.files);
  const { url, token } = transfer.files[0].upload;
  const headers = { 'X-Attachment-Token': token };
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(url + '/../../other', { headers })).status, 404);
    assert.equal((await fetch(url, { method: 'POST', headers })).status, 405);
    const response = await fetch(url, { headers });
    assert.equal(await response.text(), 'Local transfer fixture');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { await transfer.close(); await staged.cleanup(); }
  await assert.rejects(fetch(url, { headers }));
});

test('MCP-compatible generated preparation sends buffers without filesystem permission or base64 code', async () => {
  const content = 'bounded file content '.repeat(10000);
  const staged = await stageAttachmentPaths([{ name: 'notes.md', buffer: Buffer.from(content) }]);
  const transfer = await createAttachmentTransfer(staged.files);
  try {
    const code = await providerPrepareCode(getProvider('qwen'), 'test', transfer.files);
    assert.equal(code.includes(Buffer.from(content).toString('base64')), false);
    let uploaded;
    const editor = { first() { return this; }, fill: async () => {}, evaluate: async (_, name) => name ? true : '' };
    const input = { last() { return this; }, count: async () => 1, getAttribute: async () => 'multiple', setInputFiles: async payload => {
      assert.ok(payload.every(file => Buffer.isBuffer(file.buffer)), 'local paths must never reach the extension upload');
      uploaded = payload;
    } };
    const page = { url: () => 'https://chat.qwen.ai/',
      locator: selector => selector === 'input[type="file"]' ? { evaluateAll: async () => false } : selector.startsWith('input[type="file"]') ? input : editor,
      getByRole: () => ({ filter() { return this; }, count: async () => 0 }),
    };
    // Match the upstream unsafe runner's VM: fetch/Buffer, no Node imports.
    const context = vm.createContext({ page, fetch, Buffer, URL, AbortSignal });
    const prepare = vm.runInContext('(' + code + ')', context);
    await prepare(page);
    assert.equal(uploaded[0].name, 'notes.md');
    assert.equal(uploaded[0].buffer.toString(), content);
  } finally { await transfer.close(); await staged.cleanup(); }
});
