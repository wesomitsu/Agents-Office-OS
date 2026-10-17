import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { buildPrompt, createRunner } from '../src/runner.js';

const store = () => createStore(join(mkdtempSync(join(tmpdir(), 'office-')), 'office.json'));

test('builds a system prompt from the agent and company', () => {
  const s = store();
  const { system, prompt } = buildPrompt(s.agent('support'), { title: 'Refund question', details: 'Order #12' }, { name: 'Acme', about: 'garden tools' });
  assert.match(system, /^You are Sage, the Support agent at Acme \(garden tools\)\./);
  assert.equal(prompt, 'Refund question\n\nOrder #12');
});

test('runs a task and stores the output', async () => {
  const s = store();
  const t = s.addTask({ title: 'Tweet about v2', agentId: 'social' });
  let seen;
  const runner = createRunner(s, { complete: async (req) => ((seen = req), { text: 'Done!', usage: { input: 3, output: 4 } }) });
  const result = await runner.run(t.id);
  assert.equal(result.status, 'done');
  assert.equal(result.output, 'Done!');
  assert.equal(seen.provider, 'demo');
  assert.deepEqual(result.usage, { input: 3, output: 4 });
});

test('marks failures and blocks double runs', async () => {
  const s = store();
  const t = s.addTask({ title: 'Fix login', agentId: 'bugs' });
  let release;
  const runner = createRunner(s, { complete: () => new Promise((_, reject) => (release = () => reject(new Error('timeout')))) });
  const first = runner.run(t.id);
  assert.equal(s.task(t.id).status, 'working');
  await assert.rejects(runner.run(t.id), /already running/);
  release();
  const result = await first;
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'timeout');
});

test('records timings and per-agent stats', async () => {
  const s = store();
  const a = s.addTask({ title: 'Post 1', agentId: 'social' });
  const b = s.addTask({ title: 'Post 2', agentId: 'social' });
  const c = s.addTask({ title: 'Bug', agentId: 'bugs' });
  const runner = createRunner(s, { complete: async ({ prompt }) => { if (prompt === 'Bug') throw new Error('no'); return { text: 'ok', usage: { input: 1, output: 1 } }; } });
  await runner.run(a.id);
  await runner.run(b.id);
  await runner.run(c.id);
  assert.ok(s.task(a.id).startedAt && s.task(a.id).finishedAt);
  const stats = s.stats();
  assert.equal(stats.social.done, 2);
  assert.equal(typeof stats.social.avgSeconds, 'number');
  assert.deepEqual(stats.bugs, { done: 0, failed: 1, avgSeconds: null });
  assert.deepEqual(stats.support, { done: 0, failed: 0, avgSeconds: null });
});

test('follow-ups send the whole conversation and keep the thread', async () => {
  const s = store();
  const t = s.addTask({ title: 'Write a tagline', agentId: 'marketing' });
  const calls = [];
  const runner = createRunner(s, { complete: async (req) => (calls.push(req), { text: `v${calls.length}`, usage: { input: 1, output: 1 } }) });
  await assert.rejects(runner.reply(t.id, 'shorter'), /once the task is done/);
  await runner.run(t.id);
  const r = await runner.reply(t.id, 'make it shorter');
  assert.equal(r.output, 'v2');
  assert.deepEqual(calls[1].history, [
    { role: 'user', content: 'Write a tagline' },
    { role: 'assistant', content: 'v1' },
  ]);
  assert.equal(calls[1].prompt, 'make it shorter');
  assert.equal(s.task(t.id).thread.length, 4);
  assert.deepEqual(s.task(t.id).usage, { input: 2, output: 2 });
});

test('a failed follow-up keeps the earlier answer', async () => {
  const s = store();
  const t = s.addTask({ title: 'Tagline', agentId: 'marketing' });
  let n = 0;
  const runner = createRunner(s, { complete: async () => { if (++n > 1) throw new Error('rate limited'); return { text: 'first', usage: { input: 0, output: 0 } }; } });
  await runner.run(t.id);
  const r = await runner.reply(t.id, 'again');
  assert.equal(r.status, 'done');
  assert.equal(r.output, 'first');
  assert.match(r.error, /Follow-up failed: rate limited/);
});
