import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function document(row) {
  return row && JSON.parse(row.document);
}

export function openStore(directory) {
  if (directory !== ':memory:') mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(directory === ':memory:' ? directory : join(directory, 'studio.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      document TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT NOT NULL REFERENCES workflows(id),
      revision INTEGER NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY (id, revision)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      document TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_by_recent_update ON runs(updated_at DESC);
  `);

  const readWorkflow = database.prepare('SELECT document FROM workflows WHERE id = ?');
  const insertWorkflow = database.prepare('INSERT INTO workflows VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at, document = excluded.document');
  const insertVersion = database.prepare('INSERT INTO workflow_versions VALUES (?, ?, ?)');
  const readRun = database.prepare('SELECT document FROM runs WHERE id = ?');
  const persistRun = database.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status, mode = excluded.mode, updated_at = excluded.updated_at, document = excluded.document');

  const api = {
    close: () => database.close(),
    countWorkflows: () => database.prepare('SELECT count(*) AS count FROM workflows').get().count,
    listWorkflows: () => database.prepare('SELECT document FROM workflows ORDER BY updated_at DESC, id').all().map(document),
    getWorkflow: id => document(readWorkflow.get(id)),
    saveWorkflow(workflow, id = randomUUID(), expectedRevision) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const before = api.getWorkflow(id);
        if (expectedRevision !== undefined && before?.revision !== expectedRevision) {
          const error = new Error('This workflow changed. Reload the latest version before saving.');
          error.status = 409;
          throw error;
        }
        const updatedAt = new Date().toISOString();
        const revision = (before?.revision ?? 0) + 1;
        const record = { ...workflow, id, updatedAt, revision };
        const json = JSON.stringify(record);
        insertWorkflow.run(id, revision, updatedAt, json);
        insertVersion.run(id, revision, json);
        database.exec('COMMIT');
        return record;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    listVersions: id => database.prepare('SELECT document FROM workflow_versions WHERE id = ? ORDER BY revision DESC').all(id).map(document),
    getRun: id => document(readRun.get(id)),
    listRuns() {
      return database.prepare(`
        SELECT id, status, mode,
          json_extract(document, '$.workflow.name') AS workflowName,
          json_extract(document, '$.createdAt') AS createdAt,
          json_extract(document, '$.source') AS source,
          updated_at AS updatedAt
        FROM runs ORDER BY updated_at DESC, id LIMIT 200
      `).all().map(({ source, ...run }) => ({ ...run, ...(source && { source: JSON.parse(source) }) }));
    },
    saveRun(run) {
      persistRun.run(run.id, run.status, run.mode, run.updatedAt, JSON.stringify(run));
    },
    recoverInterrupted() {
      const running = database.prepare("SELECT document FROM runs WHERE status = 'running'").all().map(document);
      for (const run of running) {
        run.status = 'failed';
        run.error = 'The server stopped before this run completed.';
        run.updatedAt = new Date().toISOString();
        run.events.push({ type: 'run_failed', at: run.updatedAt, message: run.error });
        api.saveRun(run);
      }
    },
    metrics() {
      const grouped = field => Object.fromEntries(database.prepare(`SELECT ${field} AS key, count(*) AS count FROM runs GROUP BY ${field}`).all().map(row => [row.key, row.count]));
      const byStatus = grouped('status');
      const byMode = grouped('mode');
      const runs = Object.values(byStatus).reduce((a, b) => a + b, 0);
      const successes = byStatus.succeeded ?? 0;
      const terminal = successes + (byStatus.failed ?? 0) + (byStatus.rejected ?? 0);
      const usage = database.prepare(`
        SELECT coalesce(sum(json_extract(events.value, '$.usage.inputTokens')), 0) AS inputTokens,
          coalesce(sum(json_extract(events.value, '$.usage.outputTokens')), 0) AS outputTokens
        FROM runs, json_each(runs.document, '$.events') AS events
      `).get();
      return { runs, totalTokens: usage.inputTokens + usage.outputTokens, ...usage,
        successRate: terminal ? successes / terminal : null, awaitingApproval: byStatus.awaiting_approval ?? 0, byStatus, byMode };
    },
  };
  return api;
}
