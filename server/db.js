const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const useSsl = !/localhost|127\.0\.0\.1|host=\/|@\/|sslmode=disable/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 8,
  idleTimeoutMillis: 30000,
});
pool.on('error', (err) => console.error('pg pool error', err.message));

const query = (text, params) => pool.query(text, params);

async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );

    -- One film. intake = what you typed on the intake screen; policy = the 38 Auto/Manual
    -- toggles plus the global switches.
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      intake JSONB NOT NULL,
      policy JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',  -- running | paused | done
      budget_cap NUMERIC,                      -- USD, null = no cap
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- The state of each pipeline step (T1..T38) for a project.
    CREATE TABLE IF NOT EXISTS steps (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
        -- waiting | queued | running | review | done | failed | needs_key | stale | skipped
      output JSONB,          -- the approved result
      draft JSONB,           -- a result waiting for your approval (Manual, or Auto with a notify pause)
      progress JSONB,        -- partial work so a long step resumes after a restart
      note TEXT,             -- what the step is waiting for, or the last error
      gate JSONB,            -- the QC gate report
      cost NUMERIC NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      auto_approve_at TIMESTAMPTZ,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, step_id)
    );

    -- Every approved version of every step, so nothing is overwritten.
    CREATE TABLE IF NOT EXISTS step_versions (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      output JSONB,
      source TEXT NOT NULL,   -- ai | you
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Every image, clip, audio file and render. ref names what it is for:
    -- char:<id>, set:<id>, prop:<id>, board:<shot>, key:<shot>, take:<shot>, line:<shot>:<i>,
    -- sync:<shot>, cue:<id>, song:<id>, amb:<scene>, cut:<name>, poster, capture:<n> ...
    CREATE TABLE IF NOT EXISTS assets (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      step_id TEXT,
      ref TEXT NOT NULL,
      kind TEXT NOT NULL,          -- image | video | audio | file
      source TEXT NOT NULL DEFAULT 'ai', -- ai | you
      provider TEXT,
      model TEXT,
      prompt TEXT,
      url TEXT,                    -- provider URL (may expire)
      storage_key TEXT,            -- our copy (local disk or S3)
      mime TEXT,
      bytes INTEGER,
      duration_ms INTEGER,
      cost NUMERIC NOT NULL DEFAULT 0,
      score JSONB,
      chosen BOOLEAN NOT NULL DEFAULT false,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS assets_ref ON assets (project_id, ref);

    -- Consent records for using your own likeness and voice.
    CREATE TABLE IF NOT EXISTS consents (
      id SERIAL PRIMARY KEY,
      person TEXT NOT NULL,
      scope JSONB NOT NULL,        -- roles, content limits, voice, ask_each_time, projects
      signed_name TEXT NOT NULL,
      signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );

    -- Answers to "ask each time" likeness questions.
    CREATE TABLE IF NOT EXISTS consent_asks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      consent_id INTEGER NOT NULL REFERENCES consents(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT,                 -- null = waiting | yes | no
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      answered_at TIMESTAMPTZ
    );

    -- Work for the background worker: one row per step run.
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'run',   -- run | draft
      status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );

    -- Spend ledger: every priced call.
    CREATE TABLE IF NOT EXISTS spend (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      step_id TEXT,
      provider TEXT NOT NULL,
      what TEXT,
      usd NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { query, migrate, pool };
