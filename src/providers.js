import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanComposerCode } from './composer.js';
import { attachmentMimeType } from './attachments.js';
import { normalizePrompt, confirmSubmission, replyCompletion, generationSelector, currentNoticeTexts } from './browser-state.js';
import { attachmentVisible } from './attachment-visible.js';
import { readyCode as chatgptReady, prepareChatGPT, preflightCode as chatgptPreflight, sendCode as chatgptSend, responseCode as chatgptResponse } from './sites/chatgpt.js';

const editor = 'textarea:visible, [contenteditable="true"][role="textbox"]:visible, [contenteditable="true"]:visible';

const definitions = {
  chatgpt: { id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/', hosts: ['chatgpt.com'] },
  gemini: {
    id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/app', hosts: ['gemini.google.com'],
    editor: '.ql-editor[contenteditable="true"]:visible, rich-textarea [contenteditable="true"]:visible, ' + editor,
    reply: '[data-test-id="model-response-text"], .model-response-text, [data-testid="model-response"]',
    sendSelectors: ['button.send-button:visible', '.send-button-container button:visible', 'button[mattooltip="Send" i]:visible', 'button[data-test-id="send-button"]:visible'],
  },
  deepseek: {
    id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/', hosts: ['chat.deepseek.com'],
    editor: 'textarea[placeholder]:visible, #chat-input:visible, ' + editor,
    reply: '[data-role="assistant"], [data-testid="assistant-message"], .ds-message--assistant',
    enterFallback: true,
  },
  kimi: {
    id: 'kimi', label: 'Kimi', url: 'https://www.kimi.com/', hosts: ['www.kimi.com', 'kimi.com', 'www.kimi.ai', 'kimi.ai'],
    editor: 'textarea[placeholder*="Ask"]:visible, [contenteditable="true"][data-placeholder]:visible, ' + editor,
    reply: '[data-role="assistant"], [data-testid="assistant-message"], .assistant-message',
    enterFallback: true,
  },
  claude: {
    id: 'claude', label: 'Claude', url: 'https://claude.ai/new', hosts: ['claude.ai'],
    editor: '[data-testid="chat-input"] [contenteditable="true"]:visible, .ProseMirror[contenteditable="true"]:visible, ' + editor,
    reply: '[data-testid="assistant-message"], [data-role="assistant"]',
  },
};

export const providers = Object.freeze(definitions);
export const providerIds = Object.keys(definitions);

export function getProvider(id) {
  const provider = Object.hasOwn(definitions, id) ? definitions[id] : undefined;
  if (!provider) throw new Error(`Unknown provider: ${id}. Choose from ${providerIds.join(', ')}.`);
  return provider;
}

function allowedCode(provider) {
  return `if (new URL(page.url()).protocol !== 'https:' || !${JSON.stringify(provider.hosts)}.includes(new URL(page.url()).hostname)) throw new Error('Selected tab is not ${provider.label}. Current URL: ' + page.url());`;
}

export function providerReadyCode(provider) {
  if (provider.id === 'chatgpt') return chatgptReady;
  return `async (page) => {
    ${allowedCode(provider)}
    const composer = page.locator(${JSON.stringify(provider.editor)}).first();
    try { await composer.waitFor({ state: 'visible', timeout: 20000 }); }
    catch { throw new Error('${provider.label} composer was not found. Sign in or check whether its page layout changed.'); }
    return { ready: true, url: page.url() };
  }`;
}

// Use visible page text only. These messages mean a provider cannot accept a
// new prompt now, even when its editor and attachment picker remain available.
export function providerAvailabilityCode(provider) {
  return `async (page) => {
    ${allowedCode(provider)}
    const notices = page.locator('[role="alert"]:visible, [role="status"]:visible, [aria-live]:visible').filter({ hasNot: page.locator('textarea, [contenteditable="true"]') });
    const texts = await notices.evaluateAll(${currentNoticeTexts.toString()});
    const text = texts.join('\\n');
    const patterns = [
      /out of usage credits/i,
      /usage (?:limit|quota) (?:reached|exceeded)/i,
      /(?:daily|message|rate) limit (?:reached|exceeded)/i,
      /too many requests/i,
      /you(?:'ve| have) reached your (?:usage|message|daily|rate) limit/i
    ];
    const match = patterns.map(pattern => text.match(pattern)?.[0]).find(Boolean);
    return { available: !match, reason: match || '', url: page.url() };
  }`;
}

async function filePayload(file) {
  if (!file) return null;
  const name = typeof file === 'string' ? path.basename(file) : file.name;
  const mimeType = attachmentMimeType(name, typeof file === 'string' ? undefined : file.mimeType);
  const buffer = typeof file === 'string' ? await fs.readFile(file) : file.buffer;
  return { name, mimeType, base64: buffer.toString('base64') };
}

export async function providerPrepareCode(provider, prompt, files = []) {
  if (provider.id === 'chatgpt') return prepareChatGPT(prompt, files);
  const attachments = await Promise.all(files.map(filePayload));
  return `async (page) => {
    ${allowedCode(provider)}
    const prepareDeadline = Date.now() + 90000;
    const remaining = (max = 30000) => { const budget = prepareDeadline - Date.now(); if (budget <= 0) throw new Error('Preparation timed out. Nothing was sent. Check and clear the staged draft.'); return Math.min(max, budget); };
    const composer = page.locator(${JSON.stringify(provider.editor)}).first();
    ${cleanComposerCode}
    await composer.fill(${JSON.stringify(prompt)}, { timeout: remaining(15000) });
    const attachments = ${JSON.stringify(attachments)};
    const payloads = attachments.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, buffer: Buffer.from(attachment.base64, 'base64') }));
    const fileInput = () => page.locator('input[type="file"]:not([webkitdirectory]):not([accept^="image/"])').last();
    let input = fileInput();
    if (payloads.length && await input.count() && await input.getAttribute('multiple') !== null) {
      await input.setInputFiles(payloads, { timeout: remaining(30000) });
    } else {
      for (const payload of payloads) {
        input = fileInput();
        if (await input.count()) {
          await input.setInputFiles(payload, { timeout: remaining(20000) });
        } else {
          const attach = page.getByRole('button', { name: /attach|upload|add file|add attachment/i });
          if (await attach.count() !== 1) throw new Error('${provider.label} upload control was not found unambiguously. Nothing was sent.');
          const chooserPromise = page.waitForEvent('filechooser', { timeout: remaining(3000) }).catch(() => null);
          await attach.click();
          const chooser = await chooserPromise;
          if (chooser) await chooser.setFiles(payload, { timeout: remaining(20000) });
          else await fileInput().setInputFiles(payload, { timeout: remaining(20000) });
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
    return { promptPrepared: true, attachmentCount: attachments.length, url: page.url() };
  }`;
}

const sendSelector = 'button[aria-label="send" i]:visible, button[aria-label="send message" i]:visible, button[title="send" i]:visible, button[data-testid="send-button"]:visible';

function sendLocatorCode(provider) {
  return `${provider.sendSelectors ? `let specific;
    for (const selector of ${JSON.stringify(provider.sendSelectors)}) {
      const candidate = scope.locator(selector);
      if (await candidate.count() === 1) { specific = candidate; break; }
    }` : ''}
    const named = scope.getByRole('button', { name: /^(send|send message|send prompt)$/i });
    const generic = scope.locator(${JSON.stringify(sendSelector)} + (await form.count() ? ${JSON.stringify(', button[type="submit"]:visible')} : ''));
    const send = ${provider.sendSelectors ? 'specific ?? ' : ''}(await named.count() === 1 ? named : generic);`;
}

export function providerPreflightCode(provider, prompt) {
  if (provider.id === 'chatgpt') return chatgptPreflight(prompt);
  return `async (page) => {
    ${allowedCode(provider)}
    const composer = page.locator(${JSON.stringify(provider.editor)}).first();
    const text = await composer.evaluate(el => el.value ?? el.innerText ?? '');
    const normalize = ${normalizePrompt.toString()};
    if (normalize(text) !== ${JSON.stringify(normalizePrompt(prompt))}) throw new Error('${provider.label} prompt is missing from the composer. Nothing was sent.');
    const form = composer.locator('xpath=ancestor::form[1]');
    const scope = await form.count() ? form : page;
    ${sendLocatorCode(provider)}
    if (await send.count() !== 1) {
      if (${Boolean(provider.enterFallback)} && await send.count() === 0) return { readyToSend: true, method: 'enter', url: page.url() };
      throw new Error('${provider.label} Send button was not found unambiguously. Nothing was sent.');
    }
    try { await send.click({ trial: true, timeout: 30000 }); }
    catch { throw new Error('${provider.label} Send button did not become ready. Nothing was sent.'); }
    return { readyToSend: true, url: page.url() };
  }`;
}

export function providerSendCode(provider) {
  if (provider.id === 'chatgpt') return chatgptSend;
  return `async (page) => {
    ${allowedCode(provider)}
    const composer = page.locator(${JSON.stringify(provider.editor)}).first();
    const prompt = await composer.evaluate(el => el.value ?? el.innerText ?? '');
    const previousReplies = await page.locator(${JSON.stringify(provider.reply)}).count();
    const previousUsers = await page.locator('[data-role="user"], [data-testid="user-message"]').count();
    const before = { previousReplies, previousUsers, url: page.url() };
    const form = composer.locator('xpath=ancestor::form[1]');
    const scope = await form.count() ? form : page;
    ${sendLocatorCode(provider)}
    if (await send.count() === 1) {
      await send.click({ timeout: 60000 });
    } else if (${Boolean(provider.enterFallback)} && await send.count() === 0) {
      await composer.press('Enter');
    } else {
      throw new Error('${provider.label} Send button disappeared before submission.');
    }
    await (${confirmSubmission.toString()})(page, composer, before, {
      user: '[data-role="user"], [data-testid="user-message"]', reply: ${JSON.stringify(provider.reply)},
      generating: ${JSON.stringify(generationSelector)}, hosts: ${JSON.stringify(provider.hosts)}
    });
    return { submitted: true, prompt, previousReplies, url: page.url() };
  }`;
}

export function providerResponseCode(provider, receipt) {
  if (provider.id === 'chatgpt') return guardCapture(chatgptResponse(receipt.previousReplies), receipt);
  return guardCapture(`async (page) => {
    ${allowedCode(provider)}
    const replies = page.locator(${JSON.stringify(provider.reply)});
    const count = await replies.count();
    let text = count > ${JSON.stringify(receipt.previousReplies)} ? await replies.last().innerText() : '';
    const generating = await page.locator(${JSON.stringify(generationSelector)}).count() > 0
      || await page.getByRole('button', { name: /stop.*(generat|stream|response)|^stop$/i }).count() > 0;
    const signals = text ? await replies.last().evaluate(${replyCompletion.toString()}) : { streaming: false, finished: false };
    return { text, generating: generating || signals.streaming, complete: !generating && !signals.streaming && signals.finished && text.trim().length > 0, finishedControls: signals.finished, url: page.url() };
  }`, receipt);
}

export function providerSubmissionCode(provider, captureId) {
  if (!captureId) throw new Error('Missing submission tab identity.');
  return `async (page) => {
    const receipt = await (${providerSendCode(provider)})(page);
    page.__promptInjectorCaptureId = ${JSON.stringify(captureId)};
    return { ...receipt, captureId: ${JSON.stringify(captureId)} };
  }`;
}

function guardCapture(code, receipt) {
  if (!receipt.captureId) return code;
  return `async (page) => {
    if (page.__promptInjectorCaptureId !== ${JSON.stringify(receipt.captureId)}) throw new Error('Submission tab changed. Capture stopped.');
    return (${code})(page);
  }`;
}
