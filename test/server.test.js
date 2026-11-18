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

test('clears finished tasks, optionally for one agent', async () => {
  await withServer(async (api) => {
    const ids = [];
    for (const agentId of ['social', 'social', 'bugs']) {
      const t = (await api('POST', '/api/tasks', { title: 'x', agentId })).data;
      await api('POST', `/api/tasks/${t.id}/run`);
      ids.push(t.id);
    }
    await api('POST', '/api/tasks', { title: 'still to do', agentId: 'social' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await api('POST', '/api/tasks/clear-done', { agentId: 'bugs' })).data.removed, 1);
    assert.equal((await api('POST', '/api/tasks/clear-done', {})).data.removed, 2);
    const left = (await api('GET', '/api/office')).data.tasks;
    assert.deepEqual(left.map((t) => t.title), ['still to do']);
  });
});

test('health check answers without a login and leaks nothing', async () => {
  await withServer(async (_, base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal((await fetch(`${base}/api/office`)).status, 401);
  }, { OFFICE_PASSWORD: 'pw' });
});

test('an off-duty agent takes no new work', async () => {
  await withServer(async (api) => {
    await api('PATCH', '/api/agents/social', { offDuty: 'true' });
    const t = (await api('POST', '/api/tasks', { title: 'Post', agentId: 'social' })).data;
    const r = await api('POST', `/api/tasks/${t.id}/run`);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Sky is off duty/);
    await api('PATCH', '/api/agents/social', { offDuty: 'nonsense' });
    assert.equal((await api('POST', `/api/tasks/${t.id}/run`)).status, 202);
  });
});

test('exports tasks as CSV and neutralises formulas', async () => {
  await withServer(async (api, base) => {
    await api('POST', '/api/tasks', { title: '=HYPERLINK("http://x")', details: 'line1\nline2, "quoted"', agentId: 'support' });
    const res = await fetch(`${base}/api/tasks.csv`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /agents-office-tasks\.csv/);
    const text = (await res.text()).replace(/^﻿/, '');
    const lines = text.split('\r\n');
    assert.equal(lines[0], 'title,agent,role,status,priority,due,created,finished,tokens,details,result,error');
    assert.ok(lines[1].startsWith(`"'=HYPERLINK(""http://x"")",Sage,Support,todo,normal`), lines[1]);
    assert.ok(text.includes('"line1\nline2, ""quoted"""'));
  });
});

test('starts all waiting tasks, skipping off-duty agents', async () => {
  await withServer(async (api) => {
    await api('POST', '/api/tasks', { title: 'a', agentId: 'support' });
    await api('POST', '/api/tasks', { title: 'b', agentId: 'bugs' });
    await api('POST', '/api/tasks', { title: 'c', agentId: 'web' });
    await api('PATCH', '/api/agents/web', { offDuty: 'true' });
    assert.deepEqual((await api('POST', '/api/tasks/start-all', { agentId: 'support' })).data, { started: 1, skipped: 0 });
    assert.deepEqual((await api('POST', '/api/tasks/start-all', {})).data, { started: 1, skipped: 1 });
    await new Promise((r) => setTimeout(r, 30));
    const statuses = (await api('GET', '/api/office')).data.tasks.map((t) => `${t.title}:${t.status}`).sort();
    assert.deepEqual(statuses, ['a:done', 'b:done', 'c:todo']);
  });
});

test('rearranges desks', async () => {
  await withServer(async (api) => {
    const r = await api('POST', '/api/agents/support/move', { direction: 'left' });
    assert.deepEqual(r.data.order, ['social', 'marketing', 'web', 'support', 'bugs']);
    assert.deepEqual((await api('POST', '/api/agents/social/move', { direction: 'left' })).data.order[0], 'social');
    assert.equal((await api('POST', '/api/agents/social/move', { direction: 'up' })).status, 400);
    assert.equal((await api('POST', '/api/agents/ghost/move', { direction: 'left' })).status, 404);
    const office = (await api('GET', '/api/office')).data;
    assert.equal(office.agents[3].id, 'support');
  });
});

test('copies an agent', async () => {
  await withServer(async (api) => {
    await api('PATCH', '/api/agents/bugs', { model: 'claude-opus-5-5', priceIn: '4' });
    const r = await api('POST', '/api/agents/bugs/clone');
    assert.equal(r.status, 201);
    assert.equal(r.data.name, 'Bolt (copy)');
    assert.equal(r.data.model, 'claude-opus-5-5');
    assert.equal(r.data.priceIn, '4');
    assert.notEqual(r.data.id, 'bugs');
    const ids = (await api('GET', '/api/office')).data.agents.map((a) => a.id);
    assert.equal(ids[ids.indexOf('bugs') + 1], r.data.id); // placed right after the original
    assert.equal((await api('POST', '/api/agents/ghost/clone')).status, 404);
  });
});

test('a deleted task can be restored', async () => {
  await withServer(async (api) => {
    const t = (await api('POST', '/api/tasks', { title: 'Oops', agentId: 'support' })).data;
    assert.equal((await api('DELETE', `/api/tasks/${t.id}`)).status, 200);
    assert.equal((await api('GET', '/api/office')).data.tasks.length, 0);
    const r = await api('POST', `/api/tasks/${t.id}/restore`);
    assert.equal(r.status, 200);
    assert.equal(r.data.title, 'Oops');
    assert.equal((await api('GET', '/api/office')).data.tasks.length, 1);
    assert.equal((await api('POST', `/api/tasks/${t.id}/restore`)).status, 404); // only once
  });
});

test('sends one task to every on-duty agent', async () => {
  await withServer(async (api) => {
    await api('PATCH', '/api/agents/bugs', { offDuty: 'true' });
    const r = await api('POST', '/api/tasks/broadcast', { title: 'Ideas for our launch?', priority: 'high' });
    assert.equal(r.status, 201);
    assert.equal(r.data.tasks.length, 4);
    assert.ok(!r.data.tasks.some((t) => t.agentId === 'bugs'));
    assert.ok(r.data.tasks.every((t) => t.title === 'Ideas for our launch?' && t.priority === 'high'));
    const some = await api('POST', '/api/tasks/broadcast', { title: 'x', agentIds: ['social', 'web'] });
    assert.deepEqual(some.data.tasks.map((t) => t.agentId), ['social', 'web']);
    assert.equal((await api('POST', '/api/tasks/broadcast', { title: '' })).status, 400);
  });
});

test('locks out an address after repeated wrong passwords', async () => {
  await withServer(async (_, base) => {
    const bad = { Authorization: `Basic ${Buffer.from('x:wrong').toString('base64')}` };
    const good = { Authorization: `Basic ${Buffer.from('x:pw').toString('base64')}` };
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/api/office`, { headers: bad })).status, 401);
    const locked = await fetch(`${base}/api/office`, { headers: good });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  }, { OFFICE_PASSWORD: 'pw' });
});

test('a correct password clears earlier failures', async () => {
  await withServer(async (_, base) => {
    const bad = { Authorization: `Basic ${Buffer.from('x:wrong').toString('base64')}` };
    const good = { Authorization: `Basic ${Buffer.from('x:pw').toString('base64')}` };
    for (let i = 0; i < 9; i++) await fetch(`${base}/api/office`, { headers: bad });
    assert.equal((await fetch(`${base}/api/office`, { headers: good })).status, 200);
    for (let i = 0; i < 9; i++) await fetch(`${base}/api/office`, { headers: bad });
    assert.equal((await fetch(`${base}/api/office`, { headers: good })).status, 200);
  }, { OFFICE_PASSWORD: 'pw' });
});

test('the company profile can be edited and reaches the agents', async () => {
  await withServer(async (api) => {
    assert.equal((await api('GET', '/api/office')).data.company.name, '');
    const r = await api('PUT', '/api/company', { name: 'Acme', about: 'garden tools', brief: 'Tone: friendly. Never promise refunds.' });
    assert.equal(r.status, 200);
    assert.deepEqual((await api('GET', '/api/office')).data.company, { name: 'Acme', about: 'garden tools', brief: 'Tone: friendly. Never promise refunds.' });
    assert.equal((await api('PUT', '/api/company', { brief: 'x'.repeat(4001) })).status, 400);
  });
});

test('shows the exact prompt an agent will receive, without calling a model', async () => {
  await withServer(async (api) => {
    await api('PUT', '/api/company', { name: 'Acme', brief: 'Be brief.' });
    const t = (await api('POST', '/api/tasks', { title: 'Refund reply', details: 'Order #12', agentId: 'support' })).data;
    const r = await api('GET', `/api/tasks/${t.id}/prompt`);
    assert.equal(r.status, 200);
    assert.match(r.data.system, /^You are Sage, the Support agent at Acme\./);
    assert.match(r.data.system, /About the company:\nBe brief\.$/);
    assert.equal(r.data.prompt, 'Refund reply\n\nOrder #12');
    assert.equal(r.data.provider, 'demo');
    assert.equal((await api('GET', '/api/tasks/nope/prompt')).status, 404);
    assert.equal((await api('GET', '/api/office')).data.tasks[0].status, 'todo');
  });
});

test('retries every failed task', async () => {
  await withServer(async (api) => {
    const ids = [];
    for (const title of ['a', 'b']) ids.push((await api('POST', '/api/tasks', { title, agentId: 'support' })).data.id);
    for (const id of ids) await api('PATCH', `/api/tasks/${id}`, { status: 'failed', error: 'timeout' });
    await api('POST', '/api/tasks', { title: 'c', agentId: 'support' });
    const r = await api('POST', '/api/tasks/retry-failed', {});
    assert.deepEqual(r.data, { started: 2, skipped: 0 });
    await new Promise((res) => setTimeout(res, 30));
    const statuses = (await api('GET', '/api/office')).data.tasks.map((t) => `${t.title}:${t.status}`).sort();
    assert.deepEqual(statuses, ['a:done', 'b:done', 'c:todo']);
  });
});
