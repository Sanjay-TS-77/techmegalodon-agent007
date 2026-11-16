import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openAccess } from '../src/access.mjs';

const setupToken = 'local-auth-test-initial-admin-token';
const password = 'test-only-long-password-one';
const newPassword = 'test-only-long-password-two';
const administrator = { setupToken, username: 'Founder', password };
const cookieHeader = cookie => cookie.split(';', 1)[0];

test('access mode fails closed until an operator configures the first administrator', async t => {
  const unconfigured = openAccess(':memory:', { required: true });
  const local = openAccess(':memory:');
  t.after(() => {
    unconfigured.close();
    local.close();
  });
  assert.equal(unconfigured.enabled, true);
  assert.equal(unconfigured.setupRequired, true);
  assert.equal(unconfigured.setupAvailable, false);
  await assert.rejects(unconfigured.setup(administrator), { status: 503 });
  assert.equal(local.enabled, false);
  assert.equal(local.setupRequired, false);
});

test('first-admin setup validates its token and allows only one administrator to claim it', async t => {
  const access = openAccess(':memory:', { setupToken });
  t.after(() => access.close());
  assert.equal(access.setupAvailable, true);
  await assert.rejects(access.setup({ ...administrator, setupToken: 'incorrect' }), { status: 403 });

  const attempts = await Promise.allSettled([
    access.setup(administrator),
    access.setup({ ...administrator, username: 'Second' }),
  ]);
  const successes = attempts.filter(attempt => attempt.status === 'fulfilled');
  const failures = attempts.filter(attempt => attempt.status === 'rejected');
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason.status, 409);
  const result = successes[0].value;
  assert.equal(result.user.role, 'admin');
  assert.deepEqual(access.authenticate(cookieHeader(result.cookie)), result.user);
  assert.equal(access.setupRequired, false);
  assert.equal(access.setupAvailable, false);
  assert.deepEqual(access.listUsers(), [result.user]);
});

test('users and opaque sessions survive restarts without exposing credentials', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent007-access-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = openAccess(directory, { setupToken, secureCookies: true });
  const account = await original.setup(administrator);
  original.close();

  const access = openAccess(directory, { secureCookies: true });
  const inspection = new DatabaseSync(join(directory, 'access.sqlite'), { readOnly: true });
  try {
    assert.equal(access.enabled, true);
    assert.equal(access.setupRequired, false);
    assert.match(account.cookie, /^__Host-agent007_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=604800$/);
    const cookie = cookieHeader(account.cookie);
    assert.deepEqual(access.authenticate(cookie), account.user);
    assert.equal(access.authenticate(`${cookie}; ${cookie}`), null);
    assert.deepEqual(Object.keys(account.user).sort(), ['createdAt', 'enabled', 'id', 'role', 'username']);
    const stored = inspection.prepare('SELECT salt, key FROM users').get();
    assert.equal(stored.salt.byteLength, 16);
    assert.equal(stored.key.byteLength, 64);
    assert.equal(Buffer.from(stored.key).includes(password), false);
    const storedSession = inspection.prepare('SELECT digest FROM sessions').get();
    assert.equal(storedSession.digest.byteLength, 32);
    assert.equal(Buffer.from(storedSession.digest).toString('base64url') === cookie.slice(cookie.indexOf('=') + 1), false);
    assert.match(access.logout(cookie), /Max-Age=0$/);
    assert.equal(access.authenticate(cookie), null);
    await assert.rejects(access.setup(administrator), { status: 409 });
    assert.equal((await access.login({ username: ' FOUNDER ', password })).user.username, 'founder');
  } finally {
    inspection.close();
    access.close();
  }
});

test('admin changes apply to active sessions and preserve the last enabled administrator', async t => {
  const access = openAccess(':memory:', { setupToken });
  t.after(() => access.close());
  const { user: admin } = await access.setup(administrator);
  const viewer = await access.createUser({ username: 'Reader', password, role: 'viewer' }, admin.id);
  const signIn = await access.login({ username: 'reader', password });
  const cookie = cookieHeader(signIn.cookie);
  await assert.rejects(access.createUser({ username: 'Another', password, role: 'admin' }, viewer.id), { status: 403 });
  await assert.rejects(access.updateUser(admin.id, { role: 'editor' }, admin.id), { status: 409 });
  await assert.rejects(access.updateUser(admin.id, { enabled: false }, admin.id), { status: 409 });
  await assert.rejects(access.createUser({ username: 'READER', password, role: 'editor' }, admin.id), { status: 409 });
  await access.updateUser(viewer.id, { role: 'editor' }, admin.id);
  assert.equal(access.authenticate(cookie).role, 'editor');
  await access.updateUser(viewer.id, { enabled: false }, admin.id);
  assert.equal(access.authenticate(cookie), null);
  const invalid = { status: 401, message: 'Username or password is incorrect.' };
  await assert.rejects(access.login({ username: 'reader', password }), invalid);
  await assert.rejects(access.login({ username: 'unknown', password }), invalid);
  await access.updateUser(viewer.id, { enabled: true, role: 'admin' }, admin.id);
  await access.updateUser(admin.id, { role: 'editor' }, viewer.id);
  assert.equal(access.listUsers().find(user => user.id === admin.id).role, 'editor');
});

test('changing a password rotates sessions and saved sessions expire', async t => {
  let timestamp = Date.UTC(2026, 0, 1);
  const access = openAccess(':memory:', { setupToken, now: () => timestamp });
  t.after(() => access.close());
  const account = await access.setup(administrator);
  const second = await access.login({ username: 'founder', password });
  await assert.rejects(access.changePassword(account.user.id, { currentPassword: newPassword, password: newPassword }), { status: 401 });
  const replacement = await access.changePassword(account.user.id, { currentPassword: password, password: newPassword });
  assert.equal(access.authenticate(cookieHeader(account.cookie)), null);
  assert.equal(access.authenticate(cookieHeader(second.cookie)), null);
  assert.deepEqual(access.authenticate(cookieHeader(replacement.cookie)), account.user);
  await assert.rejects(access.login({ username: 'founder', password }), { status: 401 });
  assert.deepEqual((await access.login({ username: 'founder', password: newPassword })).user, account.user);
  timestamp += 7 * 24 * 60 * 60 * 1000;
  assert.equal(access.authenticate(cookieHeader(replacement.cookie)), null);
});
