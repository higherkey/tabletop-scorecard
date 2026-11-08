import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendText(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(message);
}

export function startServer({ port = Number(process.env.PORT) || 5173, root = DEFAULT_ROOT } = {}) {
  const rootDir = resolve(root);

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendText(res, 405, 'Method Not Allowed');
      }

      const rawPath = (req.url || '/').split('?')[0];
      let pathname;
      try {
        pathname = decodeURIComponent(rawPath);
      } catch {
        return sendText(res, 400, 'Bad Request');
      }
      if (pathname.includes('\0')) return sendText(res, 400, 'Bad Request');
      if (pathname.split(/[/\\]/).some((seg) => seg.startsWith('.'))) return sendText(res, 403, 'Forbidden');
      if (pathname === '/') pathname = '/index.html';

      const filePath = resolve(join(rootDir, pathname));
      if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
        return sendText(res, 403, 'Forbidden');
      }

      let info;
      try {
        info = await stat(filePath);
      } catch {
        return sendText(res, 404, 'Not Found');
      }
      if (!info.isFile()) return sendText(res, 404, 'Not Found');

      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
      else res.end();
    }
  });

  return new Promise((resolvePromise, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolvePromise(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer()
    .then((server) => {
      const { port } = server.address();
      console.log(`Serving ${DEFAULT_ROOT} at http://127.0.0.1:${port}/`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
