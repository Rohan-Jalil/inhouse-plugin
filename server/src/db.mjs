/**
 * SQLite storage for Claude Code session telemetry.
 *
 * One row per session in `sessions`, upserted on every report - a session that
 * reports 40 times over an hour stays one row, growing in place. Per-model
 * token splits live in `session_models` so cost stays accurate when a session
 * mixes models.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id            TEXT PRIMARY KEY,
  developer_name        TEXT NOT NULL DEFAULT '',
  developer_email       TEXT NOT NULL DEFAULT '',
  identity_source       TEXT NOT NULL DEFAULT '',
  machine_id            TEXT NOT NULL DEFAULT '',
  hostname              TEXT NOT NULL DEFAULT '',
  os_user               TEXT NOT NULL DEFAULT '',
  platform              TEXT NOT NULL DEFAULT '',
  cc_version            TEXT NOT NULL DEFAULT '',

  account_email         TEXT NOT NULL DEFAULT '',
  account_uuid          TEXT NOT NULL DEFAULT '',
  account_display_name  TEXT NOT NULL DEFAULT '',
  account_org           TEXT NOT NULL DEFAULT '',
  account_org_type      TEXT NOT NULL DEFAULT '',

  project_name          TEXT NOT NULL DEFAULT '',
  project_cwd           TEXT NOT NULL DEFAULT '',
  git_branch            TEXT NOT NULL DEFAULT '',

  started_at            TEXT NOT NULL DEFAULT '',
  last_activity_at      TEXT NOT NULL DEFAULT '',
  day                   TEXT NOT NULL DEFAULT '',   -- YYYY-MM-DD of started_at, local to the server
  duration_sec          INTEGER NOT NULL DEFAULT 0,

  headline              TEXT NOT NULL DEFAULT '',
  title                 TEXT NOT NULL DEFAULT '',
  first_prompt          TEXT NOT NULL DEFAULT '',
  last_assistant        TEXT NOT NULL DEFAULT '',

  turns                 INTEGER NOT NULL DEFAULT 0,
  user_messages         INTEGER NOT NULL DEFAULT 0,
  sidechain_requests    INTEGER NOT NULL DEFAULT 0,
  tool_calls            INTEGER NOT NULL DEFAULT 0,
  tools_json            TEXT NOT NULL DEFAULT '{}',
  files_json            TEXT NOT NULL DEFAULT '[]',

  requests              INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  thinking_tokens       INTEGER NOT NULL DEFAULT 0,
  total_tokens          INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL    NOT NULL DEFAULT 0,

  is_final              INTEGER NOT NULL DEFAULT 0,
  end_reason            TEXT NOT NULL DEFAULT '',
  report_count          INTEGER NOT NULL DEFAULT 0,
  first_seen_at         TEXT NOT NULL DEFAULT '',
  last_seen_at          TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_day    ON sessions(day);
CREATE INDEX IF NOT EXISTS idx_sessions_dev    ON sessions(developer_email, day);
CREATE INDEX IF NOT EXISTS idx_sessions_acct   ON sessions(account_email, day);
CREATE INDEX IF NOT EXISTS idx_sessions_seen   ON sessions(last_seen_at);

CREATE TABLE IF NOT EXISTS session_models (
  session_id            TEXT NOT NULL,
  model                 TEXT NOT NULL,
  requests              INTEGER NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  thinking_tokens       INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, model)
);

CREATE INDEX IF NOT EXISTS idx_models_model ON session_models(model);
`;

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

const UPSERT_SESSION = `
INSERT INTO sessions (
  session_id, developer_name, developer_email, identity_source, machine_id, hostname, os_user, platform, cc_version,
  account_email, account_uuid, account_display_name, account_org, account_org_type,
  project_name, project_cwd, git_branch,
  started_at, last_activity_at, day, duration_sec,
  headline, title, first_prompt, last_assistant,
  turns, user_messages, sidechain_requests, tool_calls, tools_json, files_json,
  requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
  thinking_tokens, total_tokens, cost_usd,
  is_final, end_reason, report_count, first_seen_at, last_seen_at
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, 1, ?, ?
)
ON CONFLICT(session_id) DO UPDATE SET
  developer_name        = excluded.developer_name,
  developer_email       = excluded.developer_email,
  identity_source       = excluded.identity_source,
  machine_id            = excluded.machine_id,
  hostname              = excluded.hostname,
  os_user               = excluded.os_user,
  platform              = excluded.platform,
  cc_version            = excluded.cc_version,
  account_email         = excluded.account_email,
  account_uuid          = excluded.account_uuid,
  account_display_name  = excluded.account_display_name,
  account_org           = excluded.account_org,
  account_org_type      = excluded.account_org_type,
  project_name          = excluded.project_name,
  project_cwd           = excluded.project_cwd,
  git_branch            = excluded.git_branch,
  last_activity_at      = excluded.last_activity_at,
  duration_sec          = excluded.duration_sec,
  -- Reports carry cumulative state, so later values supersede earlier ones.
  -- Guard against a late out-of-order report shrinking a session: keep the max.
  headline              = excluded.headline,
  title                 = CASE WHEN excluded.title != '' THEN excluded.title ELSE sessions.title END,
  first_prompt          = CASE WHEN sessions.first_prompt != '' THEN sessions.first_prompt ELSE excluded.first_prompt END,
  last_assistant        = excluded.last_assistant,
  turns                 = MAX(sessions.turns, excluded.turns),
  user_messages         = MAX(sessions.user_messages, excluded.user_messages),
  sidechain_requests    = MAX(sessions.sidechain_requests, excluded.sidechain_requests),
  tool_calls            = MAX(sessions.tool_calls, excluded.tool_calls),
  tools_json            = excluded.tools_json,
  files_json            = excluded.files_json,
  requests              = MAX(sessions.requests, excluded.requests),
  input_tokens          = MAX(sessions.input_tokens, excluded.input_tokens),
  output_tokens         = MAX(sessions.output_tokens, excluded.output_tokens),
  cache_creation_tokens = MAX(sessions.cache_creation_tokens, excluded.cache_creation_tokens),
  cache_read_tokens     = MAX(sessions.cache_read_tokens, excluded.cache_read_tokens),
  thinking_tokens       = MAX(sessions.thinking_tokens, excluded.thinking_tokens),
  total_tokens          = MAX(sessions.total_tokens, excluded.total_tokens),
  cost_usd              = MAX(sessions.cost_usd, excluded.cost_usd),
  is_final              = MAX(sessions.is_final, excluded.is_final),
  end_reason            = CASE WHEN excluded.end_reason != '' THEN excluded.end_reason ELSE sessions.end_reason END,
  report_count          = sessions.report_count + 1,
  last_seen_at          = excluded.last_seen_at
`;

const UPSERT_MODEL = `
INSERT INTO session_models (
  session_id, model, requests, input_tokens, output_tokens,
  cache_creation_tokens, cache_read_tokens, thinking_tokens, cost_usd
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, model) DO UPDATE SET
  requests              = MAX(session_models.requests, excluded.requests),
  input_tokens          = MAX(session_models.input_tokens, excluded.input_tokens),
  output_tokens         = MAX(session_models.output_tokens, excluded.output_tokens),
  cache_creation_tokens = MAX(session_models.cache_creation_tokens, excluded.cache_creation_tokens),
  cache_read_tokens     = MAX(session_models.cache_read_tokens, excluded.cache_read_tokens),
  thinking_tokens       = MAX(session_models.thinking_tokens, excluded.thinking_tokens),
  cost_usd              = MAX(session_models.cost_usd, excluded.cost_usd)
`;

export function makeStore(db) {
  const upsertSession = db.prepare(UPSERT_SESSION);
  const upsertModel = db.prepare(UPSERT_MODEL);

  return {
    save(row, models) {
      const tx = () => {
        upsertSession.run(
          row.session_id, row.developer_name, row.developer_email, row.identity_source, row.machine_id,
          row.hostname, row.os_user, row.platform, row.cc_version,
          row.account_email, row.account_uuid, row.account_display_name, row.account_org, row.account_org_type,
          row.project_name, row.project_cwd, row.git_branch,
          row.started_at, row.last_activity_at, row.day, row.duration_sec,
          row.headline, row.title, row.first_prompt, row.last_assistant,
          row.turns, row.user_messages, row.sidechain_requests, row.tool_calls, row.tools_json, row.files_json,
          row.requests, row.input_tokens, row.output_tokens, row.cache_creation_tokens, row.cache_read_tokens,
          row.thinking_tokens, row.total_tokens, row.cost_usd,
          row.is_final, row.end_reason, row.last_seen_at, row.last_seen_at,
        );
        for (const m of models) {
          upsertModel.run(
            row.session_id, m.model, m.requests, m.input_tokens, m.output_tokens,
            m.cache_creation_tokens, m.cache_read_tokens, m.thinking_tokens, m.cost_usd,
          );
        }
      };
      db.exec('BEGIN IMMEDIATE');
      try { tx(); db.exec('COMMIT'); }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
