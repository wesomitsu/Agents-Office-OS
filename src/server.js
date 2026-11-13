import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_TEMPLATES } from './defaults.js';
import { createNotifier } from './notify.js';
import { providerStatus } from './providers.js';
import { createRunner } from './runner.js';
import { createStore } from './store.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(root, 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createApp({ store, runner, env = process.env }) {
  const company = { name: env.COMPANY_NAME ?? '', about: env.COMPANY_ABOUT ?? '' };

  const routes = [
    ['GET', /^\/api\/office$/, () => ({ company, providers: providerStatus(env), templates: AGENT_TEMPLATES, agents: store.agents(), stats: store.stats(), tasks: store.tasks() })],
    ['GET', /^\/api\/tasks\.csv$/, () => ({ raw: tasksCsv(store), type: 'text/csv; charset=utf-8', filename: 'agents-office-tasks.csv' })],
    ['GET', /^\/api\/export$/, () => ({ app: 'agents-office-os', version: 1, agents: store.agents() })],
    ['POST', /^\/api\/import$/, (_, body) => ({ agents: store.importAgents(body.agents) })],
    ['POST', /^\/api\/agents$/, (_, body) => [201, store.addAgent(body)]],
    ['PATCH', /^\/api\/agents\/([\w-]+)$/, ([id], body) => store.updateAgent(id, body)],
    ['DELETE', /^\/api\/agents\/([\w-]+)$/, ([id]) => (store.removeAgent(id) ? { ok: true } : null)],
    ['POST', /^\/api\/tasks$/, (_, body) => [201, store.addTask(body)]],
    ['PATCH', /^\/api\/tasks\/([\w-]+)$/, ([id], body) => store.updateTask(id, body)],
    [
      'POST',
      /^\/api\/tasks\/start-all$/,
      (_, body) => {
        // Starts every waiting task (optionally one agent's), skipping off-duty agents.
        const waiting = store.tasks().filter((t) => t.status === 'todo' && (!body.agentId || t.agentId === body.agentId));
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
    if (env.OFFICE_PASSWORD && !authorized(req, env.OFFICE_PASSWORD)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Agents Office", charset="UTF-8"' });
      return res.end('Login required');
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const [method, pattern, fn] of routes) {
          const m = url.pathname.match(pattern);
          if (!m || req.method !== method) continue;
          const body = ['POST', 'PATCH'].includes(method) ? await readJson(req) : {};
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = createStore(process.env.OFFICE_DATA ?? join(root, 'data', 'office.json'));
  const runner = createRunner(store, {
    company: { name: process.env.COMPANY_NAME, about: process.env.COMPANY_ABOUT },
    notify: createNotifier(),
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
