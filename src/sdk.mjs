export class Agent007Error extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'Agent007Error';
    this.status = status;
    this.body = body;
  }
}

function endpointId(id) {
  if (typeof id !== 'string' || !id.trim() || id === '.' || id === '..') {
    throw new TypeError('A agent007 resource ID is required.');
  }
  return encodeURIComponent(id);
}

function pause(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export function createClient(baseUrl = 'http://127.0.0.1:4387', options = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError('The agent007 base URL must be an HTTP or HTTPS URL without credentials, query, or fragment.');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (typeof fetcher !== 'function') throw new TypeError('The fetch option must be a function.');
  const defaultHeaders = new Headers(options.headers);

  async function request(path, { method = 'GET', body, signal } = {}) {
    const headers = new Headers(defaultHeaders);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetcher(new URL(path, base), {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof payload?.error === 'string' ? payload.error : `Agent007 returned HTTP ${response.status}.`;
      throw new Agent007Error(message, { status: response.status, body: payload });
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Agent007Error('Agent007 returned an invalid response.', { status: response.status, body: payload });
    }
    return payload;
  }

  async function getRun(id, { signal } = {}) {
    const result = await request(`api/runs/${endpointId(id)}`, { signal });
    return result.run;
  }

  return {
    async listWorkflows() {
      return (await request('api/workflows')).workflows;
    },
    async createWorkflow(workflow) {
      return (await request('api/workflows', { method: 'POST', body: workflow })).workflow;
    },
    async updateWorkflow(id, workflow) {
      return (await request(`api/workflows/${endpointId(id)}`, { method: 'PUT', body: workflow })).workflow;
    },
    async listRuns() {
      return (await request('api/runs')).runs;
    },
    getRun,
    async startRun({ workflowId, input = '', mode = 'preview' }) {
      return (await request('api/runs', { method: 'POST', body: { workflowId, input, mode } })).run;
    },
    async decideRun(id, { approve, note = '' }) {
      return (await request(`api/runs/${endpointId(id)}/decision`, { method: 'POST', body: { approve, note } })).run;
    },
    async listConnectors() {
      return (await request('api/connectors')).connectors;
    },
    async getMetrics() {
      return request('api/metrics');
    },
    async plan(goal, mode = 'preview') {
      return request('api/plans', { method: 'POST', body: { goal, mode } });
    },
    async waitForRun(id, { intervalMs = 400, timeoutMs = 30_000, signal } = {}) {
      if (![intervalMs, timeoutMs].every((value) => Number.isInteger(value) && value > 0 && value <= 2_147_483_647)) {
        throw new TypeError('Polling interval and timeout must be positive millisecond integers.');
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
      while (true) {
        deadline.throwIfAborted();
        const run = await getRun(id, { signal: deadline });
        if (run.status !== 'running') return run;
        await pause(intervalMs, deadline);
      }
    },
  };
}
