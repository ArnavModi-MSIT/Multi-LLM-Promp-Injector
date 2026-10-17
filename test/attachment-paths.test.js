import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { stageAttachmentPaths, validateAttachmentContent } from '../src/attachment-paths.js';
import { getProvider, providerIds, providerPrepareCode } from '../src/providers.js';

test('web files are staged once, reused as paths, and deleted on cleanup', async () => {
  const content = 'a'.repeat(1024 * 1024);
  const staged = await stageAttachmentPaths([{ name: 'review.md', buffer: Buffer.from(content) }]);
  const filename = staged.files[0].path;
  try {
    assert.equal(await fs.readFile(filename, 'utf8'), content);
    for (const id of providerIds) {
      const code = await providerPrepareCode(getProvider(id), 'test', staged.files);
      assert.ok(code.length < 15000);
      assert.ok(code.includes(JSON.stringify(filename)));
      assert.equal(code.includes(Buffer.from(content).toString('base64')), false);
    }
    const original = await stageAttachmentPaths([filename]);
    assert.equal(original.files[0].path, filename);
    await original.cleanup();
    assert.equal(await fs.readFile(filename, 'utf8'), content);
  } finally { await staged.cleanup(); }
  await assert.rejects(fs.access(filename), { code: 'ENOENT' });
});

test('text credential detection blocks markers without echoing their value', async () => {
  const values = ['-----BEGIN ' + 'PRIVATE KEY-----', 'AKIA' + '1234567890ABCDEF', 'ghp_' + 'a'.repeat(36)];
  for (const value of values) {
    assert.throws(() => validateAttachmentContent('notes.md', Buffer.from(value)), error => {
      assert.match(error.message, /Possible credential/);
      assert.equal(error.message.includes(value), false);
      return true;
    });
    await assert.rejects(stageAttachmentPaths([{ name: 'notes.md', buffer: Buffer.from(value) }]), /Possible credential/);
  }
});
