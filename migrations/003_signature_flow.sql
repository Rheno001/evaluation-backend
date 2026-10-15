-- ─────────────────────────────────────────────────────────────────────────────
--  003_signature_flow.sql
--  Add persisted signature image support and enforce one signature per slot.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_image TEXT;
ALTER TABLE signatures ADD COLUMN IF NOT EXISTS image TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS signatures_eval_slot_uniq
  ON signatures (evaluation_id, slot);
