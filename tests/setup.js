// ─────────────────────────────────────────────────────────────────────────────
//  tests/setup.js
//  Vitest global setup: seeds a real Neon test DB.
//
//  Convention: set DATABASE_URL in .env (or .env.test) to a dedicated test DB.
//  Before each test suite (beforeAll) the relevant tables are truncated and
//  re-seeded from scratch so tests are deterministic.
//
//  The DB schema must already exist (run `npm run migrate` once against the
//  test DATABASE_URL before running tests).
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { signToken } from '../src/auth.js';

// Shared pool used ONLY by test helpers (not by the app under test)
export const testPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

/** Execute raw SQL via the test pool. */
export async function sql(text, params) {
  return testPool.query(text, params);
}

/**
 * Truncate all tables and restart identity sequences.
 * Call this in beforeEach / beforeAll to get a clean slate.
 */
export async function resetDb() {
  // Order matters: child tables first
  await sql(`
    TRUNCATE TABLE signatures, evaluations, cycles, users
    RESTART IDENTITY CASCADE
  `);
}

/** Hash password and insert a user row. Returns the full seeded object. */
export async function seedUser(overrides = {}) {
  const defaults = {
    id:              `u-${Math.random().toString(36).slice(2, 8)}`,
    name:            'User',
    email:           `user-${Math.random().toString(36).slice(2, 8)}@example.invalid`,
    password:        'replace-with-real-password',
    role:            'employee',
    department:      'Engineering',
    position:        'Engineer',
    avatar_initials: 'U',
    supervisor_id:   null,
    active:          true,
    start_date:      '2023-01-01',
  };
  const u = { ...defaults, ...overrides };
  const hash = await bcrypt.hash(u.password, 6); // low rounds for test speed
  await sql(
    `INSERT INTO users
       (id, name, email, password_hash, role, department, position,
        avatar_initials, supervisor_id, active, start_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [u.id, u.name, u.email, hash, u.role, u.department, u.position,
     u.avatar_initials, u.supervisor_id, u.active, u.start_date]
  );

  // Return inserted row (password_hash kept for token_version check)
  const { rows } = await sql('SELECT * FROM users WHERE id = $1', [u.id]);
  return { ...rows[0], password: u.password };
}

/** Insert a cycle row. */
export async function seedCycle(overrides = {}) {
  const defaults = {
    id:        `cycle-q4-2026`,
    period:    'Q4 2026',
    status:    'self_assessment',
    starts_on: '2026-10-01',
    ends_on:   '2026-12-31',
  };
  const c = { ...defaults, ...overrides };
  await sql(
    `INSERT INTO cycles (id, period, status, starts_on, ends_on)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO NOTHING`,
    [c.id, c.period, c.status, c.starts_on, c.ends_on]
  );
  const { rows } = await sql('SELECT * FROM cycles WHERE id = $1', [c.id]);
  return rows[0];
}

/** Build empty scores structure (mirrors the mock). */
function emptyScores() {
  return {
    B: {
      meetingAttendanceRate: { staff: null, supervisor: null, agreed: null, evidence: '' },
      punctuality:           { staff: null, supervisor: null, agreed: null, evidence: '' },
      participation:         { staff: null, supervisor: null, agreed: null, evidence: '' },
      advanceNotice:         { staff: null, supervisor: null, agreed: null, evidence: '' },
    },
    D: { timeManagement: { staff: null, supervisor: null, agreed: null, evidence: '' } },
    E: {
      communication: { staff: null, supervisor: null, agreed: null, evidence: '' },
      ownership:     { staff: null, supervisor: null, agreed: null, evidence: '' },
      quality:       { staff: null, supervisor: null, agreed: null, evidence: '' },
      teamwork:      { staff: null, supervisor: null, agreed: null, evidence: '' },
      clientFocus:   { staff: null, supervisor: null, agreed: null, evidence: '' },
    },
  };
}

/** Insert an evaluation row. */
export async function seedEvaluation(overrides = {}) {
  const defaults = {
    id:             `ev-${Math.random().toString(36).slice(2, 8)}`,
    employee_id:    null,
    supervisor_id:  null,
    period:         'Q4 2026',
    status:         'self_assessment',
    attendance:     [],
    goals:          [],
    scores:         emptyScores(),
    comments:       { B: { staff: '', supervisor: '' }, C: { staff: '', supervisor: '' }, D: { staff: '', supervisor: '' }, E: { staff: '', supervisor: '' } },
    part_h:         { strengths: '', developmentAreas: '', agreedActions: '', reviewDate: '' },
    review_meeting: {},
    part_h_by:      null,
    departure:      null,
    audit_log:      [],
  };
  const e = { ...defaults, ...overrides };
  await sql(
    `INSERT INTO evaluations
       (id, employee_id, supervisor_id, period, status,
        attendance, goals, scores, comments, part_h, review_meeting,
        part_h_by, departure, audit_log)
     VALUES ($1,$2,$3,$4,$5,
             $6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,
             $12,$13::jsonb,$14::jsonb)`,
    [
      e.id, e.employee_id, e.supervisor_id, e.period, e.status,
      JSON.stringify(e.attendance),
      JSON.stringify(e.goals),
      JSON.stringify(e.scores),
      JSON.stringify(e.comments),
      JSON.stringify(e.part_h),
      JSON.stringify(e.review_meeting),
      e.part_h_by,
      e.departure ? JSON.stringify(e.departure) : null,
      JSON.stringify(e.audit_log),
    ]
  );
  const { rows } = await sql('SELECT * FROM evaluations WHERE id = $1', [e.id]);
  return rows[0];
}

/**
 * Create a signed JWT for a user (for use in Authorization headers).
 * Reads token_version from the passed row so the token is valid against the DB.
 */
export function tokenFor(user) {
  return signToken({
    id:            user.id,
    name:          user.name,
    role:          user.role,
    token_version: user.token_version ?? 0,
  });
}
