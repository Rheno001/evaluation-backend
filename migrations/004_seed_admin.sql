-- ─────────────────────────────────────────────────────────────────────────────
--  004_seed_admin.sql
--  Seed the default admin account used for authentication.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS raw_password TEXT;

INSERT INTO users (
  id,
  name,
  email,
  password_hash,
  raw_password,
  role,
  department,
  position,
  avatar_initials,
  supervisor_id,
  active,
  start_date
)
VALUES (
  'u-admin',
  'Admin',
  'admin@cppgroup.com',
  '$2a$10$RyxSCLWxAdR8Sie4uyOUJu3SA3f/gEL.Ck72k8QkxcQYWoPyDaYBW',
  '123456',
  'admin',
  'Administration',
  'Administrator',
  'A',
  NULL,
  TRUE,
  CURRENT_DATE
)
ON CONFLICT (email)
DO UPDATE SET
  name = EXCLUDED.name,
  password_hash = EXCLUDED.password_hash,
  raw_password = EXCLUDED.raw_password,
  role = EXCLUDED.role,
  department = EXCLUDED.department,
  position = EXCLUDED.position,
  avatar_initials = EXCLUDED.avatar_initials,
  supervisor_id = EXCLUDED.supervisor_id,
  active = EXCLUDED.active,
  start_date = EXCLUDED.start_date;
