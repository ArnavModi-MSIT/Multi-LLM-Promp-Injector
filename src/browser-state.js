// These helpers are embedded into generated Playwright code without imports.
export function normalizePrompt(text) {
  return text.replace(/\r\n?/g, '\n').trim();
}

export function readComposerText(element) {
  if (typeof element.value === 'string') return element.value;
  // Chromium innerText adds an extra newline for an empty <div><br></div>.
  // Decode editor line blocks instead of collapsing meaningful whitespace.
  function read(parent) {
    let text = '';
    let previous = false;
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) { text += node.nodeValue; previous = true; continue; }
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'BR') { text += '\n'; previous = true; continue; }
      const block = /^(DIV|P|LI)$/.test(node.tagName);
      if (block && previous) text += '\n';
      const placeholder = node.childNodes.length === 1 && node.firstChild.nodeName === 'BR';
      text += placeholder ? '' : read(node);
      previous = true;
    }
    return text;
  }
  return read(element);
}

export function replySnapshot(nodes) {
  const roots = nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
  const turns = roots.filter(node => node.getClientRects().length).map(node => {
    const text = node.innerText ?? '';
    const stableId = node.getAttribute('data-message-id') || node.id;
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return { key: stableId ? 'id:' + stableId : 'text:' + (hash >>> 0) + ':' + text.length, text, index: nodes.indexOf(node) };
  });
  return { rawMatches: nodes.length, turns };
}

export async function confirmSubmission(page, composer, before, selectors) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const currentUrl = new URL(page.url());
    if (currentUrl.protocol !== 'https:' || !selectors.hosts.includes(currentUrl.hostname)) {
      throw new Error('Provider tab navigated away during submission. Check it before retrying.');
    }
    // Never treat a failed editor read as an empty/cleared editor.
    const present = await composer.count();
    const text = present ? await composer.evaluate(readComposerText) : null;
    const newUserTurn = await page.locator(selectors.user).count() > before.previousUsers;
    const replies = await page.locator(selectors.reply).evaluateAll(replySnapshot);
    const newReply = replies.turns.some(turn => !before.previousReplyKeys.includes(turn.key));
    const generating = await page.locator(selectors.generating).count() > 0;
    const newConversation = currentUrl.href !== before.url;
    if (newUserTurn || (text === '' && (newReply || generating || newConversation))) return;
    await page.waitForTimeout(250);
  }
  throw new Error('Submission was not confirmed by a new turn or generation signal. Check this tab before retrying.');
}

export function replyCompletion(element) {
  const turn = element.closest('[data-message-author-role="assistant"], [data-role="assistant"], [data-testid="assistant-message"], model-response, .model-response') || element;
  const visible = node => Boolean(node.getClientRects().length);
  const streaming = element.closest('[data-is-streaming="true"], [data-streaming="true"]')
    || element.querySelector('[data-is-streaming="true"], [data-streaming="true"]');
  let finished = element.matches('[data-is-streaming="false"], [data-streaming="false"]') || turn.matches('[data-is-streaming="false"], [data-streaming="false"]');
  for (const button of turn.querySelectorAll('button')) {
    if (!visible(button) || button.closest('pre, code, [data-code-block]')) continue;
    const name = button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent?.trim() || '';
    if (/^copy(?: response| message)?$/i.test(name)) finished = true;
  }
  return { streaming: Boolean(streaming), finished };
}

export const generationSelector = 'button[data-testid="stop-button"]:visible, button[aria-label*="stop" i]:visible, button[title*="stop" i]:visible, [data-is-streaming="true"]:visible, [data-streaming="true"]:visible';

export function currentNoticeTexts(nodes) {
  const history = '[data-message-author-role], [data-role="assistant"], [data-role="user"], [data-testid="assistant-message"], article';
  return nodes.filter(node => !node.closest(history) && !node.querySelector(history))
    .map(node => node.innerText ?? node.textContent ?? '');
}
