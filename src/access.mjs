import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const keyLength = 64;
const dummySalt = Buffer.alloc(16);
const dummyKey = Buffer.alloc(keyLength);
const roles = new Set(['admin', 'editor', 'viewer']);
const sessionSeconds = 60 * 60 * 24 * 7;

function accessError(status, message) {
  return Object.assign(new Error(message), { status });
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function parseUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(username)) {
    throw accessError(400, 'Use a 3–64 character username with letters, numbers, or . _ @ + -');
  }
  return username;
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value) <= 512;
}

function checkPassword(value) {
  if (!validPassword(value)) throw accessError(400, 'Use a password of at least 12 characters and at most 512 UTF-8 bytes.');
}

function checkRole(role) {
  if (!roles.has(role)) throw accessError(400, 'Choose an admin, editor, or viewer role.');
}

function publicUser(row) {
  if (!row) return null;
  const { id, username, role, enabled, created_at: createdAt } = row;
  return { id, username, role, enabled: Boolean(enabled), createdAt };
}

export function openAccess(directory, { required = false, setupToken, secureCookies = false, now = Date.now } = {}) {
  if (setupToken !== undefined && setupToken !== '' &&
      (typeof setupToken !== 'string' || setupToken.length < 32 || setupToken.length > 1024)) {
    throw new Error('AGENT007_SETUP_TOKEN must be 32–1024 characters.');
  }
  const setupDigest = setupToken ? digest(setupToken) : null;
  if (directory !== ':memory:') mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(directory === ':memory:' ? directory : join(directory, 'access.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      salt BLOB NOT NULL,
      key BLOB NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      digest BLOB PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);
  `);

  const anyUsers = database.prepare('SELECT EXISTS(SELECT 1 FROM users) AS found');
  const byId = database.prepare('SELECT * FROM users WHERE id = ?');
  const byUsername = database.prepare('SELECT * FROM users WHERE username = ?');
  const listUsers = database.prepare('SELECT id, username, role, enabled, created_at FROM users ORDER BY username');
  const insertUser = database.prepare('INSERT INTO users VALUES (?, ?, ?, 1, ?, ?, ?)');
  const updateUser = database.prepare('UPDATE users SET role = ?, enabled = ?, salt = ?, key = ? WHERE id = ?');
  const otherEnabledAdmins = database.prepare("SELECT EXISTS(SELECT 1 FROM users WHERE id != ? AND enabled = 1 AND role = 'admin') AS found");
  const insertSession = database.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  const readSession = database.prepare(`
    SELECT users.id, users.username, users.role, users.enabled, users.created_at
    FROM sessions JOIN users ON sessions.user_id = users.id
    WHERE sessions.digest = ? AND sessions.expires_at > ? AND users.enabled = 1
  `);
  const expireSessions = database.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const revokeSession = database.prepare('DELETE FROM sessions WHERE digest = ?');
  const revokeUserSessions = database.prepare('DELETE FROM sessions WHERE user_id = ?');
  const cookieName = secureCookies ? '__Host-agent007_session' : 'agent007_session';
  const cookieAttributes = `Path=/; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}`;
  let activeDerivations = 0;

  function hasUsers() {
    return Boolean(anyUsers.get().found);
  }

  function readCookie(cookieHeader) {
    if (typeof cookieHeader !== 'string') return null;
    const prefix = `${cookieName}=`;
    const matches = cookieHeader.split(';').map(part => part.trim()).filter(part => part.startsWith(prefix));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(prefix.length);
    return /^[a-zA-Z0-9_-]{43}$/.test(token) ? digest(token) : null;
  }

  function transaction(action) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  async function derive(password, salt) {
    if (activeDerivations >= 4) throw accessError(429, 'Password verification is busy. Try again shortly.');
    activeDerivations++;
    try {
      return await deriveKey(password, salt, keyLength, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    } finally {
      activeDerivations--;
    }
  }

  async function hashPassword(password) {
    checkPassword(password);
    const salt = randomBytes(16);
    return { salt, key: await derive(password, salt) };
  }

  function sameKey(before, after) {
    return Boolean(before && after && timingSafeEqual(before.key, after.key));
  }

  function mustBeAdmin(actorId) {
    const actor = typeof actorId === 'string' && byId.get(actorId);
    if (!actor?.enabled || actor.role !== 'admin') throw accessError(403, 'Administrator access is required.');
  }

  function addUser(username, role, { salt, key }) {
    if (byUsername.get(username)) throw accessError(409, 'That username is already in use.');
    const id = randomUUID();
    insertUser.run(id, username, role, salt, key, new Date(now()).toISOString());
    return byId.get(id);
  }

  function startSession(user) {
    const token = randomBytes(32).toString('base64url');
    const timestamp = now();
    expireSessions.run(timestamp);
    insertSession.run(digest(token), user.id, timestamp + sessionSeconds * 1000);
    return { user: publicUser(user), cookie: `${cookieName}=${token}; ${cookieAttributes}; Max-Age=${sessionSeconds}` };
  }

  return {
    get enabled() { return required || Boolean(setupDigest) || hasUsers(); },
    get setupRequired() { return (required || Boolean(setupDigest)) && !hasUsers(); },
    get setupAvailable() { return Boolean(setupDigest) && !hasUsers(); },
    async setup({ setupToken: supplied, username, password }) {
      if (hasUsers()) throw accessError(409, 'The initial administrator is already configured.');
      if (!setupDigest) throw accessError(503, 'The operator needs to configure an initial setup token.');
      if (typeof supplied !== 'string' || supplied.length > 1024 || !timingSafeEqual(setupDigest, digest(supplied))) {
        throw accessError(403, 'The setup token is incorrect.');
      }
      const name = parseUsername(username);
      const credentials = await hashPassword(password);
      return transaction(() => {
        if (hasUsers()) throw accessError(409, 'The initial administrator is already configured.');
        return startSession(addUser(name, 'admin', credentials));
      });
    },
    async login({ username, password }) {
      const invalid = () => accessError(401, 'Username or password is incorrect.');
      let name;
      try { name = parseUsername(username); } catch { throw invalid(); }
      if (!validPassword(password)) throw invalid();
      const user = byUsername.get(name);
      const candidate = await derive(password, user?.salt ?? dummySalt);
      if (!timingSafeEqual(candidate, user?.key ?? dummyKey) || !user?.enabled) throw invalid();
      return transaction(() => {
        const current = byId.get(user.id);
        if (!current?.enabled || !sameKey(user, current)) throw invalid();
        return startSession(current);
      });
    },
    authenticate(cookieHeader) {
      const token = readCookie(cookieHeader);
      return token && publicUser(readSession.get(token, now()));
    },
    logout(cookieHeader) {
      const token = readCookie(cookieHeader);
      if (token) revokeSession.run(token);
      return `${cookieName}=; ${cookieAttributes}; Max-Age=0`;
    },
    listUsers: () => listUsers.all().map(publicUser),
    async createUser({ username, password, role }, actorId) {
      mustBeAdmin(actorId);
      const name = parseUsername(username);
      checkRole(role);
      const credentials = await hashPassword(password);
      return transaction(() => {
        mustBeAdmin(actorId);
        return publicUser(addUser(name, role, credentials));
      });
    },
    async updateUser(id, { role, enabled, password }, actorId) {
      mustBeAdmin(actorId);
      if (role === undefined && enabled === undefined && password === undefined) throw accessError(400, 'Provide an account change.');
      if (role !== undefined) checkRole(role);
      if (enabled !== undefined && typeof enabled !== 'boolean') throw accessError(400, 'Account status must be enabled or disabled.');
      const credentials = password === undefined ? null : await hashPassword(password);
      return transaction(() => {
        mustBeAdmin(actorId);
        const before = byId.get(id);
        if (!before) throw accessError(404, 'User not found.');
        const nextRole = role ?? before.role;
        const nextEnabled = enabled ?? Boolean(before.enabled);
        if (before.enabled && before.role === 'admin' && (!nextEnabled || nextRole !== 'admin') && !otherEnabledAdmins.get(id).found) {
          throw accessError(409, 'At least one enabled administrator is required.');
        }
        updateUser.run(nextRole, Number(nextEnabled), credentials?.salt ?? before.salt, credentials?.key ?? before.key, id);
        if (credentials || !nextEnabled) revokeUserSessions.run(id);
        return publicUser(byId.get(id));
      });
    },
    async changePassword(id, { currentPassword, password }) {
      if (!validPassword(currentPassword)) throw accessError(401, 'The current password is incorrect.');
      const before = byId.get(id);
      if (!before?.enabled || !timingSafeEqual(await derive(currentPassword, before.salt), before.key)) {
        throw accessError(401, 'The current password is incorrect.');
      }
      const credentials = await hashPassword(password);
      return transaction(() => {
        const current = byId.get(id);
        if (!current?.enabled || !sameKey(before, current)) throw accessError(409, 'Account credentials changed while saving. Sign in again.');
        updateUser.run(current.role, current.enabled, credentials.salt, credentials.key, id);
        revokeUserSessions.run(id);
        return startSession(byId.get(id));
      });
    },
    close: () => database.close(),
  };
}
