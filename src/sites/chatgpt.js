import fs from 'node:fs/promises';
import path from 'node:path';
import { attachmentMimeType } from '../attachments.js';
import { attachmentVisible } from '../attachment-visible.js';
import { normalizePrompt, confirmSubmission, replyCompletion, generationSelector } from '../browser-state.js';
import { cleanComposerCode } from '../composer.js';

export const readyCode = `async (page) => {
  if (new URL(page.url()).origin !== 'https://chatgpt.com') throw new Error('Selected tab is not ChatGPT. Nothing was prepared.');
  const editor = page.locator('#prompt-textarea:visible, [contenteditable="true"]:visible, textarea:visible').first();
  try {
    await editor.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    throw new Error('ChatGPT composer unavailable. Check that ChatGPT finished loading in Chrome. Current URL: ' + page.url());
  }
  return { ready: true, url: page.url(), editor: await editor.evaluate(el => ({ tag: el.tagName, contentEditable: el.getAttribute('contenteditable') })) };
}`;

export const existingConversationCode = `async (page) => {
  const url = new URL(page.url());
  if (url.hostname !== 'chatgpt.com' || !url.pathname.startsWith('/c/')) {
    throw new Error('Select the existing ChatGPT conversation tab in the Playwright Extension dialog. Current tab: ' + page.url());
  }
  return { url: page.url() };
}`;

export async function prepareChatGPT(prompt, files = []) {
  const attachments = await Promise.all(files.map(async file => ({
    name: typeof file === 'string' ? path.basename(file) : file.name,
    mimeType: attachmentMimeType(typeof file === 'string' ? path.basename(file) : file.name, typeof file === 'string' ? undefined : file.mimeType),
    base64: typeof file === 'string'
      ? (await fs.readFile(file)).toString('base64')
      : file.buffer.toString('base64'),
  })));
  return `async (page) => {
    if (new URL(page.url()).origin !== 'https://chatgpt.com') throw new Error('Selected tab is no longer ChatGPT. Nothing was prepared.');
    const prepareDeadline = Date.now() + 90000;
    const remaining = (max = 30000) => { const budget = prepareDeadline - Date.now(); if (budget <= 0) throw new Error('Preparation timed out. Nothing was sent. Check and clear the staged draft.'); return Math.min(max, budget); };
    const composer = page.locator('#prompt-textarea:visible, [contenteditable="true"]:visible, textarea:visible').first();
    ${cleanComposerCode}
    await composer.fill(${JSON.stringify(prompt)}, { timeout: remaining(15000) });
    const attachments = ${JSON.stringify(attachments)};
    const payloads = attachments.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, buffer: Buffer.from(attachment.base64, 'base64') }));
    const fileInput = () => page.locator('input[type="file"]:not([webkitdirectory]):not([accept^="image/"])').last();
    if (payloads.length && await fileInput().count() && await fileInput().getAttribute('multiple') !== null) {
      await fileInput().setInputFiles(payloads, { timeout: remaining(30000) });
    } else {
      for (const payload of payloads) {
        if (await fileInput().count()) {
          await fileInput().setInputFiles(payload, { timeout: remaining(15000) });
        } else {
          const attach = page.getByRole('button', { name: /attach|add files|upload|add photos|open.*menu/i }).first();
          if (!(await attach.count())) throw new Error('ChatGPT attachment button was not found.');
          const chooserPromise = page.waitForEvent('filechooser', { timeout: remaining(3000) }).catch(() => null);
          await attach.click();
          let chooser = await chooserPromise;
          if (!chooser) {
            const upload = page.getByRole('menuitem', { name: /upload from computer|upload file|upload/i }).first();
            if (await upload.count()) {
              const nextChooser = page.waitForEvent('filechooser', { timeout: remaining(10000) });
              await upload.click();
              chooser = await nextChooser;
            } else {
              await fileInput().setInputFiles(payload, { timeout: remaining(10000) });
            }
          }
          if (chooser) await chooser.setFiles(payload, { timeout: remaining(15000) });
        }
      }
    }
    const pending = new Set(attachments.map(attachment => attachment.name));
    while (pending.size) {
      remaining();
      for (const name of [...pending]) {
        if (await composer.evaluate(${attachmentVisible.toString()}, name)) pending.delete(name);
      }
      if (pending.size) await page.waitForTimeout(remaining(500));
    }
    return { promptPrepared: true, attachmentCount: attachments.length };
  }`;
}

export const sendCode = `async (page) => {
  if (new URL(page.url()).origin !== 'https://chatgpt.com') throw new Error('Selected tab is no longer ChatGPT. Nothing was sent.');
  const previousReplies = await page.locator('[data-message-author-role="assistant"]').count();
  const previousUsers = await page.locator('[data-message-author-role="user"]').count();
  const before = { previousReplies, previousUsers, url: page.url() };
  const composer = page.locator('#prompt-textarea:visible, [contenteditable="true"]:visible, textarea:visible').first();
  const prompt = await composer.evaluate(el => el.value ?? el.innerText ?? '');
  const specific = page.locator('#composer-submit-button:visible:not([data-testid="stop-button"]):not([aria-label*="stop" i]), [data-testid="send-button"]:visible');
  const named = page.getByRole('button', { name: /^(send|send prompt|send message)$/i });
  const send = await specific.count() === 1 ? specific : named;
  if (await send.count() !== 1) throw new Error('ChatGPT Send button was not found unambiguously. Check this tab before retrying.');
  await send.click({ timeout: 60000 });
  await (${confirmSubmission.toString()})(page, composer, before, {
    user: '[data-message-author-role="user"]', reply: '[data-message-author-role="assistant"]',
    generating: ${JSON.stringify(generationSelector)}, hosts: ['chatgpt.com']
  });
  return { submitted: true, previousReplies, prompt, url: page.url() };
}`;

export function preflightCode(prompt) {
  return `async (page) => {
    if (new URL(page.url()).origin !== 'https://chatgpt.com') throw new Error('Selected tab is no longer ChatGPT. Nothing was sent.');
    const editor = page.locator('#prompt-textarea:visible, [contenteditable="true"]:visible, textarea:visible').first();
    const text = await editor.evaluate(el => el.value ?? el.innerText ?? '');
    const normalize = ${normalizePrompt.toString()};
    if (normalize(text) !== ${JSON.stringify(normalizePrompt(prompt))}) throw new Error('ChatGPT prompt is missing from the composer. Nothing was sent.');
    const specific = page.locator('#composer-submit-button:visible:not([data-testid="stop-button"]):not([aria-label*="stop" i]), [data-testid="send-button"]:visible');
    const named = page.getByRole('button', { name: /^(send|send prompt|send message)$/i });
    const send = await specific.count() === 1 ? specific : named;
    if (await send.count() !== 1) throw new Error('ChatGPT Send button was not found unambiguously. Nothing was sent.');
    try { await send.click({ trial: true, timeout: 60000 }); }
    catch (error) {
      const stop = page.locator('[data-testid="stop-button"]:visible').count();
      if (await stop) throw new Error('ChatGPT is still generating a previous reply. Wait for it to finish before sending. Nothing was sent.');
      throw new Error('ChatGPT Send button did not become ready after 60 seconds. Upload processing, a disabled control, or an overlay may be blocking it. Nothing was sent. Details: ' + error.message);
    }
    return { readyToSend: true, url: page.url() };
  }`;
}

export function responseCode(previousReplies) {
  return `async (page) => {
    if (new URL(page.url()).origin !== 'https://chatgpt.com') throw new Error('Selected tab is no longer ChatGPT. Capture stopped.');
    const replies = page.locator('[data-message-author-role="assistant"]');
    const count = await replies.count();
    const generating = await page.locator(${JSON.stringify(generationSelector)}).count() > 0
      || await page.getByRole('button', { name: /stop.*(generat|stream|response)|^stop$/i }).count() > 0;
    const text = count > ${JSON.stringify(previousReplies)} ? await replies.last().innerText() : '';
    const signals = text ? await replies.last().evaluate(${replyCompletion.toString()}) : { streaming: false, finished: false };
    return { text, generating: generating || signals.streaming, complete: !generating && !signals.streaming && signals.finished && text.trim().length > 0, finishedControls: signals.finished, url: page.url() };
  }`;
}
