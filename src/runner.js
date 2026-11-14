import { complete } from './providers.js';

// Turns an agent + task into a prompt, calls the agent's provider and
// records the result on the task.
export function buildPrompt(agent, task, company = {}) {
  const about = company.name ? ` at ${company.name}${company.about ? ` (${company.about})` : ''}` : '';
  const system = `You are ${agent.name}, the ${agent.role} agent${about}.\n\n${agent.instructions}`.trim();
  const prompt = task.details ? `${task.title}\n\n${task.details}` : task.title;
  return { system, prompt };
}

export function createRunner(store, { complete: call = complete, company = {}, notify = async () => {}, maxConcurrent = 3 } = {}) {
  const running = new Set();
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
    await new Promise((resolve) => waiting.push(resolve));
    waitingIds.delete(taskId);
  }
  function release() {
    const next = waiting.shift();
    if (next) next(); // hand the slot straight to the next task
    else active--;
  }

  return {
    isRunning: (taskId) => running.has(taskId),
    waitingIds: () => [...waitingIds],

    async run(taskId) {
      const task = store.task(taskId);
      if (!task) throw new Error('task not found');
      if (running.has(taskId)) throw new Error('task is already running');
      const agent = store.agent(task.agentId);
      if (!agent) throw new Error('the agent for this task was removed');
      if (agent.offDuty === 'true') throw new Error(`${agent.name} is off duty`);

      running.add(taskId);
      store.updateTask(taskId, { status: 'working', error: '', startedAt: new Date().toISOString(), finishedAt: '' });
      await slot(taskId);
      try {
        const { system, prompt } = buildPrompt(agent, task, company);
        const { text, usage } = await call({ provider: agent.provider, model: agent.model, system, prompt });
        store.addUsage(taskId, usage);
        store.setThread(taskId, [
          { role: 'user', content: prompt },
          { role: 'assistant', content: text },
        ]);
        return store.updateTask(taskId, { status: 'done', output: text, finishedAt: new Date().toISOString() });
      } catch (err) {
        return store.updateTask(taskId, { status: 'failed', error: err.message, finishedAt: new Date().toISOString() });
      } finally {
        release();
        running.delete(taskId);
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

      running.add(taskId);
      const history = task.thread;
      store.updateTask(taskId, { status: 'working', error: '', startedAt: new Date().toISOString(), finishedAt: '' });
      await slot(taskId);
      try {
        const { system } = buildPrompt(agent, task, company);
        const { text, usage } = await call({ provider: agent.provider, model: agent.model, system, prompt: message, history });
        store.addUsage(taskId, usage);
        store.setThread(taskId, [...history, { role: 'user', content: message }, { role: 'assistant', content: text }]);
        return store.updateTask(taskId, { status: 'done', output: text, finishedAt: new Date().toISOString() });
      } catch (err) {
        // Keep the earlier answer; just report that the follow-up failed.
        return store.updateTask(taskId, { status: 'done', error: `Follow-up failed: ${err.message}`, finishedAt: new Date().toISOString() });
      } finally {
        release();
        running.delete(taskId);
      }
    },
  };
}
