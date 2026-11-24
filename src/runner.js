import { complete } from './providers.js';

// Turns an agent + task into a prompt, calls the agent's provider and
// records the result on the task.
export function buildPrompt(agent, task, company = {}) {
  const about = company.name ? ` at ${company.name}${company.about ? ` (${company.about})` : ''}` : '';
  const brief = company.brief ? `\n\nAbout the company:\n${company.brief}` : '';
  const system = `You are ${agent.name}, the ${agent.role} agent${about}.\n\n${agent.instructions}${brief}`.trim();
  const prompt = task.details ? `${task.title}\n\n${task.details}` : task.title;
  return { system, prompt };
}

export function createRunner(store, { complete: call = complete, company = {}, notify = async () => {}, maxConcurrent = 3, backups = [], timeoutMs = 0 } = {}) {
  const running = new Set();
  // If the agent's provider fails (down, rate-limited, out of credit), try
  // each backup provider in order with its default model.
  // timeoutMs > 0: a run that takes longer fails instead of holding a slot forever.
  function callWithBackups(req) {
    if (!timeoutMs) return tryProviders(req);
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
    });
    return Promise.race([tryProviders(req), limit]).finally(() => clearTimeout(timer));
  }
  async function tryProviders(req) {
    const order = [req.provider, ...backups.filter((b) => b !== req.provider)];
    const errors = [];
    for (const [i, provider] of order.entries()) {
      try {
        const res = await call(i === 0 ? req : { ...req, provider, model: '' });
        return { ...res, provider };
      } catch (err) {
        errors.push(i === 0 ? err.message : `${provider}: ${err.message}`);
      }
    }
    throw new Error(errors.join(' | backup '));
  }
  // At most `maxConcurrent` model calls at once (0 = no limit), so a burst of
  // tasks doesn't hit provider rate limits. Others wait for a free slot.
  const waiting = [];
  const waitingIds = new Set();
  let active = 0;
  async function slot(taskId) {
    if (!maxConcurrent || active < maxConcurrent) {
      active++;
      return;
    }
    waitingIds.add(taskId);
    await new Promise((resolve) => waiting.push({ taskId, resolve }));
    waitingIds.delete(taskId);
  }
  function release() {
    const next = waiting.shift();
    if (next) next.resolve(); // hand the slot straight to the next task
    else active--;
  }
  // Stop buttons: each running task's stop() rejects its run with "Stopped".
  const stoppers = new Map();
  // Waits for a slot and then does the work, unless the task is stopped first.
  // Resolves to the result; always gives the slot back (or leaves the queue).
  async function guarded(taskId, work) {
    let stop;
    const stopped = new Promise((_, reject) => (stop = () => reject(new Error('Stopped'))));
    stoppers.set(taskId, stop);
    try {
      await Promise.race([slot(taskId), stopped]);
      return await Promise.race([work(), stopped]);
    } finally {
      stoppers.delete(taskId);
      const i = waiting.findIndex((w) => w.taskId === taskId);
      if (i < 0) release(); // it held a slot
      else {
        waiting.splice(i, 1); // stopped while still in the queue
        waitingIds.delete(taskId);
      }
    }
  }

  // Once an agent's estimated spend reaches its budget, its tasks don't start.
  function overBudget(agent) {
    const spent = store.stats()[agent.id]?.cost;
    return agent.budget && spent !== null && spent >= Number(agent.budget) ? `${agent.name} has reached their $${agent.budget} budget` : '';
  }

  return {
    isRunning: (taskId) => running.has(taskId),
    // Stops a running (or waiting) task; it moves to failed with "Stopped".
    stop(taskId) {
      const stop = stoppers.get(taskId);
      if (!stop) return false;
      stop();
      return true;
    },
    waitingIds: () => [...waitingIds],

    async run(taskId) {
      const task = store.task(taskId);
      if (!task) throw new Error('task not found');
      if (running.has(taskId)) throw new Error('task is already running');
      const agent = store.agent(task.agentId);
      if (!agent) throw new Error('the agent for this task was removed');
      if (agent.offDuty === 'true') throw new Error(`${agent.name} is off duty`);
      const broke = overBudget(agent);
      if (broke) return store.updateTask(taskId, { status: 'failed', error: broke, finishedAt: new Date().toISOString() });

      running.add(taskId);
      store.updateTask(taskId, { status: 'working', error: '', startedAt: new Date().toISOString(), finishedAt: '' });
      try {
        const { system, prompt } = buildPrompt(agent, task, typeof company === 'function' ? company() : company);
        const { text, usage, provider } = await guarded(taskId, () => callWithBackups({ provider: agent.provider, model: task.model || agent.model, maxTokens: agent.maxTokens, system, prompt }));
        if (provider !== agent.provider) store.log(`${agent.name} used backup provider ${provider} for "${task.title}"`);
        store.addUsage(taskId, usage);
        store.setThread(taskId, [
          { role: 'user', content: prompt },
          { role: 'assistant', content: text },
        ]);
        return store.updateTask(taskId, { status: 'done', output: text, finishedAt: new Date().toISOString() });
      } catch (err) {
        return store.updateTask(taskId, { status: 'failed', error: err.message, finishedAt: new Date().toISOString() });
      } finally {
        running.delete(taskId);
        const done = store.task(taskId);
        if (done) store.log(done.status === 'done' ? `${agent.name} finished "${done.title}"` : `${agent.name} couldn't finish "${done.title}": ${done.error}`);
        store.scheduleNext(taskId);
        notify(store.task(taskId), agent).catch(() => {});
      }
    },

    // Sends a follow-up ("make it shorter") to the agent, keeping the conversation.
    async reply(taskId, message) {
      const task = store.task(taskId);
      if (!task) throw new Error('task not found');
      if (!String(message ?? '').trim()) throw new Error('message is required');
      if (task.status !== 'done' || !task.thread?.length) throw new Error('you can reply once the task is done');
      if (running.has(taskId)) throw new Error('task is already running');
      const agent = store.agent(task.agentId);
      if (!agent) throw new Error('the agent for this task was removed');
      const broke = overBudget(agent);
      if (broke) return store.updateTask(taskId, { error: `Follow-up failed: ${broke}` });

      running.add(taskId);
      const history = task.thread;
      store.updateTask(taskId, { status: 'working', error: '', startedAt: new Date().toISOString(), finishedAt: '' });
      try {
        const { system } = buildPrompt(agent, task, typeof company === 'function' ? company() : company);
        const { text, usage } = await guarded(taskId, () => callWithBackups({ provider: agent.provider, model: task.model || agent.model, maxTokens: agent.maxTokens, system, prompt: message, history }));
        store.addUsage(taskId, usage);
        store.setThread(taskId, [...history, { role: 'user', content: message }, { role: 'assistant', content: text }]);
        return store.updateTask(taskId, { status: 'done', output: text, finishedAt: new Date().toISOString() });
      } catch (err) {
        // Keep the earlier answer; just report that the follow-up failed.
        return store.updateTask(taskId, { status: 'done', error: `Follow-up failed: ${err.message}`, finishedAt: new Date().toISOString() });
      } finally {
        running.delete(taskId);
      }
    },
  };
}
