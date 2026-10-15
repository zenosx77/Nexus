// Node HTTP adapter; security/routing is shared with the Supabase Edge Function.
import http from 'node:http';
import { Readable } from 'node:stream';
import { createNexusApiHandler } from './api-handler.js';

export function createNexusApiServer(options = {}) {
  const handle = createNexusApiHandler(options);
  return http.createServer(async (req, res) => {
    try {
      const request = new Request(new URL(req.url, 'http://nexus.local'), {
        method: req.method, headers: req.headers,
        ...(!['GET', 'HEAD'].includes(req.method)
          ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      });
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"error":"Internal server error"}');
    }
  });
}
