import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_TEMPLATES } from './defaults.js';
import { createNotifier } from './notify.js';
import { providerStatus } from './providers.js';
import { buildPrompt, createRunner } from './runner.js';
import { createStore } from './store.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(root, 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createApp({ store, runner, env = process.env }) {
  // Wrong-password tracking per address: 10 misses within 15 minutes locks that
  // address out for 15 minutes, which makes guessing OFFICE_PASSWORD impractical.
  const misses = new Map();
  const LOCK_MS = 15 * 60_000;
  const MAX_MISSES = 10;
  // Saved profile wins; COMPANY_NAME / COMPANY_ABOUT in .env are the defaults.
  const company = () => companyFor(store, env);

  const routes = [
    ['GET', /^\/api\/office$/, () => ({ company: company(), providers: providerStatus(env), templates: AGENT_TEMPLATES, agents: store.agents(), stats: store.stats(), waiting: runner.waitingIds?.() ?? [], activity: store.activity().slice(0, 30), tasks: store.tasks() })],
    ['GET', /^\/api\/tasks\.csv$/, () => ({ raw: tasksCsv(store), type: 'text/csv; charset=utf-8', filename: 'agents-office-tasks.csv' })],
    ['PUT', /^\/api\/company$/, (_, body) => (store.setCompany(body), company())],
    ['GET', /^\/api\/export$/, () => ({ app: 'agents-office-os', version: 1, agents: store.agents() })],
    ['POST', /^\/api\/import$/, (_, body) => ({ agents: store.importAgents(body.agents) })],
    ['POST', /^\/api\/agents$/, (_, body) => [201, store.addAgent(body)]],
    ['PATCH', /^\/api\/agents\/([\w-]+)$/, ([id], body) => store.updateAgent(id, body)],
    ['POST', /^\/api\/agents\/([\w-]+)\/clone$/, ([id]) => {
      const copy = store.cloneAgent(id);
      return copy ? [201, copy] : null;
    }],
    [
      'POST',
      /^\/api\/agents\/([\w-]+)\/move$/,
      ([id], body) => {
        if (body.direction !== 'left' && body.direction !== 'right') throw new Error('direction must be left or right');
        const order = store.moveAgent(id, body.direction === 'left' ? -1 : 1);
        return order && { order };
      },
    ],
    ['DELETE', /^\/api\/agents\/([\w-]+)$/, ([id]) => (store.removeAgent(id) ? { ok: true } : null)],
    ['POST', /^\/api\/tasks$/, (_, body) => [201, store.addTask(body)]],
    ['PATCH', /^\/api\/tasks\/([\w-]+)$/, ([id], body) => store.updateTask(id, body)],
    [
      'POST',
      /^\/api\/tasks\/broadcast$/,
      (_, body) => {
        // The same request for several agents at once (default: everyone on duty).
        if (!String(body.title ?? '').trim()) throw new Error('title is required');
        const ids = Array.isArray(body.agentIds) && body.agentIds.length
          ? body.agentIds
          : store.agents().filter((a) => a.offDuty !== 'true').map((a) => a.id);
        const { agentIds: _ignored, run: _run, ...fields } = body;
        const tasks = ids.map((agentId) => store.addTask({ ...fields, agentId }));
        if (body.run) for (const t of tasks) runner.run(t.id).catch(() => {});
        return [201, { tasks }];
      },
    ],
    [
      'POST',
      /^\/api\/tasks\/(start-all|retry-failed)$/,
      ([which], body) => {
        // Starts every waiting task, or retries every failed one (optionally one
        // agent's), skipping off-duty agents.
        const status = which === 'start-all' ? 'todo' : 'failed';
        const waiting = store.tasks().filter((t) => t.status === status && (!body.agentId || t.agentId === body.agentId));
        let started = 0;
        let skipped = 0;
        for (const t of waiting) {
          if (store.agent(t.agentId)?.offDuty === 'true' || runner.isRunning(t.id)) {
            skipped++;
            continue;
          }
          runner.run(t.id).catch(() => {});
          started++;
        }
        return { started, skipped };
      },
    ],
    ['POST', /^\/api\/tasks\/clear-done$/, (_, body) => ({ removed: store.clearDone(body.agentId || undefined) })],
    [
      'GET',
      /^\/api\/tasks\/([\w-]+)\/prompt$/,
      ([id]) => {
        // What the agent would receive for this task, without calling any model.
        const task = store.task(id);
        const agent = task && store.agent(task.agentId);
        if (!agent) return null;
        return { provider: agent.provider, model: task.model || agent.model || '', ...buildPrompt(agent, task, company()) };
      },
    ],
    ['POST', /^\/api\/tasks\/([\w-]+)\/restore$/, ([id]) => store.restoreTask(id)],
    ['DELETE', /^\/api\/tasks\/([\w-]+)$/, ([id]) => (store.removeTask(id) ? { ok: true } : null)],
    [
      'POST',
      /^\/api\/tasks\/([\w-]+)\/run$/,
      ([id]) => {
        const task = store.task(id);
        if (!task) return null;
        const agent = store.agent(task.agentId);
        if (agent?.offDuty === 'true') throw new Error(`${agent.name} is off duty. Put them back on duty to start this task.`);
        runner.run(id).catch(() => {}); // runs in the background; the UI polls for the result
        return [202, store.task(id)];
      },
    ],
    [
      'POST',
      /^\/api\/tasks\/([\w-]+)\/handoff$/,
      ([id], body) => {
        const created = store.handoff(id, body);
        if (!created) return null;
        if (body.run) runner.run(created.id).catch(() => {});
        return [201, created];
      },
    ],
    [
      'POST',
      /^\/api\/tasks\/([\w-]+)\/reply$/,
      ([id], body) => {
        const t = store.task(id);
        if (!t) return null;
        if (!String(body.message ?? '').trim()) throw new Error('message is required');
        if (t.status !== 'done' || !t.thread?.length) throw new Error('you can reply once the task is done');
        runner.reply(id, body.message).catch(() => {});
        return [202, store.task(id)];
      },
    ],
  ];

  return async function handle(req, res) {
    // Health check for Docker and uptime monitors. Says nothing about the office,
    // so it's safe to leave outside the password.
    if (req.method === 'GET' && req.url === '/api/health') return send(res, 200, { ok: true });
    if (env.OFFICE_PASSWORD) {
      const ip = req.socket?.remoteAddress ?? '';
      const now = Date.now();
      const m = misses.get(ip);
      if (m && m.lockedUntil > now) {
        res.writeHead(429, { 'Retry-After': String(Math.ceil((m.lockedUntil - now) / 1000)) });
        return res.end('Too many wrong passwords. Try again later.');
      }
      if (!authorized(req, env.OFFICE_PASSWORD)) {
        // Browsers first ask without credentials; only count real wrong attempts.
        if (req.headers.authorization) {
          const rec = m && now - m.first < LOCK_MS ? m : { count: 0, first: now, lockedUntil: 0 };
          rec.count++;
          if (rec.count >= MAX_MISSES) rec.lockedUntil = now + LOCK_MS;
          misses.set(ip, rec);
        }
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Agents Office", charset="UTF-8"' });
        return res.end('Login required');
      }
      misses.delete(ip);
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const [method, pattern, fn] of routes) {
          const m = url.pathname.match(pattern);
          if (!m || req.method !== method) continue;
          const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readJson(req) : {};
          let result = await fn(m.slice(1), body);
          let status = 200;
          if (Array.isArray(result)) [status, result] = result;
          if (result === null) return send(res, 404, { error: 'not found' });
          if (result?.raw !== undefined) {
            res.writeHead(status, { 'Content-Type': result.type, 'Content-Disposition': `attachment; filename="${result.filename}"` });
            return res.end(result.raw);
          }
          return send(res, status, result);
        }
        return send(res, 404, { error: 'not found' });
      }
      return serveStatic(url.pathname, res);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  };
}

export function companyFor(store, env = process.env) {
  const saved = store.company();
  return {
    name: saved.name ?? env.COMPANY_NAME ?? '',
    about: saved.about ?? env.COMPANY_ABOUT ?? '',
    brief: saved.brief ?? '',
  };
}

// HTTP Basic auth: any username, the password must match OFFICE_PASSWORD.
function authorized(req, password) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(given);
  const b = Buffer.from(password);
  return a.length === b.length && timingSafeEqual(a, b);
}

// One row per task, for spreadsheets. Cells that start with = + - @ get a leading
// apostrophe so a spreadsheet never runs model output as a formula.
export function tasksCsv(store) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['title', 'agent', 'role', 'status', 'priority', 'due', 'created', 'finished', 'tokens', 'details', 'result', 'error'];
  const rows = store.tasks().map((t) => {
    const a = store.agent(t.agentId);
    return [t.title, a?.name ?? '', a?.role ?? '', t.status, t.priority ?? '', t.due ?? '', t.createdAt, t.finishedAt ?? '',
      (t.usage?.input ?? 0) + (t.usage?.output ?? 0), t.details, t.output, t.error];
  });
  return '\ufeff' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('request too large');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON');
  }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': `${TYPES[extname(file)] ?? 'application/octet-stream'}; charset=utf-8` });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

// BACKUP_PROVIDERS=openai,anthropic: ready providers to fall back to, in order.
export function backupProviders(env) {
  const ready = new Set(providerStatus(env).filter((p) => p.configured).map((p) => p.id));
  return String(env.BACKUP_PROVIDERS ?? '').split(',').map((s) => s.trim()).filter((id) => ready.has(id));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = createStore(process.env.OFFICE_DATA ?? join(root, 'data', 'office.json'), {
    backups: Number(process.env.OFFICE_BACKUPS ?? 7),
  });
  const runner = createRunner(store, {
    company: () => companyFor(store),
    notify: createNotifier(),
    maxConcurrent: Number(process.env.MAX_CONCURRENT_TASKS ?? 3),
    backups: backupProviders(process.env),
  });
  const port = Number(process.env.PORT ?? 3000);
  // Bind to localhost only: the office can spend your API credit, so it
  // shouldn't be reachable from your network unless you put auth in front.
  const host = process.env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.OFFICE_PASSWORD) {
    console.warn('Warning: the office is reachable from other machines without a password. Set OFFICE_PASSWORD.');
  }
  createServer(createApp({ store, runner })).listen(port, host, () => {
    console.log(`Agents Office OS is open at http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`);
  });
}
