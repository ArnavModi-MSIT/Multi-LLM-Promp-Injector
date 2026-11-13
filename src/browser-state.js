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

export async function confirmSubmission(page, composer, before, selectors) {
  if (!Number.isFinite(selectors.timeoutMs) || selectors.timeoutMs <= 0) throw new Error('A submission confirmation time limit is required.');
  const deadline = Date.now() + selectors.timeoutMs;
  const retry = selectors.retry;
  let lastAttemptAt = Date.now();
  let retries = 0;
  while (true) {
    const currentUrl = new URL(page.url());
    if (currentUrl.protocol !== 'https:' || !selectors.hosts.includes(currentUrl.hostname)) {
      throw new Error('Provider tab navigated away during submission. Check it before retrying.');
    }
    // Never treat a failed editor read as an empty/cleared editor.
    const present = await composer.count();
    const text = present ? await composer.evaluate(readComposerText) : null;
    const newUserTurn = await page.locator(selectors.user).count() > before.previousUsers;
    const newReply = await page.locator(selectors.reply).count() > before.previousReplies;
    const generating = await page.locator(selectors.generating).count() > 0;
    const newConversation = currentUrl.href !== before.url;
    if (newUserTurn || (text === '' && (newReply || generating || newConversation))) return { retries };
    // Some sites ignore Send while an attachment is still processing. Click again only
    // when every sign says the earlier click did nothing: the exact prompt and the
    // attachment cards are still in the composer, with no new turn, no generation and
    // no URL change, for a full interval since the last attempt. At most retry.max times.
    if (retry && retries < retry.max && Date.now() - lastAttemptAt >= retry.afterMs
      && !newReply && !generating && !newConversation && text !== null && text === retry.draft && await retry.stillStaged()) {
      retries++;
      lastAttemptAt = Date.now();
      await retry.resend();
    }
    if (Date.now() > deadline) throw new Error('Submission was not confirmed within ' + Math.round(selectors.timeoutMs / 1000) + ' seconds. The prompt may have been sent. Check this tab before retrying.');
    await page.waitForTimeout(250);
  }
}

export const generationSelector = 'button[data-testid="stop-button"]:visible, button[aria-label*="stop" i]:visible, button[title*="stop" i]:visible, [data-is-streaming="true"]:visible, [data-streaming="true"]:visible';

export function currentNoticeTexts(nodes) {
  const history = '[data-message-author-role], [data-role="assistant"], [data-role="user"], [data-testid="assistant-message"], article';
  return nodes.filter(node => !node.closest(history) && !node.querySelector(history))
    .map(node => node.innerText ?? node.textContent ?? '');
}
