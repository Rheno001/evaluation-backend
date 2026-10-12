-- ─────────────────────────────────────────────────────────────────────────────
--  001_initial_schema.sql
--  CPP Group Evaluation — core schema (all steps 1-7a)
-- ─────────────────────────────────────────────────────────────────────────────

-- Evaluation workflow status
CREATE TYPE eval_status AS ENUM (
  'draft',
  'goals_submitted',
  'goals_set',
  'self_assessment',
  'supervisor_assessment',
  'review_meeting',
  'executive_review',
  'signoff',
  'hr_review',
  'locked',
  'completed'
);

-- Signature type: a normal sign or an admin waiver
CREATE TYPE sig_type AS ENUM ('signed', 'waived');

-- ── users ────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id               TEXT        PRIMARY KEY,
  name             TEXT        NOT NULL,
  email            TEXT        NOT NULL UNIQUE,
  password_hash    TEXT        NOT NULL,
  role             TEXT        NOT NULL,
  department       TEXT,
  position         TEXT,
  avatar_initials  TEXT,
  supervisor_id    TEXT        REFERENCES users(id) ON DELETE SET NULL,
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  start_date       DATE,                             -- step 7b addition
  token_version    INTEGER     NOT NULL DEFAULT 0,   -- incremented on role/supervisor/active changes
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── cycles ───────────────────────────────────────────────────────────────────
CREATE TABLE cycles (
  id                          TEXT        PRIMARY KEY,
  period                      TEXT        NOT NULL UNIQUE,
  status                      TEXT        NOT NULL DEFAULT 'draft',
  starts_on                   DATE        NOT NULL,  -- step 7b: required
  ends_on                     DATE        NOT NULL,  -- step 7b: required
  opened_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  self_assessment_opened_at   TIMESTAMPTZ,
  CONSTRAINT ends_after_starts CHECK (ends_on >= starts_on)
);

-- ── evaluations ──────────────────────────────────────────────────────────────
CREATE TABLE evaluations (
  id                          TEXT        PRIMARY KEY,
  employee_id                 TEXT        NOT NULL REFERENCES users(id),
  supervisor_id               TEXT        REFERENCES users(id),
  period                      TEXT        NOT NULL,
  status                      eval_status NOT NULL DEFAULT 'draft',
  attendance                  JSONB       NOT NULL DEFAULT '[]',
  goals                       JSONB       NOT NULL DEFAULT '[]',
  scores                      JSONB       NOT NULL DEFAULT '{}',
  comments                    JSONB       NOT NULL DEFAULT '{}',
  part_h                      JSONB       NOT NULL DEFAULT '{}',
  part_i                      JSONB,
  part_k                      JSONB,
  review_meeting              JSONB       NOT NULL DEFAULT '{}',
  staff_comment_on_agreed     TEXT        NOT NULL DEFAULT '',
  previous_score              NUMERIC,
  incidents                   JSONB       NOT NULL DEFAULT '[]',
  audit_log                   JSONB       NOT NULL DEFAULT '[]',
  -- step 7b additions
  departure                   JSONB,      -- { lastWorkingDay, note, recordedBy, recordedAt }
  supervisor_scored_by        TEXT        REFERENCES users(id),
  part_h_by                   TEXT        REFERENCES users(id),
  waived_self_assessment_note TEXT,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── signatures ───────────────────────────────────────────────────────────────
CREATE TABLE signatures (
  id              SERIAL      PRIMARY KEY,
  evaluation_id   TEXT        NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  slot            TEXT        NOT NULL CHECK (slot IN ('employee', 'supervisor', 'hr_officer', 'managing_partner')),
  signed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  signer_id       TEXT        NOT NULL REFERENCES users(id),
  signer_name     TEXT        NOT NULL,
  signer_role     TEXT        NOT NULL,
  type            sig_type    NOT NULL DEFAULT 'signed',
  note            TEXT,
  UNIQUE (evaluation_id, slot),
  -- A waived signature MUST carry a note
  CONSTRAINT waived_must_have_note CHECK (type = 'signed' OR note IS NOT NULL)
);
