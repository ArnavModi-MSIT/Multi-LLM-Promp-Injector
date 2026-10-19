import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from './fixture-browser.mjs';
import { stageAttachmentPaths } from '../src/attachment-paths.js';
import { createAttachmentTransfer } from '../src/attachment-transfer.js';
import { providers, providerReadyCode, providerPrepareCode, providerPreflightCode, providerSubmissionCode } from '../src/providers.js';

let browser;
try { browser = await chromium.launch({ headless: true }); }
catch (error) {
  if (process.platform !== 'win32') throw error;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
}
const staged = await stageAttachmentPaths(Array.from({ length: 5 }, (_, i) => ({ name: `fixture-notes-${i}.md`, buffer: Buffer.from('Synthetic local test file.') })));
const transfer = await createAttachmentTransfer(staged.files);
const run = (code, page) => new Function('return ' + code)()(page);
try {
  for (const provider of Object.values(providers)) {
    const context = await browser.newContext();
    try {
      const html = await fs.readFile(new URL(`../test/fixtures/${provider.id}.html`, import.meta.url), 'utf8');
      // Every URL is fulfilled locally. No provider requests, accounts, or cookies.
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
      const page = await context.newPage();
      await page.goto(provider.url);
      // Reading assistant text is forbidden: submission only needs DOM counts.
      await page.locator(provider.reply).evaluateAll(nodes => nodes.forEach(node => Object.defineProperty(node, 'innerText', { configurable: true, get() { throw new Error('Assistant text must not be extracted'); } })));
      await run(providerReadyCode(provider), page);
      // Trial clicks must reject a disabled Send control without submitting.
      await page.locator(provider.editor).first().fill('blocked prompt');
      await page.getByRole('button', { name: 'Send', exact: true }).evaluateAll(nodes => nodes.forEach(node => { node.disabled = true; }));
      await assert.rejects(run(providerPreflightCode(provider, 'blocked prompt').replace('trial: true, timeout: 0', 'trial: true, timeout: 100'), page), /Send button did not become ready/);
      assert.equal(await page.locator(provider.editor).first().inputValue().catch(() => page.locator(provider.editor).first().innerText()), 'blocked prompt');
      // A missing editor must report layout/sign-in trouble, not success.
      await page.locator(provider.editor).first().evaluate(node => node.remove());
      await assert.rejects(run(providerReadyCode(provider).replaceAll('timeout: 0', 'timeout: 100'), page), /composer was not found/);
      await page.goto(provider.url);
      await page.locator(provider.editor).first().fill('Restored draft from the provider');
      page.__promptInjectorFreshTab = true;
      let existingTab;
      if (provider.id === 'chatgpt') {
        existingTab = await context.newPage();
        await existingTab.goto(provider.url);
        await existingTab.locator(provider.editor).first().fill('Existing user draft must stay intact');
        await existingTab.bringToFront();
      }
      if (provider.id === 'gemini') {
        // Reproduce the two-step upload UI and a dynamically created multi-file
        // input. The old implementation stopped at the open menu in screenshots.
        await page.evaluate(() => {
          const input = document.querySelector('input[type="file"]'); input.remove();
          const form = document.querySelector('form');
          const attach = document.createElement('button'); attach.type = 'button'; attach.textContent = 'Attach';
          const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); menu.hidden = true;
          const upload = document.createElement('button'); upload.type = 'button'; upload.setAttribute('role', 'menuitem'); upload.textContent = 'Upload files';
          menu.append(upload); form.append(attach, menu);
          attach.onclick = () => { menu.hidden = false; };
          upload.onclick = () => { form.append(input); menu.hidden = true; input.click(); };
        });
      }
      await page.locator(provider.reply).evaluateAll(nodes => nodes.forEach(node => Object.defineProperty(node, 'innerText', { configurable: true, get() { throw new Error('Assistant text must not be extracted'); } })));
      const prompt = 'def f():\n    return 1\n\nprint(f())';
      await run(await providerPrepareCode(provider, prompt, transfer.files), page);
      if (existingTab) assert.equal(await existingTab.locator(provider.editor).first().innerText(), 'Existing user draft must stay intact');
      try { await run(providerPreflightCode(provider, prompt, staged.files), page); }
      catch (error) {
        console.error('Synthetic fixture editor:', await page.locator(provider.editor).first().evaluate(el => ({ text: el.innerText, html: el.innerHTML, value: el.value })));
        throw error;
      }
      await page.evaluate(() => { window.virtualizeHistory = true; });
      const receipt = await run(providerSubmissionCode(provider, prompt, staged.files), page);
      assert.equal(receipt.submitted, true);
      assert.deepEqual(Object.keys(receipt).sort(), ['submitted', 'url']);
      // Indentation corruption must fail the prompt integrity check.
      await page.locator(provider.editor).first().fill('def f():\nreturn 1\n\nprint(f())');
      await assert.rejects(run(providerPreflightCode(provider, prompt, staged.files), page), /prompt is missing/);
      console.log(provider.label + ': real-DOM disabled Send, missing editor, prepare, attachment, confirmed send, and prompt integrity passed.');
    } finally { await context.close(); }
  }
  const child = spawn(process.execPath, ['src/local-server.js'], {
    env: { ...process.env, PROMPT_INJECTOR_PORT: '4190', PROMPT_INJECTOR_OPEN_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const closed = once(child, 'exit');
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const context = await browser.newContext();
  try {
    await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error(diagnostics); })]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4190/');
    await page.waitForFunction(() => document.querySelectorAll('#providers input').length === 6);
    assert.equal(await page.locator('#providers input:checked').count(), 6);
    assert.match(await page.locator('#provider-limits').innerText(), /Qwen[\s\S]*Free tier: up to 5[\s\S]*ZIP blocked/);
    assert.match(await page.locator('#provider-limits').innerText(), /DeepSeek[\s\S]*ZIP blocked/);
    for (const [name, quota] of [['ChatGPT', '3 file uploads / day'], ['Gemini', '10 files / prompt'], ['Kimi', '50 files / upload'], ['Claude', '20 files / chat']]) {
      const row = page.locator('#provider-limits tr').filter({ hasText: name });
      assert.ok((await row.innerText()).includes(quota));
      assert.equal(await row.locator('a[href^="https://"]').count(), 1);
    }
    assert.doesNotMatch(await page.locator('#provider-limits').innerText(), /Check provider restrictions|App limit: 5/);
    await fs.mkdir('artifacts', { recursive: true });
    await page.locator('.limits').screenshot({ path: 'artifacts/provider-limits.png' });
    let submissions = 0;
    await page.route('**/api/submit', route => { submissions++; return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture stopped before browser connection.' }) }); });
    await page.locator('#prompt').fill('Local validation fixture');
    for (const id of ['qwen', 'deepseek']) {
      for (const checkbox of await page.locator('#providers input').all()) await checkbox.uncheck();
      await page.locator(`#providers input[value="${id}"]`).check();
      await page.locator('#file').setInputFiles({ name: 'review.ZIP', mimeType: 'application/zip', buffer: Buffer.from('Synthetic archive placeholder') });
      await page.locator('#submit').click();
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('does not accept ZIP'));
      assert.equal(submissions, 0);
    }
    await page.locator('#providers input[value="deepseek"]').uncheck();
    await page.locator('#providers input[value="qwen"]').check();
    const textFiles = Array.from({ length: 6 }, (_, i) => ({ name: `note-${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Synthetic notes') }));
    await page.locator('#file').setInputFiles(textFiles);
    await page.locator('#submit').click();
    await page.waitForFunction(() => document.getElementById('error').textContent.includes('at most 5'));
    assert.equal(submissions, 0);
    await page.locator('#file').setInputFiles(textFiles.slice(0, 5));
    await page.locator('#submit').click();
    await page.waitForFunction(() => document.getElementById('error').textContent.includes('Fixture stopped'));
    assert.equal(submissions, 1);

    // CSP must allow the shipped UI while blocking unapproved inline scripts.
    await page.addScriptTag({ content: 'window.unapprovedScript = true;' }).catch(() => {});
    assert.equal(await page.evaluate(() => window.unapprovedScript), undefined);
    await page.evaluate(() => render({ results: [{ id: 'chatgpt', label: 'ChatGPT', status: 'submitted', submission: 'sent', url: 'https://chatgpt.com/c/test' }] }));
    assert.equal(await page.locator('.provider-result pre').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Download text' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Open conversation' }).count(), 1);
    assert.match(await page.locator('#results').innerText(), /submitted/);
    assert.doesNotMatch(await page.locator('#results').innerText(), /Capture|undefined/);
    await page.locator('#result').screenshot({ path: 'artifacts/submission-status.png' });
    assert.deepEqual(errors, []);
    console.log('Local UI: CSP, provider metadata, six default selections, and submission-only status passed.');
  } finally { await context.close(); child.kill(); await closed; }
} finally { try { await transfer.close(); } finally { await staged.cleanup(); await browser.close(); } }
