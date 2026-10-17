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
  const runner = createRunner(s, { complete: async (req) => ((seen = req), 'Done!') });
  const result = await runner.run(t.id);
  assert.equal(result.status, 'done');
  assert.equal(result.output, 'Done!');
  assert.equal(seen.provider, 'demo');
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
