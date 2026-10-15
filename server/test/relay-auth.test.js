import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createNexusApiServer } from '../src/api.js';
import { createEdgeHandler } from '../../supabase/functions/nexus-relay/handler.js';
import { config } from '../src/config.js';

const origin = 'https://pages.example.test';
async function fixture(t, overrides = {}) {
  const calls = { auth: [] };
  const settings = { ...config, allowedOrigins: [origin], telegramAdminUserIds: [], telegramChats: {}, apiUserRateLimitPerMinute: 100 };
  const options = {
    config: settings,
    db: async () => ({
      auth: { getUser: async token => {
        calls.auth.push(token);
        if (token === 'unavailable') throw new Error('fake auth unavailable');
        if (token === 'invalid') return { error: new Error('invalid') };
        return { data: { user: { id: token } } };
      } },
    }),
    providerStatus: () => ({ configured: true, healthy: true, keyCount: 1 }),
    ...overrides,
  };
  const server = t.adapter === 'node' ? createNexusApiServer(options) : null;
  const edge = createEdgeHandler(options);
  if (server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })); }
  const url = server ? `http://127.0.0.1:${server.address().port}` : 'https://offline.example.test/nexus-relay';
  const send = server ? fetch : (u, init) => edge(new Request(u, init));
  return { calls, url, send };
}

const test = (name, run) => {
  for (const adapter of ['node', 'edge']) nodeTest(`${adapter}: ${name}`, t => { t.adapter = adapter; return run(t); });
};

test('relay session authentication succeeds with a valid bearer', async t => {
  const f = await fixture(t);
  const r = await f.send(f.url + '/api/v1/session', { method: 'GET', headers: { origin, authorization: 'Bearer valid-user' } });
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.userId, 'valid-user');
  assert.equal(f.calls.auth.length, 1);
});

test('relay session authentication fails when credentials are missing', async t => {
  const f = await fixture(t);
  const r = await f.send(f.url + '/api/v1/session', { method: 'GET', headers: { origin } });
  assert.equal(r.status, 401);
});

test('relay session authentication fails when credentials are invalid', async t => {
  const f = await fixture(t);
  const r = await f.send(f.url + '/api/v1/session', { method: 'GET', headers: { origin, authorization: 'Bearer invalid' } });
  assert.equal(r.status, 401);
});

test('relay authentication is unavailable when the auth service throws', async t => {
  const f = await fixture(t);
  const r = await f.send(f.url + '/api/v1/session', { method: 'GET', headers: { origin, authorization: 'Bearer unavailable' } });
  assert.equal(r.status, 503);
});
