import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { createRunner } from '../src/runner.js';
import { createStore } from '../src/store.js';

async function withServer(fn, env = { ANTHROPIC_API_KEY: 'secret-value' }) {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'office-')), 'office.json'));
  const runner = createRunner(store, { complete: async () => ({ text: 'All done', usage: { input: 10, output: 20 } }) });
  const server = createServer(createApp({ store, runner, env }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await fn(api, base);
  } finally {
    server.close();
  }
}

test('GET /api/office lists agents and providers but never keys', async () => {
  await withServer(async (api) => {
    const { status, data } = await api('GET', '/api/office');
    assert.equal(status, 200);
    assert.equal(data.agents.length, 5);
    assert.ok(data.templates.some((t) => t.role === 'SEO'));
    assert.equal(data.providers.find((p) => p.id === 'anthropic').configured, true);
    assert.ok(!JSON.stringify(data).includes('secret-value'));
  });
});

test('create, run and delete a task', async () => {
  await withServer(async (api) => {
    const created = await api('POST', '/api/tasks', { title: 'Write FAQ', agentId: 'support' });
    assert.equal(created.status, 201);
    const run = await api('POST', `/api/tasks/${created.data.id}/run`);
    assert.equal(run.status, 202);
    await new Promise((r) => setTimeout(r, 20));
    const office = await api('GET', '/api/office');
    assert.equal(office.data.tasks[0].output, 'All done');
    assert.equal((await api('DELETE', `/api/tasks/${created.data.id}`)).status, 200);
    assert.equal((await api('DELETE', `/api/tasks/${created.data.id}`)).status, 404);
  });
});

test('edits agents and reports bad input', async () => {
  await withServer(async (api) => {
    const r = await api('PATCH', '/api/agents/web', { provider: 'anthropic', model: 'claude-opus-5-5' });
    assert.equal(r.data.provider, 'anthropic');
    assert.equal((await api('POST', '/api/agents', { name: 'x' })).status, 400);
    assert.equal((await api('POST', '/api/tasks', { title: 't', agentId: 'ghost' })).status, 400);
  });
});

test('static files cannot escape the public folder', async () => {
  await withServer(async (_, base) => {
    const res = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.notEqual(res.status, 200);
  });
});

test('OFFICE_PASSWORD puts the whole office behind a login', async () => {
  await withServer(async (_, base) => {
    assert.equal((await fetch(`${base}/api/office`)).status, 401);
    assert.equal((await fetch(`${base}/`)).status, 401);
    const bad = { Authorization: `Basic ${Buffer.from('me:nope').toString('base64')}` };
    assert.equal((await fetch(`${base}/api/office`, { headers: bad })).status, 401);
    const good = { Authorization: `Basic ${Buffer.from('me:s3cret:pw').toString('base64')}` };
    assert.equal((await fetch(`${base}/api/office`, { headers: good })).status, 200);
  }, { OFFICE_PASSWORD: 's3cret:pw' });
});

test('hands a finished task to another agent', async () => {
  await withServer(async (api) => {
    const t = (await api('POST', '/api/tasks', { title: 'Spring campaign', agentId: 'marketing' })).data;
    assert.equal((await api('POST', `/api/tasks/${t.id}/handoff`, { agentId: 'social' })).status, 400);
    await api('POST', `/api/tasks/${t.id}/run`);
    await new Promise((r) => setTimeout(r, 20));
    const h = await api('POST', `/api/tasks/${t.id}/handoff`, { agentId: 'social', note: 'Turn this into 3 posts' });
    assert.equal(h.status, 201);
    assert.equal(h.data.agentId, 'social');
    assert.match(h.data.details, /^Turn this into 3 posts\n\nWork from Max \(Marketing\):\n\nAll done$/);
    assert.equal((await api('POST', '/api/tasks/nope/handoff', { agentId: 'social' })).status, 404);
  });
});

test('exports the team and imports it back', async () => {
  await withServer(async (api) => {
    const exported = (await api('GET', '/api/export')).data;
    assert.equal(exported.agents.length, 5);
    assert.equal(exported.tasks, undefined);
    exported.agents.pop();
    assert.equal((await api('POST', '/api/import', exported)).data.agents.length, 4);
    assert.equal((await api('POST', '/api/import', { agents: 'nope' })).status, 400);
  });
});
