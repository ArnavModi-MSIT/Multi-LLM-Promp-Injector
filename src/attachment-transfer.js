import http from 'node:http';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { validateAttachmentList } from './attachments.js';
import { validateAttachmentContent } from './attachment-paths.js';

// The extension cannot always grant Chrome access to server-local paths.
// Transfer bounded bytes to the MCP Node process, which uploads FilePayloads.
// No file bytes or base64 are embedded in generated code or sent to page JS.
export async function createAttachmentTransfer(files) {
  if (!files.length) return { files: [], close: async () => {} };
  const contents = await Promise.all(files.map(file => fs.readFile(file.path)));
  validateAttachmentList(files.map((file, i) => ({ ...file, size: contents[i].length })));
  for (const [i, file] of files.entries()) validateAttachmentContent(file.name, contents[i]);
  const token = randomUUID();
  let port;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin || req.headers['x-attachment-token'] !== token) {
      res.writeHead(403); res.end(); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const index = files.findIndex((_, i) => req.url === `/file/${i}`);
    if (index < 0) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': contents[index].length });
    res.end(contents[index]);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  return {
    files: files.map((file, i) => ({ ...file, upload: { url: `http://127.0.0.1:${port}/file/${i}`, token } })),
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
