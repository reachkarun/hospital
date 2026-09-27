import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApi } from '../src/api.js';
import { Store } from '../src/db.js';
import { demoCredentials } from '../src/config.js';
import { seed } from '../src/seed.js';

test('Swagger is public and documents authenticated, executable API operations', async () => {
  const store = new Store(); seed(store, 'http://billing');
  const app = buildApi(store, demoCredentials);
  try {
    const ui = await app.inject('/docs/');
    assert.equal(ui.statusCode, 200); assert.match(ui.body, /swagger-ui/i);
    const spec = await app.inject('/docs/json');
    assert.equal(spec.statusCode, 200);
    const doc = spec.json();
    assert.equal(doc.openapi, '3.0.3');
    assert.equal(Object.values(doc.paths).reduce((n: number, p: any) => n + Object.keys(p).length, 0), 16);
    assert.equal(doc.components.securitySchemes.bearerAuth.scheme, 'bearer');
    assert.equal(doc.servers[0].url, '/');
    assert.equal((await app.inject('/v1/patients')).statusCode, 401);
    const example = doc.paths['/v1/charges'].post.requestBody.content['application/json'].example;
    const result = await app.inject({ method: 'POST', url: '/v1/charges', headers: { authorization: 'Bearer demo-provider-one' }, payload: example });
    assert.equal(result.statusCode, 200); assert.equal(result.json().status, 'DRAFT');
    assert.equal((await app.inject('/docs/static/swagger-ui-bundle.js')).statusCode, 200);
  } finally { await app.close(); store.close(); }
});
