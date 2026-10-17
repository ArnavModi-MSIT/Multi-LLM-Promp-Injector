import path from 'node:path';
import { cleanComposerCode } from './composer.js';
import { normalizePrompt, confirmSubmission, replyCompletion, generationSelector, currentNoticeTexts, replySnapshot, readComposerText } from './browser-state.js';
import { attachmentVisible } from './attachment-visible.js';

const editor = 'textarea:visible, [contenteditable="true"][role="textbox"]:visible, [contenteditable="true"]:visible';
const noZip = { rejectedExtensions: ['.zip'], rejectedMimeTypes: ['application/zip', 'application/x-zip-compressed', 'multipart/x-zip'] };

const definitions = {
  chatgpt: {
    id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/', hosts: ['chatgpt.com'],
    editor: '#prompt-textarea:visible, [contenteditable="true"]:visible, textarea:visible',
    reply: '[data-message-author-role="assistant"]', user: '[data-message-author-role="user"]',
    sendSelectors: ['#composer-submit-button:visible:not([data-testid="stop-button"]):not([aria-label*="stop" i])', '[data-testid="send-button"]:visible'],
    sendTimeout: 60000, uploadMenu: true,
    fileLimits: {
      quotaText: 'Free: 3 file uploads / day',
      sizeText: '512 MB documents; about 50 MB spreadsheets; 20 MB images',
      typesText: 'Documents, spreadsheets, presentations and images. Audio uploads require a paid plan.',
      note: 'Daily allowance can be lower at peak times; previous uploads count.',
      sources: [{ label: 'OpenAI Help', url: 'https://help.openai.com/en/articles/8555545-uploading-files-and-audio-to-chatgpt' }],
    },
  },
  gemini: {
    id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/app', hosts: ['gemini.google.com'],
    editor: '.ql-editor[contenteditable="true"]:visible, rich-textarea [contenteditable="true"]:visible, ' + editor,
    reply: '[data-test-id="model-response-text"], .model-response-text, [data-testid="model-response"]',
    sendSelectors: ['button.send-button:visible', '.send-button-container button:visible', 'button[mattooltip="Send" i]:visible', 'button[data-test-id="send-button"]:visible'],
    fileLimits: {
      quotaText: 'Up to 10 files / prompt',
      sizeText: '100 MB most files; 2 GB per video',
      typesText: 'Most file types. ZIP: up to 10 files, 100 MB; no audio/video inside.',
      note: 'Subject to availability. Free audio: 10 minutes total; video: 5 minutes total. Rolling usage limits also apply.',
      sources: [{ label: 'Google Help', url: 'https://support.google.com/gemini/answer/14903178?hl=en' }],
    },
  },
  deepseek: {
    id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/', hosts: ['chat.deepseek.com'],
    editor: 'textarea[placeholder]:visible, #chat-input:visible, ' + editor,
    reply: '[data-role="assistant"], [data-testid="assistant-message"], .ds-message--assistant',
    enterFallback: true,
    fileLimits: {
      ...noZip,
      quotaText: 'Reported: 50 files / prompt',
      sizeText: 'Reported: 100 MB / file',
      typesText: 'PDF, DOCX, TXT and images; ZIP blocked for this account.',
      note: 'Historical UI report (March 2025), not confirmed as a current official free-tier cap. Public chat requires sign-in.',
      sources: [{ label: '2025 university guide', url: 'https://sea.nau.edu.cn/_upload/article/files/9f/48/0664056241d39174c060c10d3ec7/84a746e6-c8d1-4869-bd9e-246aa117040f.pdf#page=16' }],
    },
  },
  kimi: {
    id: 'kimi', label: 'Kimi', url: 'https://www.kimi.com/', hosts: ['www.kimi.com', 'kimi.com', 'www.kimi.ai', 'kimi.ai'],
    editor: 'textarea[placeholder*="Ask"]:visible, [contenteditable="true"][data-placeholder]:visible, ' + editor,
    reply: '[data-role="assistant"], [data-testid="assistant-message"], .assistant-message',
    enterFallback: true,
    fileLimits: {
      quotaText: 'Up to 50 files / upload',
      sizeText: '100 MB / file',
      typesText: 'PDF, Word, Excel, PPT, images, TXT and videos.',
      note: 'Published general upload limits; model and membership usage allowances also apply.',
      sources: [{ label: 'Kimi Help', url: 'https://www.kimi.com/en/help/new-user-guide/overview' }],
    },
  },
  claude: {
    id: 'claude', label: 'Claude', url: 'https://claude.ai/new', hosts: ['claude.ai'],
    editor: '[data-testid="chat-input"] [contenteditable="true"]:visible, .ProseMirror[contenteditable="true"]:visible, ' + editor,
    reply: '[data-testid="assistant-message"], [data-role="assistant"]',
    fileLimits: {
      quotaText: 'Up to 20 files / chat',
      sizeText: '500 MB / file for chat uploads',
      typesText: 'PDF, DOCX, CSV, TXT, HTML, ODT, RTF, EPUB, JSON and images. XLSX requires code execution.',
      note: 'Chat-upload limits, not project or code-execution workflow limits. Free usage/context limits still apply.',
      sources: [{ label: 'Claude Help', url: 'https://support.claude.com/en/articles/8241126-upload-files-to-claude' }],
    },
  },
  qwen: {
    id: 'qwen', label: 'Qwen', url: 'https://chat.qwen.ai/', hosts: ['chat.qwen.ai'],
    // Composer and Send attributes inspected on the public page. Reply selectors
    // remain experimental until a signed-in submission/capture is verified.
    editor: 'textarea.message-input-textarea:visible, textarea[placeholder="How can I help you today?"]:visible',
    reply: '[data-role="assistant"], [data-message-author-role="assistant"], .qwen-chat-message-assistant, .chat-message-assistant',
    user: '[data-role="user"], [data-message-author-role="user"], .qwen-chat-message-user, .chat-message-user',
    sendSelectors: ['button[aria-label="Send"]:visible'],
    fileLimits: {
      maxFiles: 5, plan: 'Free tier', ...noZip,
      quotaText: 'Free tier: up to 5 / prompt (your account)',
      sizeText: '20 MB text files in the 2025 announcement',
      typesText: 'Documents and images; ZIP blocked for this account.',
      note: 'Count/ZIP rule comes from your account report. Size is historical official guidance; a current free-tier size cap was not found.',
      sources: [{ label: 'Qwen announcement (2025)', url: 'https://www.linkedin.com/posts/qwen_introducing-the-enhanced-qwen-chat-we-activity-7305263420348514305-vVZ8' }],
    },
  },
};

export const providers = Object.freeze(definitions);
export const providerIds = Object.keys(definitions);

export function getProvider(id) {
  const provider = Object.hasOwn(definitions, id) ? definitions[id] : undefined;
  if (!provider) throw new Error(`Unknown provider: ${id}. Choose from ${providerIds.join(', ')}.`);
  return provider;
}

export function validateProviderFiles(provider, files) {
  const limits = provider.fileLimits;
  if (limits?.maxFiles != null && files.length > limits.maxFiles) {
    throw new Error(`${provider.label} ${limits.plan?.toLowerCase() ?? ''} accepts at most ${limits.maxFiles} files.`);
  }
  for (const file of files) {
    const name = typeof file === 'string' ? path.basename(file) : file.name;
    const mime = typeof file.mimeType === 'string' ? file.mimeType.split(';')[0].trim().toLowerCase() : '';
    if (limits?.rejectedExtensions?.includes(path.extname(name).toLowerCase()) || limits?.rejectedMimeTypes?.includes(mime)) {
      throw new Error(`${provider.label} does not accept ZIP files: ${name}. Remove the archive or deselect ${provider.label}. Nothing was sent.`);
    }
  }
}

function allowedCode(provider) {
  return `if (new URL(page.url()).protocol !== 'https:' || new URL(page.url()).port || !${JSON.stringify(provider.hosts)}.includes(new URL(page.url()).hostname)) throw new Error('Selected tab is not ${provider.label}. Current URL: ' + page.url());`;
}

export function providerReadyCode(provider) {
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

export async function providerPrepareCode(provider, prompt, files = []) {
  validateProviderFiles(provider, files);
  const attachments = files.map(file => {
    const filename = typeof file === 'string' ? file : file.path;
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('Attachments must be staged as absolute local file paths.');
    return { name: typeof file === 'string' ? path.basename(file) : file.name, path: filename };
  });
  return `async (page) => {
    ${allowedCode(provider)}
    const prepareDeadline = Date.now() + 90000;
    const remaining = (max = 30000) => { const budget = prepareDeadline - Date.now(); if (budget <= 0) throw new Error('Preparation timed out. Nothing was sent. Check and clear the staged draft.'); return Math.min(max, budget); };
    const composer = page.locator(${JSON.stringify(provider.editor)}).first();
    ${cleanComposerCode}
    await composer.fill(${JSON.stringify(prompt)}, { timeout: remaining(15000) });
    const attachments = ${JSON.stringify(attachments)};
    const payloads = attachments.map(attachment => attachment.path);
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
          const attach = page.getByRole('button', { name: /attach|upload|add file|add attachment|add photos|open.*menu/i });
          if (await attach.count() !== 1) throw new Error('${provider.label} upload control was not found unambiguously. Nothing was sent.');
          const chooserPromise = page.waitForEvent('filechooser', { timeout: remaining(3000) }).catch(() => null);
          await attach.click();
          let chooser = await chooserPromise;
          if (!chooser && ${Boolean(provider.uploadMenu)}) {
            const upload = page.getByRole('menuitem', { name: /upload from computer|upload file|upload/i });
            if (await upload.count() === 1) {
              const next = page.waitForEvent('filechooser', { timeout: remaining(10000) });
              await upload.click(); chooser = await next;
            }
          }
          if (chooser) await chooser.setFiles(payload, { timeout: remaining(20000) });
          else await fileInput().setInputFiles(payload, { timeout: remaining(20000) });
        }
      }
    }
    // Require the whole manifest in the same poll. Single-file inputs may
    // replace earlier selections rather than accumulating attachment cards.
    while (attachments.length) {
      remaining();
      let allVisible = true;
      for (const { name } of attachments) {
        if (!await composer.evaluate(${attachmentVisible.toString()}, name)) allVisible = false;
      }
      if (allVisible) break;
      await page.waitForTimeout(remaining(500));
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

function expectedFilesCode(provider, files) {
  const names = files.map(file => typeof file === 'string' ? path.basename(file) : file.name);
  return `for (const name of ${JSON.stringify(names)}) {
      if (!await composer.evaluate(${attachmentVisible.toString()}, name)) throw new Error('${provider.label} attachment is missing before Send: ' + name + '. Nothing was sent.');
    }`;
}

export function providerPreflightCode(provider, prompt, files = []) {
  return `async (page) => {
    ${allowedCode(provider)}
    const composer = page.locator(${JSON.stringify(provider.editor)}).first();
    const text = await composer.evaluate(${readComposerText.toString()});
    const normalize = ${normalizePrompt.toString()};
    if (normalize(text) !== ${JSON.stringify(normalizePrompt(prompt))}) throw new Error('${provider.label} prompt is missing from the composer. Nothing was sent.');
    ${expectedFilesCode(provider, files)}
    const form = composer.locator('xpath=ancestor::form[1]');
    const scope = await form.count() ? form : page;
    ${sendLocatorCode(provider)}
    if (await send.count() !== 1) {
      if (${Boolean(provider.enterFallback)} && await send.count() === 0) return { readyToSend: true, method: 'enter', url: page.url() };
      throw new Error('${provider.label} Send button was not found unambiguously. Nothing was sent.');
    }
    try { await send.click({ trial: true, timeout: ${provider.sendTimeout ?? 30000} }); }
    catch (error) { throw new Error('${provider.label} Send button did not become ready. Nothing was sent. Details: ' + error.message); }
    return { readyToSend: true, url: page.url() };
  }`;
}

export function providerSendCode(provider, expectedPrompt, files = []) {
  return `async (page) => {
    ${allowedCode(provider)}
    const composer = page.locator(${JSON.stringify(provider.editor)}).first();
    const readComposerText = ${readComposerText.toString()};
    const prompt = await composer.evaluate(readComposerText);
    ${expectedPrompt === undefined ? '' : `if ((${normalizePrompt.toString()})(prompt) !== ${JSON.stringify(normalizePrompt(expectedPrompt))}) throw new Error('${provider.label} prompt changed before Send. Nothing was sent.');`}
    ${expectedFilesCode(provider, files)}
    const replySnapshot = ${replySnapshot.toString()};
    const previous = await page.locator(${JSON.stringify(provider.reply)}).evaluateAll(replySnapshot);
    const previousReplies = previous.turns.length;
    const previousReplyKeys = previous.turns.map(turn => turn.key);
    const previousUsers = await page.locator(${JSON.stringify(provider.user ?? '[data-role="user"], [data-testid="user-message"]')}).count();
    const before = { previousReplies, previousReplyKeys, previousUsers, url: page.url() };
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
      user: ${JSON.stringify(provider.user ?? '[data-role="user"], [data-testid="user-message"]')}, reply: ${JSON.stringify(provider.reply)},
      generating: ${JSON.stringify(generationSelector)}, hosts: ${JSON.stringify(provider.hosts)}
    });
    return { submitted: true, prompt, previousReplies, previousReplyKeys, url: page.url() };
  }`;
}

export function providerResponseCode(provider, receipt) {
  return guardCapture(`async (page) => {
    ${allowedCode(provider)}
    const replies = page.locator(${JSON.stringify(provider.reply)});
    const snapshot = await replies.evaluateAll(${replySnapshot.toString()});
    const previousKeys = ${JSON.stringify(receipt.previousReplyKeys ?? [])};
    const candidates = ${Array.isArray(receipt.previousReplyKeys)} ? snapshot.turns.filter(turn => !previousKeys.includes(turn.key)) : snapshot.turns.slice(${JSON.stringify(receipt.previousReplies ?? 0)});
    const latest = candidates.at(-1);
    const text = latest?.text ?? '';
    const generating = await page.locator(${JSON.stringify(generationSelector)}).count() > 0
      || await page.getByRole('button', { name: /stop.*(generat|stream|response)|^stop$/i }).count() > 0;
    const signals = text ? await replies.nth(latest.index).evaluate(${replyCompletion.toString()}) : { streaming: false, finished: false };
    return { text, generating: generating || signals.streaming, complete: !generating && !signals.streaming && signals.finished && text.trim().length > 0, finishedControls: signals.finished, diagnostics: { selector: ${JSON.stringify(provider.reply)}, rawMatches: snapshot.rawMatches, turnMatches: snapshot.turns.length, newTurns: candidates.length }, url: page.url() };
  }`, receipt);
}

export function providerSubmissionCode(provider, captureId, prompt, files = []) {
  if (!captureId) throw new Error('Missing submission tab identity.');
  return `async (page) => {
    page.__promptInjectorCaptureId = ${JSON.stringify(captureId)};
    const receipt = await (${providerSendCode(provider, prompt, files)})(page);
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
