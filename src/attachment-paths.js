import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { attachmentMimeType, validateAttachmentList } from './attachments.js';

export function validateAttachmentContent(name, buffer) {
  if (!/\.(md|txt|csv|json|ya?ml|toml|ini|log|py|js|ts|sh)$/i.test(name) || buffer.includes(0)) return;
  const text = buffer.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text)) {
    throw new Error(`Possible credential content in ${name}. Remove credentials before attaching this file.`);
  }
}

export async function stageAttachmentPaths(inputs) {
  const files = await Promise.all(inputs.map(async input => {
    if (typeof input !== 'string' && Buffer.isBuffer(input?.buffer)) {
      return { ...input, size: input.buffer.length, mimeType: attachmentMimeType(input.name, input.mimeType) };
    }
    const filename = path.resolve(typeof input === 'string' ? input : input.path);
    const stat = await fs.stat(filename);
    if (!stat.isFile()) throw new Error(`Not a file: ${filename}`);
    return { path: filename, name: path.basename(filename), size: stat.size, mimeType: attachmentMimeType(filename) };
  }));
  validateAttachmentList(files);
  // Validate every file before creating any temporary copy or opening Chrome.
  for (const file of files) validateAttachmentContent(file.name, file.buffer ?? await fs.readFile(file.path));
  let directory;
  async function cleanup() {
    if (!directory) return;
    const absolute = path.resolve(directory);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('prompt-injector-attachments-')) throw new Error('Refusing cleanup outside the task temporary directory.');
    await fs.rm(absolute, { recursive: true, force: true });
  }
  try {
    if (files.some(file => file.buffer)) directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-injector-attachments-'));
    if (directory && process.platform !== 'win32') await fs.chmod(directory, 0o700);
    const staged = [];
    for (const file of files) {
      if (!file.buffer) { staged.push(file); continue; }
      const filename = path.join(directory, file.name);
      await fs.writeFile(filename, file.buffer, { flag: 'wx', mode: 0o600 });
      staged.push({ name: file.name, size: file.size, mimeType: file.mimeType, path: filename });
    }
    return { files: staged, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
