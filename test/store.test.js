import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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

test('tasks have a priority', () => {
  const store = createStore(tmpFile());
  assert.equal(store.addTask({ title: 'a', agentId: 'support' }).priority, 'normal');
  const t = store.addTask({ title: 'b', agentId: 'support', priority: 'high' });
  assert.equal(t.priority, 'high');
  assert.equal(store.updateTask(t.id, { priority: 'low' }).priority, 'low');
  assert.throws(() => store.addTask({ title: 'c', agentId: 'support', priority: 'urgent!!' }), /bad priority/);
  assert.throws(() => store.updateTask(t.id, { priority: 'x' }), /bad priority/);
});

test('tasks can have a due date', () => {
  const store = createStore(tmpFile());
  assert.equal(store.addTask({ title: 'a', agentId: 'support' }).due, '');
  const t = store.addTask({ title: 'b', agentId: 'support', due: '2026-12-01' });
  assert.equal(t.due, '2026-12-01');
  assert.equal(store.updateTask(t.id, { due: '' }).due, '');
  assert.throws(() => store.addTask({ title: 'c', agentId: 'support', due: 'tomorrow' }), /bad due date/);
  assert.throws(() => store.updateTask(t.id, { due: '2026-13-45' }), /bad due date/);
});

test('a task can be edited before it runs', () => {
  const store = createStore(tmpFile());
  const t = store.addTask({ title: 'Draft', agentId: 'support' });
  const edited = store.updateTask(t.id, { title: 'Final', agentId: 'marketing', repeat: 'weekly' });
  assert.equal(edited.title, 'Final');
  assert.equal(edited.agentId, 'marketing');
  assert.equal(edited.repeat, 'weekly');
  assert.throws(() => store.updateTask(t.id, { agentId: 'ghost' }), /unknown agent/);
  assert.throws(() => store.updateTask(t.id, { repeat: 'hourly' }), /bad repeat/);
  assert.throws(() => store.updateTask(t.id, { title: '  ' }), /title is required/);
});

test('keeps one backup per day and only the last 7', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-'));
  const file = join(dir, 'office.json');
  let day = 1;
  const store = createStore(file, { backups: 7, today: () => `2026-11-${String(day).padStart(2, '0')}` });
  store.addTask({ title: 'first save creates the file', agentId: 'support' });
  for (day = 2; day <= 12; day++) {
    store.addTask({ title: `day ${day}`, agentId: 'support' });
    store.addTask({ title: `again ${day}`, agentId: 'support' }); // second save the same day: no new backup
  }
  const backups = readdirSync(join(dir, 'backups')).sort();
  assert.equal(backups.length, 7);
  assert.equal(backups[0], 'office-2026-11-06.json');
  assert.equal(backups.at(-1), 'office-2026-11-12.json');
  // a backup holds the office as it was before that day's first change
  const last = JSON.parse(readFileSync(join(dir, 'backups', 'office-2026-11-12.json'), 'utf8'));
  assert.ok(last.tasks.some((t) => t.title === 'again 11'));
  assert.ok(!last.tasks.some((t) => t.title === 'day 12'));
});

test('backups can be turned off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'office-'));
  const store = createStore(join(dir, 'office.json'), { backups: 0 });
  store.addTask({ title: 'a', agentId: 'support' });
  store.addTask({ title: 'b', agentId: 'support' });
  assert.ok(!existsSync(join(dir, 'backups')));
});
