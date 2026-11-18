-- ─────────────────────────────────────────────────────────────────────────────
--  005_colleague_feedback.sql
--  Additive migration for colleague feedback and feedback moderation.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feedback (
  id             TEXT        PRIMARY KEY,
  evaluation_id  TEXT        NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  author_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project        TEXT        NOT NULL CHECK (char_length(project) >= 3 AND char_length(project) <= 100),
  behaviour      TEXT        NOT NULL CHECK (behaviour IN ('communication', 'ownership', 'quality', 'teamwork', 'clientFocus')),
  rating         INTEGER     CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  context        TEXT        NOT NULL CHECK (char_length(context) >= 10 AND char_length(context) <= 300),
  comment        TEXT        NOT NULL CHECK (char_length(comment) >= 20 AND char_length(comment) <= 1000),
  status         TEXT        NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'not_relevant', 'hidden')),
  status_reason  TEXT,
  status_by      TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback_flags (
  id          TEXT        PRIMARY KEY,
  feedback_id TEXT        NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  by_user_id  TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT        NOT NULL CHECK (char_length(trim(reason)) >= 5 AND char_length(reason) <= 1000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved    BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_feedback_evaluation_id ON feedback (evaluation_id);
CREATE INDEX IF NOT EXISTS idx_feedback_author_id ON feedback (author_id);
CREATE INDEX IF NOT EXISTS idx_feedback_flags_feedback_id ON feedback_flags (feedback_id);
