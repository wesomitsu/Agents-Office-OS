import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_AGENTS } from './defaults.js';

const AGENT_FIELDS = ['name', 'role', 'emoji', 'provider', 'model', 'instructions', 'priceIn', 'priceOut', 'offDuty', 'maxTokens', 'budget'];
const STATUSES = new Set(['todo', 'working', 'done', 'failed']);
const PRIORITIES = new Set(['high', 'normal', 'low']);
const REPEATS = new Set(['', 'daily', 'weekdays', 'weekly', 'monthly']);

// Due dates are plain calendar days (YYYY-MM-DD) or empty.
function checkDue(due) {
  const d = String(due ?? '').trim();
  if (d && !(/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)))) throw new Error(`bad due date "${d}" (use YYYY-MM-DD)`);
  return d;
}

// Tags: "launch, Q4" -> ['launch', 'q4']. Short words, letters/digits/-/_ only, at most 10.
function checkTags(tags) {
  const list = (Array.isArray(tags) ? tags : String(tags ?? '').split(','))
    .map((t) => String(t).trim().toLowerCase().replace(/^#/, ''))
    .filter(Boolean);
  for (const t of list) if (!/^[a-z0-9][a-z0-9_-]{0,29}$/.test(t)) throw new Error(`bad tag "${t}": tags are single words of letters, digits, - or _`);
  const unique = [...new Set(list)];
  if (unique.length > 10) throw new Error('at most 10 tags per task');
  return unique;
}

// Optional per-task model, used instead of the agent's for that one task.
function checkModel(model) {
  const m = String(model ?? '').trim();
  if (m.length > 100) throw new Error('model name is too long');
  return m;
}

// Keeps the office (agents + tasks) in one JSON file. API keys are never stored here.
// backups: how many daily copies to keep in a backups/ folder next to the file (0 = off).
export function createStore(path, { backups = 7, today = () => new Date().toISOString().slice(0, 10) } = {}) {
  let state;
  try {
    state = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    state = { agents: structuredClone(DEFAULT_AGENTS), tasks: [] };
  }
  // A task still "working" when the office starts was cut off by a restart or crash;
  // nothing will ever finish it, so mark it failed (Retry all picks it up).
  for (const t of state.tasks) {
    if (t.status !== 'working') continue;
    t.status = 'failed';
    t.error = 'Interrupted: the office restarted while this task was running. Retry it.';
    t.finishedAt = new Date().toISOString();
  }

  // Before the first change of each day, copy the current file to
  // backups/office-YYYY-MM-DD.json and drop copies beyond the newest `backups`.
  function backup() {
    if (!backups || !existsSync(path)) return;
    const dir = join(dirname(path), 'backups');
    const target = join(dir, `office-${today()}.json`);
    if (existsSync(target)) return;
    mkdirSync(dir, { recursive: true });
    copyFileSync(path, target);
    const old = readdirSync(dir).filter((f) => /^office-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - backups))) rmSync(join(dir, f));
  }

  function save() {
    backup();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path); // write-then-rename so a crash never leaves half a file
  }

  const pick = (input) => {
    const out = Object.fromEntries(AGENT_FIELDS.filter((k) => k in input).map((k) => [k, String(input[k] ?? '').trim()]));
    // Prices are optional: US dollars per 1 million tokens, used only for cost estimates.
    // offDuty is stored as 'true' or '' so the agent file stays all strings.
    if ('offDuty' in out) out.offDuty = out.offDuty === 'true' ? 'true' : '';
    // maxTokens caps how long an answer can be (empty = the provider's default).
    if (out.maxTokens && !(/^\d+$/.test(out.maxTokens) && Number(out.maxTokens) >= 1 && Number(out.maxTokens) <= 128000)) {
      throw new Error('maxTokens must be a whole number from 1 to 128000');
    }
    // budget: US dollars; once the estimated spend reaches it, the agent's tasks don't start.
    if (out.budget && !(/^\d+(\.\d+)?$/.test(out.budget) && Number(out.budget) > 0)) throw new Error('budget must be a number of dollars');
    for (const k of ['priceIn', 'priceOut']) {
      if (out[k] && !(/^\d+(\.\d+)?$/.test(out[k]) && Number(out[k]) <= 10000)) throw new Error(`${k} must be a number of dollars per 1M tokens`);
    }
    return out;
  };
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

    // Copies an agent (same job, provider, model, prices and instructions) and
    // seats the copy right next to the original.
    cloneAgent(id) {
      const i = state.agents.findIndex((a) => a.id === id);
      if (i < 0) return null;
      const { id: _old, ...rest } = state.agents[i];
      const copy = { ...rest, id: randomUUID().slice(0, 8), name: `${rest.name} (copy)` };
      state.agents.splice(i + 1, 0, copy);
      save();
      return copy;
    },

    // Moves a desk one place left (-1) or right (+1) in the office.
    moveAgent(id, step) {
      const i = state.agents.findIndex((a) => a.id === id);
      if (i < 0) return null;
      const j = Math.max(0, Math.min(state.agents.length - 1, i + step));
      const [a] = state.agents.splice(i, 1);
      state.agents.splice(j, 0, a);
      save();
      return state.agents.map((x) => x.id);
    },

    removeAgent(id) {
      const before = state.agents.length;
      state.agents = state.agents.filter((a) => a.id !== id);
      save();
      return state.agents.length < before;
    },

    // Replaces the staff with an exported list. Tasks for removed agents stay
    // on the board, marked as "Removed agent" in the UI.
    importAgents(list) {
      if (!Array.isArray(list) || list.length === 0) throw new Error('expected a non-empty list of agents');
      const agents = list.map((input, i) => {
        if (!input?.name || !input?.role) throw new Error(`agent ${i + 1} needs a name and role`);
        const id = /^[\w-]{1,40}$/.test(input.id ?? '') ? input.id : randomUUID().slice(0, 8);
        return { id, emoji: '🤖', provider: 'demo', model: '', instructions: '', ...pick(input) };
      });
      if (new Set(agents.map((a) => a.id)).size !== agents.length) throw new Error('agent ids must be unique');
      state.agents = agents;
      save();
      return agents;
    },

    // Who the agents work for. Saved with the office; .env values are only defaults.
    company: () => state.company ?? {},
    setCompany(input) {
      const limits = { name: 100, about: 300, brief: 4000 };
      const next = { ...(state.company ?? {}) };
      for (const [k, max] of Object.entries(limits)) {
        if (!(k in input)) continue;
        const v = String(input[k] ?? '').trim();
        if (v.length > max) throw new Error(`${k} must be at most ${max} characters`);
        next[k] = v;
      }
      state.company = next;
      save();
      return next;
    },

    // The newest 100 events, newest first: tasks created, finished, failed, deleted.
    activity: () => state.activity ?? [],
    log(text) {
      state.activity = [{ at: new Date().toISOString(), text: String(text) }, ...(state.activity ?? [])].slice(0, 100);
      save();
    },

    tasks: () => state.tasks,
    task: (id) => state.tasks.find((t) => t.id === id),

    addTask({ title, details = '', agentId, priority = 'normal', due = '', repeat = '', model = '', tags = [], autoStart = '' }) {
      due = checkDue(due);
      autoStart = autoStart === true || autoStart === 'true' ? 'true' : '';
      if (autoStart && !due) throw new Error('pick a due date to start a task automatically');
      tags = checkTags(tags);
      model = checkModel(model);
      if (!REPEATS.has(repeat)) throw new Error(`bad repeat "${repeat}" (use daily, weekdays, weekly or monthly)`);
      if (!PRIORITIES.has(priority)) throw new Error(`bad priority "${priority}"`);
      if (!title) throw new Error('title is required');
      if (!agent(agentId)) throw new Error(`unknown agent "${agentId}"`);
      const t = {
        id: randomUUID().slice(0, 8),
        title: String(title),
        details: String(details),
        agentId,
        priority,
        due,
        repeat,
        model,
        tags,
        autoStart,
        status: 'todo',
        output: '',
        error: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.tasks.unshift(t);
      this.log(`New task for ${agent(agentId).name}: "${t.title}"`);
      return t;
    },

    // Adds token counts from one model call to the task's running total.
    addUsage(id, usage) {
      const t = state.tasks.find((x) => x.id === id);
      if (!t || !usage) return;
      t.usage = { input: (t.usage?.input ?? 0) + usage.input, output: (t.usage?.output ?? 0) + usage.output };
      save();
    },

    // Passes a finished task's result to another agent as a new task.
    handoff(id, { agentId, note = '' }) {
      const from = state.tasks.find((x) => x.id === id);
      if (!from) return null;
      if (from.status !== 'done') throw new Error('only finished tasks can be handed off');
      const fromAgent = agent(from.agentId);
      const details = [note && String(note).trim(), `Work from ${fromAgent?.name ?? 'a teammate'} (${fromAgent?.role ?? 'agent'}):\n\n${from.output}`]
        .filter(Boolean)
        .join('\n\n');
      return this.addTask({ title: from.title, details, agentId });
    },

    // The conversation for a task: the request, the agent's answer, then any follow-ups.
    setThread(id, thread) {
      const t = state.tasks.find((x) => x.id === id);
      if (!t) return null;
      t.thread = thread.map(({ role, content }) => ({ role: role === 'assistant' ? 'assistant' : 'user', content: String(content) }));
      save();
      return t;
    },

    updateTask(id, changes) {
      const t = state.tasks.find((x) => x.id === id);
      if (!t) return null;
      if (changes.status && !STATUSES.has(changes.status)) throw new Error(`bad status "${changes.status}"`);
      if ('due' in changes) changes = { ...changes, due: checkDue(changes.due) };
      if ('model' in changes) changes = { ...changes, model: checkModel(changes.model) };
      if ('tags' in changes) t.tags = checkTags(changes.tags);
      if ('rating' in changes && !['up', 'down', ''].includes(changes.rating)) throw new Error(`bad rating "${changes.rating}" (use up, down or empty)`);
      if ('autoStart' in changes) changes = { ...changes, autoStart: changes.autoStart === true || changes.autoStart === 'true' ? 'true' : '' };
      if ((changes.autoStart ?? t.autoStart) && !(changes.due ?? t.due)) throw new Error('pick a due date to start a task automatically');
      if ('repeat' in changes && !REPEATS.has(changes.repeat)) throw new Error(`bad repeat "${changes.repeat}" (use daily, weekdays, weekly or monthly)`);
      if ('agentId' in changes && !agent(changes.agentId)) throw new Error(`unknown agent "${changes.agentId}"`);
      if ('title' in changes && !String(changes.title).trim()) throw new Error('title is required');
      if (changes.priority && !PRIORITIES.has(changes.priority)) throw new Error(`bad priority "${changes.priority}"`);
      for (const k of ['status', 'priority', 'due', 'repeat', 'agentId', 'model', 'autoStart', 'rating', 'output', 'error', 'title', 'details', 'startedAt', 'finishedAt']) if (k in changes) t[k] = String(changes[k]);
      t.updatedAt = new Date().toISOString();
      save();
      return t;
    },

    // Per-agent counts and average run time for finished tasks.
    stats() {
      const out = {};
      for (const a of state.agents) out[a.id] = { done: 0, failed: 0, avgSeconds: null, tokensIn: 0, tokensOut: 0, cost: null, up: 0, down: 0 };
      const totals = {};
      for (const t of state.tasks) {
        const s = out[t.agentId];
        if (s && t.usage) {
          s.tokensIn += t.usage.input;
          s.tokensOut += t.usage.output;
        }
        if (s && t.rating === 'up') s.up++;
        if (s && t.rating === 'down') s.down++;
        if (!s || (t.status !== 'done' && t.status !== 'failed')) continue;
        s[t.status]++;
        if (t.status === 'done' && t.startedAt && t.finishedAt) {
          const secs = (Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 1000;
          (totals[t.agentId] ??= []).push(secs);
        }
      }
      for (const a of state.agents) {
        const s = out[a.id];
        if (a.priceIn || a.priceOut) s.cost = Math.round(((s.tokensIn * Number(a.priceIn || 0) + s.tokensOut * Number(a.priceOut || 0)) / 1e6) * 10000) / 10000;
      }
      for (const [id, list] of Object.entries(totals)) out[id].avgSeconds = Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10;
      return out;
    },

    // Deletes every finished task (optionally just one agent's) and says how many.
    clearDone(agentId) {
      const before = state.tasks.length;
      state.tasks = state.tasks.filter((t) => t.status !== 'done' || (agentId && t.agentId !== agentId));
      save();
      return before - state.tasks.length;
    },

    // When a repeating task is done, queue the next one (same request, next due date).
    scheduleNext(id) {
      const t = state.tasks.find((x) => x.id === id);
      if (!t || t.status !== 'done' || !t.repeat || t.nextCreated) return null;
      const base = t.due ? new Date(`${t.due}T00:00:00Z`) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
      if (t.repeat === 'monthly') {
        // Same day next month, or that month's last day (Jan 31 -> Feb 28).
        const day = base.getUTCDate();
        base.setUTCDate(1);
        base.setUTCMonth(base.getUTCMonth() + 1);
        const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
        base.setUTCDate(Math.min(day, last));
      } else {
        base.setUTCDate(base.getUTCDate() + (t.repeat === 'weekly' ? 7 : 1));
        // Weekdays skip Saturday and Sunday.
        while (t.repeat === 'weekdays' && [0, 6].includes(base.getUTCDay())) base.setUTCDate(base.getUTCDate() + 1);
      }
      t.nextCreated = true;
      return this.addTask({ title: t.title, details: t.details, agentId: t.agentId, priority: t.priority, repeat: t.repeat, model: t.model, tags: t.tags, autoStart: t.autoStart, due: base.toISOString().slice(0, 10) });
    },

    // Deleted tasks go to a small trash (the 20 most recent) so they can be undone.
    removeTask(id) {
      const t = state.tasks.find((x) => x.id === id);
      if (!t) return false;
      state.tasks = state.tasks.filter((x) => x.id !== id);
      state.trash = [t, ...(state.trash ?? [])].slice(0, 20);
      this.log(`Deleted "${t.title}"`);
      return true;
    },

    restoreTask(id) {
      const t = (state.trash ?? []).find((x) => x.id === id);
      if (!t) return null;
      state.trash = state.trash.filter((x) => x.id !== id);
      state.tasks.unshift(t);
      save();
      return t;
    },
  };
}
