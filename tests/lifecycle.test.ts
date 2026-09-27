import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Database } from '@rounding/platform/db';
import { background, listen } from '@rounding/platform/runtime';

test('graceful shutdown drains in-flight delivery before closing service storage', async () => {
  const app = Fastify(); const db = new Database();
  let release!: () => void; const inFlight = new Promise<void>(resolve => { release = resolve; });
  let committed = false;
  background(app, async () => { await inFlight; db.get('SELECT 1'); committed = true; });
  await listen(app, { host: '127.0.0.1', port: 0 }, db);
  const closing = app.close(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(db.get('SELECT 1')); release(); await closing;
  assert.equal(committed, true); assert.throws(() => db.get('SELECT 1'));
});
