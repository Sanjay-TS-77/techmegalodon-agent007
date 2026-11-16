import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateWorkflow, createRun, advanceRun, resolveApproval } from './workflow.mjs';
import { openStore } from './store.mjs';
import { createProvider } from './providers.mjs';
import { createConnectors } from './connectors.mjs';
import { createPlan } from './planner.mjs';
import { openAccess } from './access.mjs';
import { openTriggers } from './triggers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/graph.js', ['graph.js', 'text/javascript; charset=utf-8']],
  ['/workspace.js', ['workspace.js', 'text/javascript; charset=utf-8']],
]);
const HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_ACTIVE_RUNS = 8;
const WEBHOOK_PATH = /^\/api\/webhooks\/([a-f0-9-]{36})$/;
const TRIGGER_PATH = /^\/api\/triggers\/([a-f0-9-]{36})(\/rotate)?$/;
const USER_PATH = /^\/api\/users\/([a-f0-9-]{36})$/;

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

function headers(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit = 1_048_576) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw requestError(415, 'Use application/json for this request.');
  }
  const chunks = [];
  let length = 0;
  for await (const part of request) {
    length += part.length;
    if (length > limit) {
      request.resume();
      throw requestError(413, `Request body exceeds ${limit} bytes.`);
    }
    chunks.push(part);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw requestError(400, 'The request body must be a JSON object.');
  }
}

function validateRequest(request, allowedHosts) {
  let authority;
  try {
    authority = new URL(`http://${request.headers.host ?? ''}`);
  } catch {
    throw requestError(400, 'The request needs a valid Host header.');
  }
  if (authority.pathname !== '/' || authority.username || authority.password || authority.search || authority.hash ||
      !allowedHosts.has(authority.hostname)) {
    throw requestError(403, 'This host is not configured for the console.');
  }
  const crossSite = request.headers['sec-fetch-site'] === 'cross-site';
  const origin = request.headers.origin;
  if (crossSite || (origin && origin !== authority.origin && origin !== `https://${authority.host}`)) {
    throw requestError(403, 'Cross-origin requests are disabled.');
  }
}

function inputError(action) {
  try { return action(); } catch (error) { throw requestError(error.status ?? 400, error.message); }
}

export function createApp({
  env = process.env,
  dataDir = env.AGENT007_DATA_DIR || resolve('.agent007'),
  transport = fetch,
  seed = true,
  now = Date.now,
  schedulePollMs = 10_000,
} = {}) {
  const allowedHosts = new Set([...HOSTS, ...(env.AGENT007_ALLOWED_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean)]);
  const bindHost = env.HOST || '127.0.0.1';
  const store = openStore(dataDir);
  const access = openAccess(dataDir, {
    required: env.AGENT007_AUTH !== 'disabled' || allowedHosts.size > HOSTS.size || !['127.0.0.1', 'localhost', '::1'].includes(bindHost),
    setupToken: env.AGENT007_SETUP_TOKEN,
    secureCookies: env.AGENT007_SECURE_COOKIES === undefined ? allowedHosts.size > HOSTS.size : env.AGENT007_SECURE_COOKIES === 'true',
    now,
  });
  const triggers = openTriggers(dataDir, { now });
  const provider = createProvider(env, transport);
  const { catalog, invokeConnector } = createConnectors({ transport });
  const connectorIds = new Set(catalog.map(({ id }) => id));
  const activeRuns = new Map();
  const authAttempts = new Map();
  let scheduleTimer;
  let closing = false;
  store.recoverInterrupted();

  function checkWorkflow(source) {
    return inputError(() => {
      const workflow = validateWorkflow(source);
      for (const step of workflow.steps) {
        if (step.type === 'connector' && !connectorIds.has(step.connector)) {
          throw new Error(`Connector ${step.connector} is not installed.`);
        }
      }
      return workflow;
    });
  }

  if (seed && store.countWorkflows() === 0) {
    const examples = readdirSync(join(root, 'examples')).filter(name => name.endsWith('.json')).sort();
    for (const name of examples) {
      const parsed = JSON.parse(readFileSync(join(root, 'examples', name), 'utf8'));
      store.saveWorkflow(checkWorkflow(parsed));
    }
  }

  function dispatch(run) {
    const work = Promise.resolve().then(async () => {
      try {
        await advanceRun(run, { invoke: provider.invoke, invokeConnector, onCheckpoint: store.saveRun });
      } catch (error) {
        // A storage failure can leave an incomplete checkpoint. Never replay an external call.
        console.error('A workflow checkpoint could not be saved:', error.code ?? error.name);
        const saved = store.getRun(run.id);
        if (saved?.status === 'running') {
          saved.status = 'failed';
          saved.error = 'Execution stopped because a checkpoint could not be saved.';
          saved.updatedAt = new Date().toISOString();
          saved.events.push({ type: 'run_failed', at: saved.updatedAt, message: saved.error });
          store.saveRun(saved);
        }
      }
    }).catch(() => console.error('The run could not be recovered.'))
      .finally(() => activeRuns.delete(run.id));
    activeRuns.set(run.id, work);
  }

  function checkRunTarget(workflowId, mode) {
    if (typeof workflowId !== 'string') throw requestError(400, 'Choose a workflow to run.');
    const workflow = store.getWorkflow(workflowId);
    if (!workflow) throw requestError(404, 'Workflow not found.');
    if (mode === 'live' && !provider.config.liveConfigured && workflow.steps.some(step => step.type === 'prompt')) {
      throw requestError(409, 'Configure a hosted model or choose preview mode.');
    }
    return workflow;
  }

  function startRun({ id = randomUUID(), workflowId, input, mode, source }) {
    const existing = store.getRun(id);
    if (existing) return existing;
    const workflow = checkRunTarget(workflowId, mode);
    if (activeRuns.size >= MAX_ACTIVE_RUNS) throw requestError(429, 'The server is already running eight workflows. Try again when one finishes.');
    const run = inputError(() => createRun({ id, workflow, input, mode }));
    run.workflowId = workflow.id;
    run.workflowRevision = workflow.revision;
    run.source = source;
    store.saveRun(run);
    dispatch(run);
    return run;
  }

  function sessionState(user) {
    return { enabled: access.enabled, setupRequired: access.setupRequired, setupAvailable: access.setupAvailable, user };
  }

  function requireWriter(request) {
    const user = access.authenticate(request.headers.cookie);
    if (access.enabled && !user) throw requestError(401, 'Sign in to access this workspace.');
    if (user?.role === 'viewer') throw requestError(403, 'The Viewer role has read-only access.');
    return user;
  }

  async function readMutation(request, limit) {
    const body = await readBody(request, limit);
    return { body, actor: requireWriter(request) };
  }

  function limitAuth(request) {
    const ip = request.socket.remoteAddress;
    const current = now();
    let attempt = authAttempts.get(ip);
    if (!attempt || attempt.until <= current) {
      for (const [address, entry] of authAttempts) {
        if (entry.until <= current) authAttempts.delete(address);
      }
      if (authAttempts.size >= 4_096) throw requestError(429, 'Too many sign-in attempts. Try again in a minute.');
      attempt = { until: current + 60_000, count: 0 };
      authAttempts.set(ip, attempt);
    }
    if (++attempt.count > 12) throw requestError(429, 'Too many sign-in attempts. Try again in a minute.');
    return attempt;
  }

  async function authRoute(request, response, action, user) {
    if (request.method === 'GET' && action === 'session') return send(response, 200, sessionState(user));
    if (request.method !== 'POST' || action === 'session') throw requestError(404, 'This route was not found.');
    if (action === 'logout') {
      await readBody(request, 16_384);
      response.setHeader('set-cookie', access.logout(request.headers.cookie));
      return send(response, 200, sessionState(null));
    }
    if (action === 'password' && !user) throw requestError(401, 'Sign in to change your password.');
    const attempt = limitAuth(request);
    const body = await readBody(request, 16_384);
    const current = action === 'password' ? access.authenticate(request.headers.cookie) : null;
    if (action === 'password' && !current) throw requestError(401, 'Sign in to change your password.');
    const result = current ? await access.changePassword(current.id, body) : await access[action](body);
    attempt.count--;
    response.setHeader('set-cookie', result.cookie);
    return send(response, 200, sessionState(result.user));
  }

  async function route(request, response) {
    headers(response);
    try {
      validateRequest(request, allowedHosts);
      if (closing) throw requestError(503, 'The server is shutting down.');
      const { pathname } = new URL(request.url, 'http://localhost');
      const { method } = request;

      if ((method === 'GET' || method === 'HEAD') && assets.has(pathname)) {
        const [file, contentType] = assets.get(pathname);
        const body = readFileSync(join(root, 'public', file));
        response.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
        response.end(method === 'HEAD' ? undefined : body);
        return;
      }

      if (method === 'GET' && pathname === '/api/health') return send(response, 200, { ok: true });

      const webhook = pathname.match(WEBHOOK_PATH);
      if (method === 'POST' && webhook) {
        const grant = triggers.authenticateWebhook(webhook[1], request.headers.authorization);
        const body = await readBody(request, 131_072);
        const keys = Object.keys(body);
        const input = keys.length === 1 && typeof body.input === 'string' ? body.input : keys.length ? JSON.stringify(body) : undefined;
        const delivery = triggers.deliverWebhook(grant, { input, idempotencyKey: request.headers['idempotency-key'] }, args => startRun(args).id);
        return send(response, delivery.duplicate ? 200 : 202, delivery);
      }

      const user = access.authenticate(request.headers.cookie);
      const auth = pathname.match(/^\/api\/auth\/(session|setup|login|logout|password)$/);
      if (auth) return await authRoute(request, response, auth[1], user);

      if (access.enabled && !user) throw requestError(401, 'Sign in to access this workspace.');
      if (user?.role === 'viewer' && method !== 'GET' && method !== 'HEAD') throw requestError(403, 'The Viewer role has read-only access.');

      if (pathname === '/api/users' || pathname.startsWith('/api/users/')) {
        if (user?.role !== 'admin') throw requestError(403, 'Only an administrator can manage users.');
        if (pathname === '/api/users' && method === 'GET') return send(response, 200, { users: access.listUsers() });
        if (pathname === '/api/users' && method === 'POST') {
          const { body, actor } = await readMutation(request, 16_384);
          if (actor?.role !== 'admin') throw requestError(403, 'Only an administrator can manage users.');
          return send(response, 201, { user: await access.createUser(body, actor.id) });
        }
        const userMatch = pathname.match(USER_PATH);
        if (userMatch && method === 'PATCH') {
          const { body, actor } = await readMutation(request, 16_384);
          if (actor?.role !== 'admin') throw requestError(403, 'Only an administrator can manage users.');
          return send(response, 200, { user: await access.updateUser(userMatch[1], body, actor.id) });
        }
      }

      if (pathname === '/api/triggers') {
        if (method === 'GET') return send(response, 200, { triggers: triggers.list() });
        if (method === 'POST') {
          const { body } = await readMutation(request, 131_072);
          checkRunTarget(body.workflowId, body.enabled === false ? undefined : body.mode);
          return send(response, 201, triggers.create(body));
        }
      }
      const triggerMatch = pathname.match(TRIGGER_PATH);
      if (triggerMatch) {
        const [, id, rotate] = triggerMatch;
        if (method === 'POST' && rotate) return send(response, 200, triggers.rotate(id));
        if (method === 'DELETE' && !rotate) {
          triggers.remove(id);
          return send(response, 200, { ok: true });
        }
        if (method === 'PATCH' && !rotate) {
          const { body } = await readMutation(request, 131_072);
          const previous = triggers.get(id);
          if (!previous) throw requestError(404, 'Trigger not found.');
          if (body.workflowId !== undefined || body.mode !== undefined || (body.enabled === true && !previous.enabled)) {
            const enabled = body.enabled ?? previous.enabled;
            checkRunTarget(body.workflowId ?? previous.workflowId, enabled ? body.mode ?? previous.mode : undefined);
          }
          return send(response, 200, { trigger: triggers.update(id, body) });
        }
      }

      if (method === 'GET' && pathname === '/api/config') return send(response, 200, provider.config);
      if (method === 'GET' && pathname === '/api/connectors') return send(response, 200, { connectors: catalog });
      if (method === 'GET' && pathname === '/api/metrics') return send(response, 200, store.metrics());
      if (method === 'GET' && pathname === '/api/workflows') return send(response, 200, { workflows: store.listWorkflows() });
      if (method === 'GET' && pathname === '/api/runs') return send(response, 200, { runs: store.listRuns() });
      if (method === 'POST' && pathname === '/api/plans') {
        const { body } = await readMutation(request);
        if (body.mode === 'live' && !provider.config.liveConfigured) throw requestError(409, 'Configure a hosted model before making a live plan.');
        let plan;
        try { plan = await createPlan(body, { invoke: provider.invoke }); }
        catch (error) { throw requestError(400, error.message); }
        return send(response, 200, plan);
      }
      if (method === 'POST' && pathname === '/api/workflows') {
        const { body } = await readMutation(request);
        const workflow = store.saveWorkflow(checkWorkflow(body));
        return send(response, 201, { workflow });
      }

      const workflowMatch = pathname.match(/^\/api\/workflows\/([a-f0-9-]{36})(\/versions)?$/);
      if (workflowMatch) {
        const [, id, versions] = workflowMatch;
        const current = store.getWorkflow(id);
        if (!current) throw requestError(404, 'Workflow not found.');
        if (method === 'GET') {
          return send(response, 200, versions ? { versions: store.listVersions(id) } : { workflow: current });
        }
        if (method === 'PUT' && !versions) {
          const { body } = await readMutation(request);
          if (body.revision !== undefined && (!Number.isInteger(body.revision) || body.revision < 1)) {
            throw requestError(400, 'A revision must be a positive integer.');
          }
          const workflow = store.saveWorkflow(checkWorkflow(body), id, body.revision);
          return send(response, 200, { workflow });
        }
      }

      if (method === 'POST' && pathname === '/api/runs') {
        const { body, actor } = await readMutation(request);
        const source = { type: 'manual', ...(actor && { userId: actor.id, username: actor.username }) };
        return send(response, 202, { run: startRun({ workflowId: body.workflowId, input: body.input, mode: body.mode, source }) });
      }

      const runMatch = pathname.match(/^\/api\/runs\/([a-f0-9-]{36})(\/decision)?$/);
      if (runMatch) {
        const [, id, decision] = runMatch;
        if (method === 'GET' && !decision) {
          const run = store.getRun(id);
          if (!run) throw requestError(404, 'Run not found.');
          return send(response, 200, { run });
        }
        if (method === 'POST' && decision) {
          const { body: action, actor } = await readMutation(request);
          const run = store.getRun(id);
          if (!run) throw requestError(404, 'Run not found.');
          if (run.status !== 'awaiting_approval' || activeRuns.has(id)) throw requestError(409, 'This run is no longer waiting for a decision.');
          if (action.approve === true && activeRuns.size >= MAX_ACTIVE_RUNS) throw requestError(429, 'Try again when a running workflow finishes.');
          inputError(() => resolveApproval(run, action, actor && { id: actor.id, username: actor.username }));
          store.saveRun(run);
          send(response, 200, { run });
          if (run.status === 'running') dispatch(run);
          return;
        }
      }
      throw requestError(404, 'This route was not found.');
    } catch (error) {
      if (!error.status) console.error('Server error:', error.code ?? error.name);
      if (!response.headersSent && !response.destroyed) {
        send(response, error.status ?? 500, { error: error.status ? error.message : 'An internal error occurred.' });
      }
    }
  }

  const server = createServer(route);
  function runScheduled() {
    try { triggers.runDue(args => startRun(args).id); }
    catch (error) { console.error('The scheduler could not check due triggers:', error.code ?? error.name); }
  }
  server.once('listening', () => {
    runScheduled();
    scheduleTimer = setInterval(runScheduled, schedulePollMs);
    scheduleTimer.unref();
  });
  async function close() {
    closing = true;
    clearInterval(scheduleTimer);
    if (server.listening) await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
    await Promise.allSettled(activeRuns.values());
    triggers.close();
    access.close();
    store.close();
  }
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp();
  const port = Number(process.env.PORT || 4387);
  const host = process.env.HOST || '127.0.0.1';
  app.server.listen(port, host, () => console.log(`Agent007 is listening on http://${host}:${app.server.address().port}`));
  const shutdown = () => app.close().catch(() => { process.exitCode = 1; });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
