import path from 'node:path';

export const maxFiles = 5;
export const maxFileBytes = 10 * 1024 * 1024;
export const maxTotalBytes = 20 * 1024 * 1024;
export const maxRequestBytes = 28 * 1024 * 1024;

export function validateAttachmentList(files) {
  if (!Array.isArray(files)) throw new Error('Files must be a list.');
  if (files.length > maxFiles) throw new Error(`Choose at most ${maxFiles} files.`);
  let total = 0;
  const names = new Set();
  const stems = new Set();
  for (const file of files) {
    const name = file?.name;
    if (typeof name !== 'string' || !name || name !== path.basename(name) || /[\\/]/.test(name)) throw new Error('Invalid filename.');
    if (/(^\.env($|\.)|\.pem$|\.p12$|\.key$|^id_rsa$|^credentials\.json$)/i.test(name)) throw new Error(`This filename may contain credentials: ${name}.`);
    const size = file.size;
    if (!Number.isInteger(size) || size < 1 || size > maxFileBytes) throw new Error(`Each file must be between 1 byte and 10 MB: ${name}.`);
    const lowerName = name.toLowerCase();
    const stem = path.parse(name).name.toLowerCase();
    if (names.has(lowerName) || stems.has(stem)) throw new Error(`Files need distinct names before the extension: ${name}.`);
    names.add(lowerName);
    stems.add(stem);
    total += size;
  }
  if (total > maxTotalBytes) throw new Error('Files exceed the 20 MB combined limit.');
  return files;
}
