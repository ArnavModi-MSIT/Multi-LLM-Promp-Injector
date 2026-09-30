import fs from 'node:fs/promises';
import path from 'node:path';
import { readyCode as chatgptReady, prepareChatGPT, preflightCode as chatgptPreflight, sendCode as chatgptSend, responseCode as chatgptResponse } from './sites/chatgpt.js';

const editor = 'textarea:visible, [contenteditable="true"][role="textbox"]:visible, [contenteditable="true"]:visible';

const definitions = {
  chatgpt: { id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/', hosts: ['chatgpt.com'] },
  gemini: {
    id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/app', hosts: ['gemini.google.com'],
    editor: '.ql-editor[contenteditable="true"]:visible, rich-textarea [contenteditable="true"]:visible, ' + editor,
    reply: '[data-test-id="model-response-text"], .model-response-text, [data-testid="model-response"]',
    sendSelector: 'button.send-button:visible, .send-button-container button:visible, button[mattooltip*="Send" i]:visible, button[data-test-id*="send" i]:visible',
  },
  deepseek: {
    id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/', hosts: ['chat.deepseek.com'],
    editor: 'textarea[placeholder]:visible, #chat-input:visible, ' + editor,
    reply: '[data-role="assistant"], [data-testid="assistant-message"], .ds-message--assistant',
    enterFallback: true,
  },
  kimi: {
    id: 'kimi', label: 'Kimi', url: 'https://www.kimi.ai/', hosts: ['www.kimi.ai', 'kimi.ai'],
    editor: 'textarea[placeholder*="Ask"]:visible, [contenteditable="true"][data-placeholder]:visible, ' + editor,
    reply: '[data-role="assistant"], [data-testid="assistant-message"], .assistant-message',
    enterFallback: true,
  },
  claude: {
    id: 'claude', label: 'Claude', url: 'https://claude.ai/new', hosts: ['claude.ai'],
    editor: '[data-testid="chat-input"] [contenteditable="true"]:visible, .ProseMirror[contenteditable="true"]:visible, ' + editor,
    reply: '[data-testid="assistant-message"], [data-is-streaming="false"], [data-role="assistant"]',
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
  return `if (!${JSON.stringify(provider.hosts)}.includes(new URL(page.url()).hostname)) throw new Error('Selected tab is not ${provider.label}. Current URL: ' + page.url());`;
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
    const text = await page.locator('body').innerText();
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
  const mimeType = typeof file === 'string'
    ? ({ '.md': 'text/markdown', '.txt': 'text/plain', '.pdf': 'application/pdf', '.csv': 'text/csv', '.json': 'application/json' })[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
    : file.mimeType;
  const buffer = typeof file === 'string' ? await fs.readFile(file) : file.buffer;
  return { name, mimeType, base64: buffer.toString('base64') };
}

export async function providerPrepareCode(provider, prompt, files = []) {
  if (provider.id === 'chatgpt') return prepareChatGPT(prompt, files);
  const attachments = await Promise.all(files.map(filePayload));
  return `async (page) => {
    ${allowedCode(provider)}
    const composer = page.locator(${JSON.stringify(provider.editor)}).first();
    await composer.fill(${JSON.stringify(prompt)});
    const attachments = ${JSON.stringify(attachments)};
    const payloads = attachments.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, buffer: Buffer.from(attachment.base64, 'base64') }));
    const fileInput = () => page.locator('input[type="file"]:not([webkitdirectory]):not([accept^="image/"])').last();
    let input = fileInput();
    if (payloads.length && await input.count() && await input.getAttribute('multiple') !== null) {
      await input.setInputFiles(payloads, { timeout: 30000 });
    } else {
      for (const payload of payloads) {
        input = fileInput();
        if (await input.count()) {
          await input.setInputFiles(payload, { timeout: 20000 });
        } else {
          const attach = page.getByRole('button', { name: /attach|upload|add file|add attachment/i });
          if (await attach.count() !== 1) throw new Error('${provider.label} upload control was not found unambiguously. Nothing was sent.');
          const chooserPromise = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
          await attach.click();
          const chooser = await chooserPromise;
          if (chooser) await chooser.setFiles(payload, { timeout: 20000 });
          else await fileInput().setInputFiles(payload, { timeout: 20000 });
        }
      }
    }
    for (const attachment of attachments) {
      const stem = attachment.name.includes('.') ? attachment.name.slice(0, attachment.name.lastIndexOf('.')) : attachment.name;
      let confirmed = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const filename = page.getByText(attachment.name, { exact: true }).first();
        const shortName = page.getByText(stem, { exact: true }).first();
        if ((await filename.count() && await filename.isVisible()) || (await shortName.count() && await shortName.isVisible())) { confirmed = true; break; }
        if (attachments.length === 1 && await fileInput().count() && await fileInput().evaluate(el => [...(el.files || [])].some(file => file.name === attachment.name))) { confirmed = true; break; }
        await page.waitForTimeout(500);
      }
      if (!confirmed) throw new Error('${provider.label} did not confirm attachment ' + attachment.name + '. Nothing was sent.');
    }
    return { promptPrepared: true, attachmentCount: attachments.length, url: page.url() };
  }`;
}

const sendSelector = 'button[type="submit"]:visible, button[aria-label*="send" i]:visible, button[title*="send" i]:visible, button[data-testid*="send" i]:visible';

function sendLocatorCode(provider) {
  return `const named = scope.getByRole('button', { name: /^(send|send message|submit|run)$/i });
    ${provider.sendSelector ? `const specific = scope.locator(${JSON.stringify(provider.sendSelector)});` : ''}
    const send = await named.count() === 1 ? named : ${provider.sendSelector ? 'await specific.count() === 1 ? specific :' : ''} scope.locator(${JSON.stringify(sendSelector)});`;
}

export function providerPreflightCode(provider, prompt) {
  if (provider.id === 'chatgpt') return chatgptPreflight(prompt);
  return `async (page) => {
    ${allowedCode(provider)}
    const composer = page.locator(${JSON.stringify(provider.editor)}).first();
    const text = await composer.evaluate(el => el.value ?? el.innerText ?? '');
    if (text.trim() !== ${JSON.stringify(prompt.trim())}) throw new Error('${provider.label} prompt is missing from the composer. Nothing was sent.');
    const form = composer.locator('xpath=ancestor::form[1]');
    const scope = await form.count() ? form : page;
    ${sendLocatorCode(provider)}
    if (await send.count() !== 1) {
      if (${Boolean(provider.enterFallback)}) return { readyToSend: true, method: 'enter', url: page.url() };
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
    const previousCopyButtons = await page.getByRole('button', { name: /^copy$/i }).count();
    const form = composer.locator('xpath=ancestor::form[1]');
    const scope = await form.count() ? form : page;
    ${sendLocatorCode(provider)}
    if (await send.count() === 1) {
      await send.click({ timeout: 60000 });
    } else if (${Boolean(provider.enterFallback)}) {
      await composer.press('Enter');
      let cleared = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const current = await composer.evaluate(el => el.value ?? el.innerText ?? '').catch(() => '');
        if (!current.trim()) { cleared = true; break; }
        await page.waitForTimeout(250);
      }
      if (!cleared) throw new Error('${provider.label} did not confirm submission after Enter. Check this tab before retrying.');
    } else {
      throw new Error('${provider.label} Send button disappeared before submission.');
    }
    return { submitted: true, prompt, previousReplies, previousCopyButtons, url: page.url() };
  }`;
}

export function providerResponseCode(provider, receipt) {
  if (provider.id === 'chatgpt') return chatgptResponse(receipt.previousReplies, receipt.prompt, receipt.previousCopyButtons);
  return `async (page) => {
    ${allowedCode(provider)}
    const replies = page.locator(${JSON.stringify(provider.reply)});
    const count = await replies.count();
    let text = count > ${JSON.stringify(receipt.previousReplies)} ? await replies.last().innerText() : '';
    const generating = await page.getByRole('button', { name: /stop.*(generat|stream|response)|^stop$/i }).count() > 0;
    const copyCount = await page.getByRole('button', { name: /^copy$/i }).count();
    return { text, generating, complete: !generating && text.trim().length > 0, finishedControls: copyCount > ${JSON.stringify(receipt.previousCopyButtons)}, url: page.url() };
  }`;
}
