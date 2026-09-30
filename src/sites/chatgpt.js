import fs from 'node:fs/promises';
import path from 'node:path';

export const readyCode = `async (page) => {
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
    mimeType: typeof file === 'string'
      ? (({ '.md': 'text/markdown', '.txt': 'text/plain', '.pdf': 'application/pdf' })[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
      : file.mimeType,
    base64: typeof file === 'string'
      ? (await fs.readFile(file)).toString('base64')
      : file.buffer.toString('base64'),
  })));
  return `async (page) => {
    if (new URL(page.url()).hostname !== 'chatgpt.com') throw new Error('Selected tab is no longer ChatGPT. Nothing was prepared.');
    await page.locator('#prompt-textarea:visible, [contenteditable="true"]:visible, textarea:visible').first().fill(${JSON.stringify(prompt)});
    const attachments = ${JSON.stringify(attachments)};
    const payloads = attachments.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, buffer: Buffer.from(attachment.base64, 'base64') }));
    const fileInput = () => page.locator('input[type="file"]:not([webkitdirectory]):not([accept^="image/"])').last();
    if (payloads.length && await fileInput().count() && await fileInput().getAttribute('multiple') !== null) {
      await fileInput().setInputFiles(payloads, { timeout: 30000 });
    } else {
      for (const payload of payloads) {
        if (await fileInput().count()) {
          await fileInput().setInputFiles(payload, { timeout: 15000 });
        } else {
          const attach = page.getByRole('button', { name: /attach|add files|upload|add photos|open.*menu/i }).first();
          if (!(await attach.count())) throw new Error('ChatGPT attachment button was not found.');
          const chooserPromise = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
          await attach.click();
          let chooser = await chooserPromise;
          if (!chooser) {
            const upload = page.getByRole('menuitem', { name: /upload from computer|upload file|upload/i }).first();
            if (await upload.count()) {
              const nextChooser = page.waitForEvent('filechooser', { timeout: 10000 });
              await upload.click();
              chooser = await nextChooser;
            } else {
              await fileInput().setInputFiles(payload, { timeout: 10000 });
            }
          }
          if (chooser) await chooser.setFiles(payload, { timeout: 15000 });
        }
      }
    }
    for (const attachment of attachments) {
      try {
        await page.getByText(attachment.name, { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
      } catch {
        throw new Error('Upload was attempted but no attachment chip appeared for ' + attachment.name + '. Nothing was sent.');
      }
    }
    return { promptPrepared: true, attachmentCount: attachments.length };
  }`;
}

export const sendCode = `async (page) => {
  if (new URL(page.url()).hostname !== 'chatgpt.com') throw new Error('Selected tab is no longer ChatGPT. Nothing was sent.');
  const previousReplies = await page.locator('[data-message-author-role="assistant"]').count();
  const previousCopyButtons = await page.getByRole('button', { name: /^copy$/i }).count();
  const prompt = await page.locator('#prompt-textarea:visible, [contenteditable="true"]:visible, textarea:visible').first().innerText();
  const named = page.getByRole('button', { name: /^(send|send prompt|send message)$/i });
  const send = await named.count() ? named.last() : page.locator('[data-testid="send-button"], #composer-submit-button').last();
  await send.click({ timeout: 60000 });
  return { submitted: true, previousReplies, previousCopyButtons, prompt, url: page.url() };
}`;

export function preflightCode(prompt) {
  return `async (page) => {
    if (new URL(page.url()).hostname !== 'chatgpt.com') throw new Error('Selected tab is no longer ChatGPT. Nothing was sent.');
    const editor = page.locator('#prompt-textarea:visible, [contenteditable="true"]:visible, textarea:visible').first();
    const text = await editor.evaluate(el => el.value ?? el.innerText ?? '');
    if (text.trim() !== ${JSON.stringify(prompt.trim())}) throw new Error('ChatGPT prompt is missing from the composer. Nothing was sent.');
    const named = page.getByRole('button', { name: /^(send|send prompt|send message)$/i });
    const send = await named.count() ? named.last() : page.locator('[data-testid="send-button"], #composer-submit-button').last();
    if (!(await send.count())) throw new Error('ChatGPT Send button was not found. Nothing was sent.');
    try { await send.click({ trial: true, timeout: 30000 }); }
    catch { throw new Error('ChatGPT Send button did not become ready. Nothing was sent.'); }
    return { readyToSend: true, url: page.url() };
  }`;
}

export function responseCode(previousReplies, prompt = '', previousCopyButtons = 0) {
  return `async (page) => {
    const replies = page.locator('[data-message-author-role="assistant"]');
    const count = await replies.count();
    const generating = await page.getByRole('button', { name: /stop.*(generat|stream|response)|^stop$/i }).count() > 0;
    const copyCount = await page.getByRole('button', { name: /^copy$/i }).count();
    let text = count > ${JSON.stringify(previousReplies)} ? await replies.last().innerText() : '';
    const finishedControls = copyCount > ${JSON.stringify(previousCopyButtons)};
    return { text, generating, complete: !generating && text.trim().length > 0, finishedControls, url: page.url() };
  }`;
}
