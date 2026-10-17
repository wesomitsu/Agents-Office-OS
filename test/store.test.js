import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'office-')), 'data', 'office.json');

test('starts with the five default agents', () => {
  const store = createStore(tmpFile());
  assert.deepEqual(store.agents().map((a) => a.role), ['Social Media', 'Marketing', 'Website Editor', 'Bug Fixer', 'Support']);
});

test('adds, edits and removes agents, and saves to disk', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.addAgent({ name: 'Nova', role: 'SEO', provider: 'openai', model: 'gpt-x', apiKey: 'should-be-ignored' });
  assert.equal(a.emoji, '🤖');
  assert.equal(a.apiKey, undefined);
  store.updateAgent(a.id, { model: 'gpt-y' });
  assert.equal(createStore(file).agent(a.id).model, 'gpt-y');
  assert.ok(store.removeAgent(a.id));
  assert.equal(createStore(file).agent(a.id), undefined);
  assert.throws(() => store.addAgent({ name: 'x' }), /required/);
});

test('tasks belong to an agent and move through statuses', () => {
  const file = tmpFile();
  const store = createStore(file);
  const t = store.addTask({ title: 'Launch post', agentId: 'social' });
  assert.equal(t.status, 'todo');
  store.updateTask(t.id, { status: 'done', output: 'Posted!' });
  const saved = JSON.parse(readFileSync(file, 'utf8')).tasks[0];
  assert.equal(saved.status, 'done');
  assert.equal(saved.output, 'Posted!');
  assert.throws(() => store.updateTask(t.id, { status: 'nope' }), /bad status/);
  assert.throws(() => store.addTask({ title: 'x', agentId: 'ghost' }), /unknown agent/);
  assert.ok(store.removeTask(t.id));
});

test('imports a team, validating each agent', () => {
  const store = createStore(tmpFile());
  assert.throws(() => store.importAgents([]), /non-empty/);
  assert.throws(() => store.importAgents([{ name: 'x' }]), /agent 1 needs a name and role/);
  assert.throws(() => store.importAgents([{ id: 'a', name: 'A', role: 'R' }, { id: 'a', name: 'B', role: 'R' }]), /unique/);
  const team = store.importAgents([{ id: 'seo', name: 'Scout', role: 'SEO', apiKey: 'nope' }, { id: '../bad', name: 'Q', role: 'Writer' }]);
  assert.equal(team[0].id, 'seo');
  assert.equal(team[0].apiKey, undefined);
  assert.notEqual(team[1].id, '../bad');
  assert.equal(store.agents().length, 2);
});
