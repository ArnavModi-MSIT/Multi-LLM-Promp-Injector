// Refuse an existing attachment draft rather than risk sending files from a prior run.
export const cleanComposerCode = `
    const draftText = await composer.evaluate(el => el.value ?? el.innerText ?? '');
    if (draftText.trim() && !page.__promptInjectorFreshTab) throw new Error('An unsent draft already exists. Send or clear it in this tab before preparing another prompt. Nothing was changed.');
    const removeAttachments = page.getByRole('button', { name: /remove.*(file|attachment|upload)|delete.*(file|attachment)|^(remove|delete)\\s+[^ ]+\\.[a-z0-9]+$/i }).filter({ visible: true });
    const selectedFiles = await page.locator('input[type="file"]').evaluateAll(inputs => inputs.some(input => input.files && input.files.length));
    if (await removeAttachments.count() || selectedFiles) throw new Error('Existing attachments are staged. Remove them in this tab before preparing another prompt. Nothing was sent.');
    page.__promptInjectorFreshTab = false;
`;
