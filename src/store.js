import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_AGENTS } from './defaults.js';

const AGENT_FIELDS = ['name', 'role', 'emoji', 'provider', 'model', 'instructions'];
const STATUSES = new Set(['todo', 'working', 'done', 'failed']);

// Keeps the office (agents + tasks) in one JSON file. API keys are never stored here.
export function createStore(path) {
  let state;
  try {
    state = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    state = { agents: structuredClone(DEFAULT_AGENTS), tasks: [] };
  }

  function save() {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path); // write-then-rename so a crash never leaves half a file
  }

  const pick = (input) => Object.fromEntries(AGENT_FIELDS.filter((k) => k in input).map((k) => [k, String(input[k])]));
  const agent = (id) => state.agents.find((a) => a.id === id);

  return {
    agents: () => state.agents,
    agent,

    addAgent(input) {
      if (!input.name || !input.role) throw new Error('name and role are required');
      const a = { id: randomUUID().slice(0, 8), emoji: '🤖', provider: 'demo', model: '', instructions: '', ...pick(input) };
      state.agents.push(a);
      save();
      return a;
    },

    updateAgent(id, input) {
      const a = agent(id);
      if (!a) return null;
      Object.assign(a, pick(input));
      save();
      return a;
    },

    removeAgent(id) {
      const before = state.agents.length;
      state.agents = state.agents.filter((a) => a.id !== id);
      save();
      return state.agents.length < before;
    },

    tasks: () => state.tasks,
    task: (id) => state.tasks.find((t) => t.id === id),

    addTask({ title, details = '', agentId }) {
      if (!title) throw new Error('title is required');
      if (!agent(agentId)) throw new Error(`unknown agent "${agentId}"`);
      const t = {
        id: randomUUID().slice(0, 8),
        title: String(title),
        details: String(details),
        agentId,
        status: 'todo',
        output: '',
        error: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.tasks.unshift(t);
      save();
      return t;
    },

    // Adds token counts from one model call to the task's running total.
    addUsage(id, usage) {
      const t = state.tasks.find((x) => x.id === id);
      if (!t || !usage) return;
      t.usage = { input: (t.usage?.input ?? 0) + usage.input, output: (t.usage?.output ?? 0) + usage.output };
      save();
    },

    updateTask(id, changes) {
      const t = state.tasks.find((x) => x.id === id);
      if (!t) return null;
      if (changes.status && !STATUSES.has(changes.status)) throw new Error(`bad status "${changes.status}"`);
      for (const k of ['status', 'output', 'error', 'title', 'details', 'startedAt', 'finishedAt']) if (k in changes) t[k] = String(changes[k]);
      t.updatedAt = new Date().toISOString();
      save();
      return t;
    },

    // Per-agent counts and average run time for finished tasks.
    stats() {
      const out = {};
      for (const a of state.agents) out[a.id] = { done: 0, failed: 0, avgSeconds: null };
      const totals = {};
      for (const t of state.tasks) {
        const s = out[t.agentId];
        if (!s || (t.status !== 'done' && t.status !== 'failed')) continue;
        s[t.status]++;
        if (t.status === 'done' && t.startedAt && t.finishedAt) {
          const secs = (Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 1000;
          (totals[t.agentId] ??= []).push(secs);
        }
      }
      for (const [id, list] of Object.entries(totals)) out[id].avgSeconds = Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10;
      return out;
    },

    removeTask(id) {
      const before = state.tasks.length;
      state.tasks = state.tasks.filter((t) => t.id !== id);
      save();
      return state.tasks.length < before;
    },
  };
}
