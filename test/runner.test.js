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
  assert.deepEqual(stats.bugs, { done: 0, failed: 1, avgSeconds: null, tokensIn: 0, tokensOut: 0, cost: null, up: 0, down: 0 });
  assert.deepEqual(stats.support, { done: 0, failed: 0, avgSeconds: null, tokensIn: 0, tokensOut: 0, cost: null, up: 0, down: 0 });
  assert.equal(stats.social.tokensIn, 2);
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

test('notifies when a task finishes', async () => {
  const s = store();
  const t = s.addTask({ title: 'Ping', agentId: 'support' });
  const seen = [];
  const runner = createRunner(s, { complete: async () => ({ text: 'pong', usage: { input: 0, output: 0 } }), notify: async (task, agent) => seen.push([task.status, agent.name]) });
  await runner.run(t.id);
  assert.deepEqual(seen, [['done', 'Sage']]);
});

test('estimates cost from token usage and agent prices', async () => {
  const s = store();
  s.updateAgent('bugs', { priceIn: '3', priceOut: '15' });
  const t = s.addTask({ title: 'Fix', agentId: 'bugs' });
  const runner = createRunner(s, { complete: async () => ({ text: 'ok', usage: { input: 100000, output: 20000 } }) });
  await runner.run(t.id);
  // 0.1M in * $3 + 0.02M out * $15 = $0.60
  assert.equal(s.stats().bugs.cost, 0.6);
  assert.equal(s.stats().support.cost, null);
  assert.throws(() => s.updateAgent('bugs', { priceIn: 'cheap' }), /dollars per 1M tokens/);
});

test('a repeating task queues its next copy when done', async () => {
  const s = store();
  const t = s.addTask({ title: 'Weekly report', agentId: 'marketing', repeat: 'weekly', due: '2026-11-02' });
  const runner = createRunner(s, { complete: async () => ({ text: 'ok', usage: { input: 0, output: 0 } }) });
  await runner.run(t.id);
  const next = s.tasks().find((x) => x.id !== t.id);
  assert.equal(next.status, 'todo');
  assert.equal(next.due, '2026-11-09');
  assert.equal(next.repeat, 'weekly');
  await runner.run(t.id); // redoing the same task doesn't queue a second copy
  assert.equal(s.tasks().length, 2);
  assert.throws(() => s.addTask({ title: 'x', agentId: 'support', repeat: 'hourly' }), /bad repeat/);
});

test('runs at most maxConcurrent tasks at once', async () => {
  const s = store();
  const ids = ['a', 'b', 'c'].map((title) => s.addTask({ title, agentId: 'support' }).id);
  let live = 0;
  let peak = 0;
  const gates = [];
  const runner = createRunner(s, {
    maxConcurrent: 2,
    complete: () => new Promise((resolve) => {
      live++;
      peak = Math.max(peak, live);
      gates.push(() => { live--; resolve({ text: 'ok', usage: { input: 0, output: 0 } }); });
    }),
  });
  const all = ids.map((id) => runner.run(id));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(gates.length, 2);
  assert.equal(runner.waitingIds().length, 1);
  assert.equal(s.task(runner.waitingIds()[0]).status, 'working');
  gates.shift()();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runner.waitingIds().length, 0);
  while (gates.length) gates.shift()();
  await Promise.all(all);
  assert.equal(peak, 2);
  assert.ok(ids.every((id) => s.task(id).status === 'done'));
});

test('the company brief is added to every agent prompt', () => {
  const s = store();
  const { system } = buildPrompt(s.agent('support'), { title: 'Hi' }, { name: 'Acme', about: 'tools', brief: 'Never promise refunds.' });
  assert.match(system, /at Acme \(tools\)/);
  assert.match(system, /About the company:\nNever promise refunds\.$/);
});

test('the runner reads the company fresh for each task', async () => {
  const s = store();
  let company = { name: 'Old' };
  const seen = [];
  const runner = createRunner(s, { company: () => company, complete: async (req) => (seen.push(req.system), { text: 'ok', usage: { input: 0, output: 0 } }) });
  await runner.run(s.addTask({ title: 'a', agentId: 'support' }).id);
  company = { name: 'New' };
  await runner.run(s.addTask({ title: 'b', agentId: 'support' }).id);
  assert.match(seen[0], /at Old/);
  assert.match(seen[1], /at New/);
});

test('a task can use a different model than its agent', async () => {
  const s = store();
  s.updateAgent('bugs', { provider: 'demo', model: 'everyday-model' });
  const seen = [];
  const runner = createRunner(s, { complete: async (req) => (seen.push(req.model), { text: 'ok', usage: { input: 0, output: 0 } }) });
  await runner.run(s.addTask({ title: 'hard bug', agentId: 'bugs', model: 'strong-model' }).id);
  await runner.run(s.addTask({ title: 'easy bug', agentId: 'bugs' }).id);
  assert.deepEqual(seen, ['strong-model', 'everyday-model']);
  assert.throws(() => s.addTask({ title: 'x', agentId: 'bugs', model: 'x'.repeat(101) }), /model name is too long/);
});

test('results can be rated and ratings add up per agent', async () => {
  const s = store();
  const runner = createRunner(s, { complete: async () => ({ text: 'ok', usage: { input: 0, output: 0 } }) });
  const a = s.addTask({ title: 'a', agentId: 'social' });
  const b = s.addTask({ title: 'b', agentId: 'social' });
  await runner.run(a.id);
  await runner.run(b.id);
  s.updateTask(a.id, { rating: 'up' });
  s.updateTask(b.id, { rating: 'down' });
  assert.equal(s.stats().social.up, 1);
  assert.equal(s.stats().social.down, 1);
  s.updateTask(b.id, { rating: '' });
  assert.equal(s.stats().social.down, 0);
  assert.throws(() => s.updateTask(a.id, { rating: 'meh' }), /bad rating/);
});

test('keeps a short activity feed', async () => {
  const s = store();
  const runner = createRunner(s, { complete: async ({ prompt }) => { if (prompt === 'bad') throw new Error('rate limited'); return { text: 'ok', usage: { input: 0, output: 0 } }; } });
  const t = s.addTask({ title: 'Launch post', agentId: 'social' });
  await runner.run(t.id);
  await runner.run(s.addTask({ title: 'bad', agentId: 'bugs' }).id);
  s.removeTask(t.id);
  const texts = s.activity().map((e) => e.text);
  assert.deepEqual(texts.slice(0, 4), ['Deleted "Launch post"', 'Bolt couldn\'t finish "bad": rate limited', 'New task for Bolt: "bad"', 'Sky finished "Launch post"']);
  assert.ok(s.activity().every((e) => !Number.isNaN(Date.parse(e.at))));
  for (let i = 0; i < 120; i++) s.addTask({ title: `t${i}`, agentId: 'support' });
  assert.equal(s.activity().length, 100);
});

test('falls back to backup providers in order when the agent provider fails', async () => {
  const s = store();
  const a = s.addAgent({ name: 'Ann', role: 'x', provider: 'anthropic', model: 'big' });
  const t = s.addTask({ agentId: a.id, title: 'Post' });
  const tried = [];
  const runner = createRunner(s, {
    backups: ['anthropic', 'openai', 'demo'],
    complete: async (req) => {
      tried.push([req.provider, req.model]);
      if (req.provider !== 'demo') throw new Error(`${req.provider} down`);
      return { text: 'saved', usage: { input: 1, output: 1 } };
    },
  });
  const result = await runner.run(t.id);
  assert.deepEqual(tried, [['anthropic', 'big'], ['openai', ''], ['demo', '']]);
  assert.equal(result.status, 'done');
  assert.equal(result.output, 'saved');
  assert.ok(s.activity().some((e) => e.text === 'Ann used backup provider demo for "Post"'));
});

test('reports every provider error when all backups fail', async () => {
  const s = store();
  const a = s.addAgent({ name: 'Ann', role: 'x', provider: 'anthropic' });
  const t = s.addTask({ agentId: a.id, title: 'Post' });
  const runner = createRunner(s, { backups: ['openai'], complete: async (req) => { throw new Error(`${req.provider} down`); } });
  const result = await runner.run(t.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'anthropic down | backup openai: openai down');
});
