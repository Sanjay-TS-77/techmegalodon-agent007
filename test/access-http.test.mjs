import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createApp } from '../src/server.mjs';

const setupToken = 'test-only-studio-initial-account-token';
const accountPassword = 'test-only-studio-password';
const administrator = { username: 'founder', password: accountPassword };
const editor = { username: 'operations', password: accountPassword, role: 'editor' };
const viewer = { username: 'observer', password: accountPassword, role: 'viewer' };
const fixture = {
  name: 'Warehouse handoff',
  steps: [
    { id: 'prepare', name: 'Prepare', type: 'template', template: '{{input}}' },
    { id: 'review', name: 'Review', type: 'approval', template: '{{steps.prepare}}' },
  ],
};

async function serverFixture(t, options = {}) {
  const { server, close } = createApp({ env: {}, seed: false, dataDir: ':memory:', ...options });
  t.after(close);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return async (pathname, { method = 'GET', body, cookie, origin } = {}) => {
    const response = await fetch(url + pathname, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(cookie && { cookie }),
        ...(origin && { origin }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4_000),
    });
    const setCookie = response.headers.get('set-cookie');
    return { status: response.status, body: await response.json(), setCookie, cookie: setCookie?.split(';', 1)[0] };
  };
}

function post(call, pathname, body, cookie) {
  return call(pathname, { method: 'POST', body, cookie });
}

async function configureAdministrator(call) {
  const result = await post(call, '/api/auth/setup', { ...administrator, setupToken });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.role, 'admin');
  assert.equal(result.body.setupRequired, false);
  assert.match(result.setCookie, /Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/);
  return result;
}

async function waitForRun(call, pathname, cookie, state) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const result = await call(pathname, { cookie });
    assert.equal(result.status, 200);
    if (result.body.run.status === state) return result.body.run;
    if (result.body.run.status === 'failed') assert.fail(result.body.run.error);
    await pause(20);
  }
  assert.fail(`The run did not reach ${state}.`);
}

test('HTTP workspace routes are private until first-admin setup is configured', async t => {
  const call = await serverFixture(t);
  assert.deepEqual((await call('/api/health')).body, { ok: true });
  const session = await call('/api/auth/session');
  assert.equal(session.status, 200);
  assert.deepEqual(session.body, { enabled: true, setupRequired: true, setupAvailable: false, user: null });
  for (const route of ['/api/config', '/api/workflows', '/api/runs', '/api/metrics', '/api/connectors', '/api/triggers', '/api/users']) {
    assert.equal((await call(route)).status, 401, route);
  }
  assert.equal((await post(call, '/api/workflows', fixture)).status, 401);
  assert.equal((await post(call, '/api/auth/setup', { ...administrator, setupToken })).status, 503);
});

test('public workspace hostnames keep authentication and secure cookies enabled', async t => {
  const call = await serverFixture(t, {
    env: { AGENT007_AUTH: 'disabled', AGENT007_ALLOWED_HOSTS: 'studio.example.invalid', AGENT007_SETUP_TOKEN: setupToken },
  });
  assert.equal((await call('/api/workflows')).status, 401);
  const setup = await post(call, '/api/auth/setup', { ...administrator, setupToken });
  assert.equal(setup.status, 200);
  assert.match(setup.setCookie, /^__Host-agent007_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure;/);
});

test('HTTP roles protect workflows and attribute runs and approval decisions', async t => {
  const call = await serverFixture(t, { env: { AGENT007_SETUP_TOKEN: setupToken } });
  const existing = await call('/api/auth/session');
  assert.equal(existing.body.setupAvailable, true);
  assert.equal((await post(call, '/api/auth/setup', { ...administrator, setupToken: 'invalid' })).status, 403);
  const adminSession = await configureAdministrator(call);
  assert.equal((await post(call, '/api/auth/setup', { ...administrator, setupToken })).status, 409);
  assert.equal((await post(call, '/api/users', editor, adminSession.cookie)).status, 201);
  assert.equal((await post(call, '/api/users', viewer, adminSession.cookie)).status, 201);
  const editorSession = await post(call, '/api/auth/login', editor);
  const viewerSession = await post(call, '/api/auth/login', viewer);
  assert.equal(editorSession.status, 200);
  assert.equal(viewerSession.status, 200);
  assert.equal(viewerSession.body.user.role, 'viewer');
  assert.equal((await call('/api/workflows', { cookie: viewerSession.cookie })).status, 200);
  assert.equal((await post(call, '/api/workflows', fixture, viewerSession.cookie)).status, 403);
  assert.equal((await post(call, '/api/triggers', {}, viewerSession.cookie)).status, 403);
  assert.equal((await call('/api/users', { cookie: viewerSession.cookie })).status, 403);
  assert.equal((await call('/api/users', { cookie: editorSession.cookie })).status, 403);
  assert.equal((await post(call, '/api/users', viewer, editorSession.cookie)).status, 403);

  const inventory = await call('/api/users', { cookie: adminSession.cookie });
  assert.equal(inventory.status, 200);
  assert.deepEqual(inventory.body.users.map(({ role }) => role), ['admin', 'viewer', 'editor']);
  for (const account of inventory.body.users) {
    assert.deepEqual(Object.keys(account).sort(), ['createdAt', 'enabled', 'id', 'role', 'username']);
  }

  const created = await post(call, '/api/workflows', fixture, editorSession.cookie);
  assert.equal(created.status, 201);
  const runBody = { workflowId: created.body.workflow.id, input: 'Shipment labels', mode: 'preview' };
  assert.equal((await post(call, '/api/runs', runBody, viewerSession.cookie)).status, 403);
  const started = await post(call, '/api/runs', runBody, editorSession.cookie);
  assert.equal(started.status, 202);
  const { id: userId, username } = editorSession.body.user;
  assert.deepEqual(started.body.run.source, { type: 'manual', userId, username });
  const runPath = `/api/runs/${started.body.run.id}`;
  const pending = await waitForRun(call, runPath, viewerSession.cookie, 'awaiting_approval');
  assert.equal(pending.pendingApproval.message, 'Shipment labels');
  const action = { approve: true, note: 'Reviewed' };
  assert.equal((await post(call, `${runPath}/decision`, action, viewerSession.cookie)).status, 403);
  assert.equal((await post(call, `${runPath}/decision`, action, adminSession.cookie)).status, 200);
  const complete = await waitForRun(call, runPath, editorSession.cookie, 'succeeded');
  assert.deepEqual(complete.events.find(event => event.type === 'approval_granted').actor, {
    id: adminSession.body.user.id,
    username: adminSession.body.user.username,
  });
  const viewerPath = `/api/users/${viewerSession.body.user.id}`;
  const promoted = await call(viewerPath, { method: 'PATCH', body: { role: 'editor' }, cookie: adminSession.cookie });
  assert.equal(promoted.status, 200);
  assert.equal((await call('/api/auth/session', { cookie: viewerSession.cookie })).body.user.role, 'editor');
  const disabled = await call(viewerPath, { method: 'PATCH', body: { enabled: false }, cookie: adminSession.cookie });
  assert.equal(disabled.status, 200);
  assert.equal((await call('/api/workflows', { cookie: viewerSession.cookie })).status, 401);
});

test('HTTP password changes replace sessions and logout revokes the current session', async t => {
  const call = await serverFixture(t, { env: { AGENT007_SETUP_TOKEN: setupToken } });
  const adminSession = await configureAdministrator(call);
  const second = await post(call, '/api/auth/login', administrator);
  assert.equal(second.status, 200);
  const newPassword = 'test-only-updated-studio-password';
  const credentials = { currentPassword: accountPassword, password: newPassword };
  const foreign = await call('/api/auth/password', {
    method: 'POST', body: credentials, origin: 'https://different-site.invalid', cookie: adminSession.cookie,
  });
  assert.equal(foreign.status, 403);
  assert.equal((await post(call, '/api/auth/password', credentials)).status, 401);
  const changed = await post(call, '/api/auth/password', credentials, adminSession.cookie);
  assert.equal(changed.status, 200);
  assert.notEqual(changed.cookie, adminSession.cookie);
  assert.equal((await call('/api/config', { cookie: adminSession.cookie })).status, 401);
  assert.equal((await call('/api/config', { cookie: second.cookie })).status, 401);
  assert.equal((await post(call, '/api/auth/login', administrator)).status, 401);
  const loggedIn = await post(call, '/api/auth/login', { username: administrator.username, password: newPassword });
  assert.equal(loggedIn.status, 200);
  const cleared = await post(call, '/api/auth/logout', {}, loggedIn.cookie);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.user, null);
  assert.match(cleared.setCookie, /Max-Age=0$/);
  assert.equal((await call('/api/config', { cookie: loggedIn.cookie })).status, 401);
  assert.equal((await call('/api/config', { cookie: changed.cookie })).status, 200);
});
