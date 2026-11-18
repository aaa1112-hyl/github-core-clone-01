// The forge's HTTP surface: health probe, REST v3, GraphQL v4, MCP and git
// smart HTTP, all served from one in-memory store by one process.
// main.ts (the entry <-> env lifecycle) stays as the starter ships it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './githttp.ts';
import { errJson, pathOf, sendJson } from './http-util.ts';

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const ctx = { store, token };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path.startsWith('/api/v3')) {
          if (await handleRest(req, res, ctx)) return;
        }
        if (path === '/api/graphql') {
          if (await handleGraphql(req, res, ctx)) return;
        }
        if (path === '/mcp') {
          if (await handleMcp(req, res, ctx)) return;
        }
        if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
          if (await handleGit(req, res, ctx)) return;
        }
        errJson(res, 404, 'Not Found');
      } catch (err) {
        try {
          errJson(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } catch {
          // The peer went away; nothing to write to.
        }
      }
    })();
  });
}
