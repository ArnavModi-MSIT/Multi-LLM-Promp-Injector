// Runs in the provider DOM. Read full filename metadata when cards truncate text.
// Input.files only proves local selection, not that the provider accepted a file.
export function attachmentVisible(editor, name) {
  let scope = editor.closest('form');
  if (!scope) {
    scope = editor;
    for (let depth = 0; depth < 6 && scope.parentElement; depth++) {
      scope = scope.parentElement;
      if (scope.querySelector('input[type="file"], button[aria-label*="send" i], button.send-button, .send-button-container')) break;
    }
  }
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  const attributes = ['title', 'aria-label', 'data-file-name', 'data-filename', 'mattooltip', 'data-tooltip'];
  for (const node of scope.querySelectorAll('*')) {
    if (node === editor || editor.contains(node) || node.tagName === 'INPUT') continue;
    if (!node.getClientRects().length) continue;
    const values = attributes.map(attribute => node.getAttribute(attribute) || '');
    values.push(node.textContent?.trim() || '');
    if (values.some(value => value === name || value === stem || value === 'Remove ' + name || value === 'Delete ' + name)) return true;
  }
  return false;
}
