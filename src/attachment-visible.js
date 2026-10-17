// Runs in the provider DOM. Read full filename metadata when cards truncate text.
// Input.files only proves local selection, not that the provider accepted a file.
export function attachmentVisible(editor, name) {
  // Attachment cards may be siblings of an inner form or editor wrapper.
  // Climb the draft container, stopping before the conversation history.
  const history = '[data-message-author-role], [data-role="assistant"], [data-role="user"], [data-testid="assistant-message"], article[data-testid^="conversation-turn-"]';
  let scope = editor;
  for (let depth = 0; depth < 10 && scope.parentElement; depth++) {
    const parent = scope.parentElement;
    if (['BODY', 'HTML'].includes(parent.tagName) || parent.querySelector(history)) break;
    scope = parent;
  }
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  const attributes = ['title', 'aria-label', 'alt', 'data-file-name', 'data-filename', 'mattooltip', 'data-tooltip'];
  for (const node of scope.querySelectorAll('*')) {
    if (node === editor || editor.contains(node) || node.contains?.(editor) || node.tagName === 'INPUT' || node.closest?.(history)) continue;
    if (!node.getClientRects().length) continue;
    const values = attributes.map(attribute => node.getAttribute(attribute) || '');
    values.push(node.textContent?.trim() || '');
    // Some cards render the stem and extension in separate children.
    values.push((node.innerText || '').trim());
    if (values.some(value => value === name || value === stem || value === 'Remove ' + name || value === 'Delete ' + name)) return true;
  }
  return false;
}
