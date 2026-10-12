-- ─────────────────────────────────────────────────────────────────────────────
--  002_integrity_triggers.sql
--  Step 7b: DB-layer enforcement of waiver / departure integrity
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Waived signature requires a departure record on the evaluation
CREATE OR REPLACE FUNCTION fn_check_waiver_requires_departure()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'waived' THEN
    PERFORM 1 FROM evaluations WHERE id = NEW.evaluation_id AND departure IS NOT NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A waived signature requires a departure record on the evaluation.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_waiver_requires_departure
  BEFORE INSERT OR UPDATE ON signatures
  FOR EACH ROW EXECUTE FUNCTION fn_check_waiver_requires_departure();

-- 2. Waiving self-assessment requires a departure record
CREATE OR REPLACE FUNCTION fn_check_waived_sa_requires_departure()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Only fires when waived_self_assessment_note transitions from NULL to a value
  IF NEW.waived_self_assessment_note IS NOT NULL
     AND (OLD.waived_self_assessment_note IS NULL)
     AND NEW.departure IS NULL THEN
    RAISE EXCEPTION 'Waiving self-assessment requires a departure record on the evaluation.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_waived_sa_requires_departure
  BEFORE UPDATE ON evaluations
  FOR EACH ROW EXECUTE FUNCTION fn_check_waived_sa_requires_departure();

-- 3. Goals entered_on_behalf requires a departure record
--    Enforced at app layer; also checked via a generated column check:
--    We store entered_on_behalf inside the goals JSONB elements.
--    A DB-level partial check is impractical for nested JSONB, so we rely on
--    the app-layer check in routes/evaluations.js and the trigger below:

CREATE OR REPLACE FUNCTION fn_check_goals_on_behalf_requires_departure()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  has_behalf BOOLEAN;
BEGIN
  -- Check if any goal has entered_on_behalf = true
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.goals) AS g
    WHERE (g->>'entered_on_behalf')::boolean IS TRUE
  ) INTO has_behalf;

  IF has_behalf AND NEW.departure IS NULL THEN
    RAISE EXCEPTION 'Goals entered on behalf require a departure record on the evaluation.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_goals_on_behalf_requires_departure
  BEFORE INSERT OR UPDATE ON evaluations
  FOR EACH ROW EXECUTE FUNCTION fn_check_goals_on_behalf_requires_departure();

-- 4. Migration tracking table (used by migrate.js)
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
