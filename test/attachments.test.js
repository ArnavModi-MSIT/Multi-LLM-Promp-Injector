import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateAttachmentList, attachmentMimeType, maxFileBytes, maxTotalBytes } from '../src/attachments.js';
import { getProvider, providerIds, providerReadyCode, providerPrepareCode } from '../src/providers.js';

test('accepts several distinct files within the shared size limit', () => {
  assert.equal(validateAttachmentList([
    { name: 'plan.md', size: 12 },
    { name: 'notes.txt', size: 30 },
  ]).length, 2);
});

test('all adapters share MIME mappings and reject obvious credential filenames', () => {
  assert.equal(attachmentMimeType('data.csv'), 'text/csv');
  assert.equal(attachmentMimeType('data.json'), 'application/json');
  assert.equal(attachmentMimeType('data.zip'), 'application/zip');
  for (const name of ['id_ed25519', '.npmrc', 'secret.pfx', '.git-credentials']) {
    assert.throws(() => validateAttachmentList([{ name, size: 1 }]), /credentials/);
  }
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

test('credential MIME types are rejected even behind an ordinary filename', () => {
  for (const mimeType of ['application/x-pem-file', 'application/pkcs12', 'application/x-pkcs12',
    'application/pkcs8', 'application/pkcs8-encrypted', ' Application/X-PKCS12; charset=binary ']) {
    assert.throws(() => attachmentMimeType('notes.txt', mimeType), /credentials/);
    assert.throws(() => validateAttachmentList([{ name: 'notes.txt', size: 1, mimeType }]), /credentials/);
  }
  assert.equal(attachmentMimeType('notes.txt', 'text/plain'), 'text/plain');
});

test('every provider rejects non-HTTPS schemes before inspecting page controls', async () => {
  for (const id of providerIds) {
    const provider = getProvider(id);
    const ready = new Function('return ' + providerReadyCode(provider))();
    for (const url of [`http://${provider.hosts[0]}/`, 'file:///tmp/page.html', 'blob:https://chatgpt.com/id', 'data:text/html,hello']) {
      await assert.rejects(ready({ url: () => url, locator() { throw new Error('Must not inspect untrusted page'); } }), /Selected tab is not/);
    }
  }
});

test('passes every file to a multi-file input for ChatGPT and Gemini', async () => {
  const files = [
    { name: 'plan.md', path: path.resolve('plan.md') },
    { name: 'notes.txt', path: path.resolve('notes.txt') },
  ];
  for (const id of ['chatgpt', 'gemini']) {
    const provider = getProvider(id);
    const code = await providerPrepareCode(provider, 'Summarize both', files);
    const prepare = new Function(`return ${code}`)();
    let uploaded;
    const editor = { first() { return this; }, async fill() {}, async evaluate(fn, name) { return name ? true : ''; } };
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
    assert.deepEqual(uploaded.map(file => path.basename(file)), ['plan.md', 'notes.txt']);
    assert.equal(result.attachmentCount, 2);
  }
});

test('upload menus can reveal a file input without emitting a filechooser event', async () => {
  const provider = getProvider('gemini');
  const files = ['first.md', 'second.md'].map(name => ({ name, path: path.resolve(name) }));
  const prepare = new Function('return ' + await providerPrepareCode(provider, 'review', files))();
  let revealed = false;
  let uploaded;
  const empty = { filter() { return this; }, count: async () => 0 };
  const editor = { first() { return this; }, evaluate: async (_, name) => name ? Boolean(uploaded) : '', fill: async () => {} };
  const input = { last() { return this; }, count: async () => Number(revealed), getAttribute: async () => '', setInputFiles: async values => { uploaded = values; } };
  const page = {
    url: () => provider.url,
    locator: selector => selector === 'input[type="file"]' ? { evaluateAll: async () => false } : selector.startsWith('input[type="file"]') ? input : editor,
    getByRole: (role, { name }) => {
      if (role === 'menuitem') return { filter() { return this; }, count: async () => 1, click: async () => { revealed = true; } };
      if (name.test('Attach')) return { filter() { return this; }, count: async () => 1, click: async () => {} };
      return empty;
    },
    waitForEvent: async () => { throw new Error('No filechooser event'); },
  };
  assert.equal((await prepare(page)).attachmentCount, 2);
  assert.deepEqual(uploaded, files.map(file => file.path));
});

test('refuses stale attachments before changing the prompt, even with no new files', async () => {
  for (const id of providerIds) {
    for (const selectedFiles of [false, true]) {
      const provider = getProvider(id);
      let filled = false;
      const editor = { first() { return this; }, evaluate: async () => '', fill: async () => { filled = true; } };
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

test('recognizes attachment metadata in a draft main without accepting conversation history', async () => {
  const { attachmentVisible } = await import('../src/attachment-visible.js');
  const card = { tagName: 'IMG', getClientRects: () => [1], getAttribute: attr => attr === 'alt' ? 'HACKATHON_CONTEXT.md' : null };
  const body = { tagName: 'BODY' };
  const main = { tagName: 'MAIN', parentElement: body, querySelector: () => null, querySelectorAll: () => [card] };
  const form = { tagName: 'FORM', parentElement: main, querySelector: () => null, querySelectorAll: () => [] };
  const editor = { parentElement: form, contains: () => false };
  assert.equal(attachmentVisible(editor, 'HACKATHON_CONTEXT.md'), true);
  main.querySelector = () => ({}); // History in this ancestor must stop traversal.
  assert.equal(attachmentVisible(editor, 'HACKATHON_CONTEXT.md'), false);
});

test('preparation protects a nonempty unsent draft on every provider', async () => {
  for (const id of providerIds) {
    let filled = false;
    const editor = { first() { return this; }, evaluate: async () => 'my existing draft', fill: async () => { filled = true; } };
    const page = { url: () => getProvider(id).url, locator: () => editor };
    const prepare = new Function('return ' + await providerPrepareCode(getProvider(id), 'replacement'))();
    await assert.rejects(prepare(page), /unsent draft/);
    assert.equal(filled, false);
  }
});

test('a job-created fresh tab can replace restored text once; existing tabs stay protected', async () => {
  const provider = getProvider('chatgpt');
  const prepare = new Function('return ' + await providerPrepareCode(provider, 'new request'))();
  let text = 'restored from an earlier tab';
  const editor = { first() { return this; }, evaluate: async () => text, fill: async value => { text = value; } };
  const page = { __promptInjectorFreshTab: true, url: () => provider.url,
    locator: selector => selector === 'input[type="file"]' ? { evaluateAll: async () => false } : selector.startsWith('input[type="file"]') ? { last() { return this; }, count: async () => 0 } : editor,
    getByRole: () => ({ filter() { return this; }, count: async () => 0 }),
  };
  await prepare(page);
  assert.equal(text, 'new request');
  assert.equal(page.__promptInjectorFreshTab, false);
  await assert.rejects(prepare(page), /unsent draft/);
});

test('one preparation budget covers all five attachment confirmations', async () => {
  let now = 0;
  const files = Array.from({ length: 5 }, (_, i) => ({ name: `file-${i}.md`, path: path.resolve(`file-${i}.md`) }));
  const code = await providerPrepareCode(getProvider('deepseek'), 'test', files);
  const prepare = new Function('Date', 'return ' + code)({ now: () => now });
  const editor = { first() { return this; }, fill: async () => {}, evaluate: async (_, name) => name ? name !== 'file-4.md' : '' };
  const input = { last() { return this; }, count: async () => 1, getAttribute: async () => 'multiple', setInputFiles: async () => { now += 25000; } };
  const page = {
    url: () => 'https://chat.deepseek.com/',
    locator: selector => selector === 'input[type="file"]' ? { evaluateAll: async () => false } : selector.startsWith('input[type="file"]') ? input : editor,
    getByRole: () => ({ filter() { return this; }, count: async () => 0 }),
    waitForTimeout: async ms => { now += ms; },
  };
  await assert.rejects(prepare(page), /Preparation timed out/);
  assert.equal(now, 90000);
});

test('attachment preparation requires all files together rather than remembering disappeared cards', async () => {
  let now = 0;
  let round = 0;
  const files = ['one.md', 'two.md'].map(name => ({ name, path: path.resolve(name) }));
  const prepare = new Function('Date', 'return ' + await providerPrepareCode(getProvider('chatgpt'), 'test', files))({ now: () => now });
  const editor = { first() { return this; }, fill: async () => {}, evaluate: async (_, name) => name ? name === (round % 2 ? 'two.md' : 'one.md') : '' };
  const input = { last() { return this; }, count: async () => 1, getAttribute: async () => null, setInputFiles: async () => {} };
  const page = {
    url: () => 'https://chatgpt.com/',
    locator: selector => selector === 'input[type="file"]' ? { evaluateAll: async () => false } : selector.startsWith('input[type="file"]') ? input : editor,
    getByRole: () => ({ filter() { return this; }, count: async () => 0 }),
    waitForTimeout: async ms => { now += ms; round++; },
  };
  await assert.rejects(prepare(page), /Preparation timed out/);
  assert.equal(now, 90000);
});
