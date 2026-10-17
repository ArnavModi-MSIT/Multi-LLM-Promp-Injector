import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from './fixture-browser.mjs';
import { stageAttachmentPaths } from '../src/attachment-paths.js';
import { providers, providerReadyCode, providerPrepareCode, providerPreflightCode, providerSubmissionCode, providerResponseCode } from '../src/providers.js';

let browser;
try { browser = await chromium.launch({ headless: true }); }
catch (error) {
  if (process.platform !== 'win32') throw error;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
}
const staged = await stageAttachmentPaths(Array.from({ length: 5 }, (_, i) => ({ name: `fixture-notes-${i}.md`, buffer: Buffer.from('Synthetic local test file.') })));
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
      await run(providerReadyCode(provider), page);
      // Trial clicks must reject a disabled Send control without submitting.
      await page.locator(provider.editor).first().fill('blocked prompt');
      await page.getByRole('button', { name: 'Send', exact: true }).evaluateAll(nodes => nodes.forEach(node => { node.disabled = true; }));
      await assert.rejects(run(providerPreflightCode({ ...provider, sendTimeout: 100 }, 'blocked prompt'), page), /Send button did not become ready/);
      assert.equal(await page.locator(provider.editor).first().inputValue().catch(() => page.locator(provider.editor).first().innerText()), 'blocked prompt');
      // A missing editor must report layout/sign-in trouble, not success.
      await page.locator(provider.editor).first().evaluate(node => node.remove());
      await assert.rejects(run(providerReadyCode(provider).replace('timeout: 20000', 'timeout: 100'), page), /composer was not found/);
      await page.goto(provider.url);
      const prompt = 'def f():\n    return 1\n\nprint(f())';
      await run(await providerPrepareCode(provider, prompt, staged.files), page);
      try { await run(providerPreflightCode(provider, prompt, staged.files), page); }
      catch (error) {
        console.error('Synthetic fixture editor:', await page.locator(provider.editor).first().evaluate(el => ({ text: el.innerText, html: el.innerHTML, value: el.value })));
        throw error;
      }
      await page.evaluate(() => { window.virtualizeHistory = true; });
      const receipt = await run(providerSubmissionCode(provider, 'fixture-' + provider.id, prompt, staged.files), page);
      assert.equal(receipt.submitted, true);
      const response = await run(providerResponseCode(provider, receipt), page);
      assert.match(response.text, /Fixture reply 1/);
      assert.equal(response.complete, true);
      assert.ok(response.diagnostics.turnMatches <= receipt.previousReplies);
      assert.equal(response.diagnostics.newTurns, 1);
      if (provider.id === 'gemini') assert.ok(response.diagnostics.rawMatches > response.diagnostics.turnMatches);
      // Indentation corruption must fail the prompt integrity check.
      await page.locator(provider.editor).first().fill('def f():\nreturn 1\n\nprint(f())');
      await assert.rejects(run(providerPreflightCode(provider, prompt, staged.files), page), /prompt is missing/);
      console.log(provider.label + ': real-DOM disabled Send, missing editor, prepare, attachment, send, virtualized reply, completion, and prompt integrity passed.');
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
    assert.equal(await page.locator('#providers input:checked').inputValue(), 'chatgpt');
    assert.match(await page.locator('#provider-limits').innerText(), /Qwen[\s\S]*Free tier: up to 5[\s\S]*ZIP not supported/);
    assert.match(await page.locator('#provider-limits').innerText(), /DeepSeek[\s\S]*ZIP not supported/);
    await fs.mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/provider-limits.png', fullPage: true });
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
    await page.evaluate(() => {
      const item = { id: 'chatgpt', label: 'ChatGPT', status: 'completed', submission: 'sent', capture: 'complete', response: 'line\n'.repeat(400) };
      render({ results: [item] });
      window.originalReplyNode = document.querySelector('.provider-result pre');
      window.originalReplyNode.scrollTop = 100;
      render({ results: [item] });
    });
    assert.equal(await page.evaluate(() => document.querySelector('.provider-result pre') === window.originalReplyNode), true);
    assert.equal(await page.locator('.provider-result pre').evaluate(node => node.scrollTop), 100);
    assert.deepEqual(errors, []);
    console.log('Local UI: CSP, provider metadata, unchanged reply nodes, and scroll preservation passed.');
  } finally { await context.close(); child.kill(); await closed; }
} finally { await staged.cleanup(); await browser.close(); }
