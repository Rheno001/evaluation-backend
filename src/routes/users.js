// ─────────────────────────────────────────────────────────────────────────────
//  src/routes/users.js
//  GET  /users            (admin only)
//  GET  /users/:id        (self or admin)
//  PATCH /users/:id       (admin only — updateUser)
//  POST /users/:id/deactivate   (admin only — setUserActive with departure)
//  POST /users/:id/activate     (admin only)
//  POST /users/reassign-all     (admin only — reassignAllFrom, one transaction)
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth.js';
import { query, getClient } from '../db.js';
import {
  canDeactivate,
  canChangeRole,
  canReassign,
  supervisorPendingWork,
  directReports,
  setupWarnings,
} from '../lib/rules.js';

const router = Router();

// ── helper: row → safe user object (strips password_hash / token_version) ────
function safeUser(row) {
  if (!row) return null;
  const { password_hash: _, token_version: __, ...rest } = row;
  return rest;
}

// ── helper: load full user list from DB (used by rules) ─────────────────────
async function loadUsers(client) {
  const { rows } = await (client ?? query)('SELECT * FROM users', []);
  return rows;
}

async function loadEvaluations(client) {
  const { rows } = await (client ?? query)('SELECT * FROM evaluations', []);
  return rows;
}

// ── helper: increment token_version for a user (invalidates sessions) ────────
async function bumpTokenVersion(client, userId) {
  await client.query(
    'UPDATE users SET token_version = token_version + 1 WHERE id = $1',
    [userId]
  );
}

import bcrypt from 'bcryptjs';

// ── GET /users ─────────────────────────────────────────────────────────────
router.get('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, department, position,
              avatar_initials, supervisor_id, active, start_date, created_at,
              raw_password
       FROM users ORDER BY name`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST /users  (admin creates staff account) ──────────────────────────────
const CreateUserSchema = z.object({
  name:          z.string().min(1),
  email:         z.string().email(),
  password:      z.string().min(1),
  role:          z.string().min(1),
  department:    z.string().optional().default(''),
  position:      z.string().optional().default(''),
  supervisor_id: z.string().nullable().optional(),
});

router.post('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const parse = CreateUserSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: parse.error.issues[0].message });
    }
    const { name, email, password, role, department, position, supervisor_id } = parse.data;

    const existing = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [email.trim()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: `A user with email "${email}" already exists.` });
    }

    const initials = name.trim().split(/\s+/).map(w => w[0].toUpperCase()).slice(0, 2).join('');
    const id = `u-${Date.now()}`;
    const hash = await bcrypt.hash(password, 10);

    const { rows } = await query(
      `INSERT INTO users (id, name, email, password_hash, raw_password, role, department, position, avatar_initials, supervisor_id, active, start_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, CURRENT_DATE)
       RETURNING id, name, email, role, department, position, avatar_initials, supervisor_id, active, start_date, created_at, raw_password`,
      [id, name.trim(), email.toLowerCase().trim(), hash, password, role, department, position, initials, supervisor_id || null]
    );

    // Auto-create evaluation stubs for any open cycles
    if (role === 'employee') {
      try {
        const { rows: openCycles } = await query("SELECT * FROM cycles WHERE status != 'locked'");
        for (const cy of openCycles) {
          const evalId = `ev-${cy.period.trim().replace(/\s+/g, '-').toLowerCase()}-${id}`;
          await query(
            `INSERT INTO evaluations
               (id, employee_id, supervisor_id, period, status, attendance, goals, scores, comments, part_h, review_meeting)
             VALUES ($1, $2, $3, $4, 'draft', '[]', '[]', '{}', '{}', '{}', '{}')
             ON CONFLICT (id) DO NOTHING`,
            [evalId, id, supervisor_id || null, cy.period]
          );
        }
      } catch (e) {
        console.warn('Failed to auto-create evaluation stubs for new employee:', e);
      }
    }

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── GET /users/:id ─────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (req.user.role !== 'admin' && req.user.id !== id) {
      return res.status(403).json({ error: 'Forbidden: you may only view your own profile.' });
    }
    const { rows } = await query(
      `SELECT id, name, email, role, department, position,
              avatar_initials, supervisor_id, active, start_date, created_at,
              raw_password
       FROM users WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: `User ${id} not found.` });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /users/:id  (admin permanently deletes user) ─────────────────────
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  const client = await getClient();
  try {
    const { id } = req.params;
    if (req.user.id === id) {
      return res.status(400).json({ error: 'You cannot delete your own admin account.' });
    }

    await client.query('BEGIN');

    // 1. Reassign supervisees to null
    await client.query('UPDATE users SET supervisor_id = NULL WHERE supervisor_id = $1', [id]);

    // 2. Delete evaluations and signatures
    await client.query('DELETE FROM signatures WHERE evaluation_id IN (SELECT id FROM evaluations WHERE employee_id = $1)', [id]);
    await client.query('DELETE FROM evaluations WHERE employee_id = $1', [id]);

    // 3. Delete user row
    const delRes = await client.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
    if (delRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `User ${id} not found.` });
    }

    await client.query('COMMIT');
    res.json({ success: true, deletedId: id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ── PATCH /users/:id  (updateUser) ─────────────────────────────────────────
const UpdateUserSchema = z.object({
  name:            z.string().min(1).optional(),
  email:           z.string().email().optional(),
  password:        z.string().min(1).optional(),
  department:      z.string().optional(),
  position:        z.string().optional(),
  avatar_initials: z.string().max(3).optional(),
  supervisor_id:   z.string().nullable().optional(),
  start_date:      z.string().nullable().optional(),
  role:            z.string().optional(),
  active:          z.boolean().optional(),
}).strict();

router.patch('/:id', requireAuth, requireRole('admin'), async (req, res, next) => {
  const client = await getClient();
  try {
    const { id } = req.params;
    const parse = UpdateUserSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: parse.error.issues[0].message });
    }
    const patch = parse.data;

    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM users WHERE id = $1 FOR UPDATE',
      [id]
    );
    const target = rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `User ${id} not found.` });
    }

    // If role is changing, validate with rules
    if (patch.role && patch.role !== target.role) {
      const users = await loadUsers(client);
      const evals = await loadEvaluations(client);
      const check = canChangeRole({
        actor: req.user,
        target,
        newRole: patch.role,
        users,
        evaluations: evals,
      });
      if (!check.allowed) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: check.reason });
      }
    }

    // Determine if token_version must be bumped
    const sensitiveChange = patch.role || patch.supervisor_id !== undefined || patch.active !== undefined || patch.password !== undefined;

    const setClauses = [];
    const values = [];
    let paramIdx = 1;

    for (const [key, val] of Object.entries(patch)) {
      if (key === 'password') {
        const hash = await bcrypt.hash(val, 10);
        setClauses.push(`password_hash = $${paramIdx++}`);
        values.push(hash);
        setClauses.push(`raw_password = $${paramIdx++}`);
        values.push(val);
      } else if (key === 'supervisor_id') {
        setClauses.push(`${key} = $${paramIdx++}`);
        values.push(val && String(val).trim() ? String(val).trim() : null);
      } else {
        setClauses.push(`${key} = $${paramIdx++}`);
        values.push(val);
      }
    }

    if (sensitiveChange) {
      setClauses.push(`token_version = token_version + 1`);
    }

    if (setClauses.length === 0) {
      await client.query('ROLLBACK');
      return res.json(safeUser(target));
    }

    values.push(id); // last param = WHERE id
    const { rows: updated } = await client.query(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );

    if (patch.supervisor_id !== undefined) {
      await client.query(
        `UPDATE evaluations SET supervisor_id = $1 WHERE employee_id = $2 AND status != 'locked'`,
        [patch.supervisor_id || null, id]
      );
    }

    await client.query('COMMIT');
    res.json(safeUser(updated[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ── POST /users/:id/deactivate  (setUserActive with departure) ─────────────
const DeactivateSchema = z.object({
  departure: z.object({
    lastWorkingDay: z.string(),
    note:           z.string().min(1),
  }).optional(),
});

router.post('/:id/deactivate', requireAuth, requireRole('admin'), async (req, res, next) => {
  const client = await getClient();
  try {
    const { id } = req.params;
    const parse = DeactivateSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: parse.error.issues[0].message });
    }
    const { departure } = parse.data;

    await client.query('BEGIN');

    // Lock the target user row (NOWAIT → 409 if another request has the lock)
    let targetRows;
    try {
      targetRows = await client.query(
        'SELECT * FROM users WHERE id = $1 FOR UPDATE NOWAIT',
        [id]
      );
    } catch (lockErr) {
      await client.query('ROLLBACK');
      if (lockErr.code === '55P03') {
        return res.status(409).json({
          error: 'Another request is already processing this user. Please retry.',
        });
      }
      throw lockErr;
    }

    const target = targetRows.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `User ${id} not found.` });
    }

    if (!target.active) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: `User ${id} not found.` });
    }

    // Lock all evaluations where this user is supervisor and still open
    await client.query(
      `SELECT id FROM evaluations
       WHERE supervisor_id = $1
         AND status NOT IN ('hr_review','locked','completed')
       FOR UPDATE NOWAIT`,
      [id]
    );

    // Load all data for rules module
    const { rows: allUsers }  = await client.query('SELECT * FROM users');
    const { rows: allEvals }  = await client.query('SELECT * FROM evaluations');

    const check = canDeactivate({ target, users: allUsers, evaluations: allEvals });
    if (!check.allowed) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'Cannot deactivate user.', blockers: check.blockers });
    }

    // Deactivate + bump token_version
    await client.query(
      `UPDATE users SET active = false, token_version = token_version + 1 WHERE id = $1`,
      [id]
    );

    // If departure provided, close open employee evaluations
    if (departure) {
      const openEvals = allEvals.filter(
        (ev) => ev.employee_id === id && !['locked', 'completed'].includes(ev.status)
      );
      const depRecord = {
        ...departure,
        recordedBy: req.user.id,
        recordedAt: new Date().toISOString(),
      };

      for (const ev of openEvals) {
        const auditEntry = {
          id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          actorId: req.user.id,
          actorName: req.user.name,
          actorRole: req.user.role,
          action: 'EMPLOYEE_DEPARTURE',
          details: { departureDate: departure.lastWorkingDay },
        };
        const existingLog = ev.audit_log ?? [];
        await client.query(
          `UPDATE evaluations
           SET status = 'completed',
               departure = $1,
               audit_log = $2,
               updated_at = now()
           WHERE id = $3`,
          [JSON.stringify(depRecord), JSON.stringify([...existingLog, auditEntry]), ev.id]
        );
      }
    }

    await client.query('COMMIT');

    const { rows: final } = await query(
      `SELECT id, name, email, role, department, position,
              avatar_initials, supervisor_id, active, start_date
       FROM users WHERE id = $1`,
      [id]
    );
    res.json(final[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ── POST /users/:id/activate ────────────────────────────────────────────────
router.post('/:id/activate', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await query(
      `UPDATE users SET active = true WHERE id = $1
       RETURNING id, name, email, role, department, position,
                 avatar_initials, supervisor_id, active, start_date`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: `User ${id} not found.` });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── POST /users/reassign-all  (reassignAllFrom) ─────────────────────────────
const ReassignAllSchema = z.object({
  userId:          z.string().min(1),
  newSupervisorId: z.string().min(1),
  reason:          z.string().min(1),
});

router.post('/reassign-all', requireAuth, requireRole('admin'), async (req, res, next) => {
  const client = await getClient();
  try {
    const parse = ReassignAllSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: parse.error.issues[0].message });
    }
    const { userId, newSupervisorId, reason } = parse.data;

    await client.query('BEGIN');

    // Lock old supervisor + new supervisor rows
    try {
      await client.query(
        'SELECT id FROM users WHERE id = ANY($1) FOR UPDATE NOWAIT',
        [[userId, newSupervisorId]]
      );
    } catch (lockErr) {
      await client.query('ROLLBACK');
      if (lockErr.code === '55P03') {
        return res.status(409).json({
          error: 'Another request is already processing this user. Please retry.',
        });
      }
      throw lockErr;
    }

    // Lock all pending evaluations supervised by userId
    const { rows: pendingEvals } = await client.query(
      `SELECT * FROM evaluations
       WHERE supervisor_id = $1
         AND status NOT IN ('hr_review','locked','completed')
       FOR UPDATE NOWAIT`,
      [userId]
    );

    // Lock direct reports
    const { rows: reports } = await client.query(
      `SELECT * FROM users WHERE supervisor_id = $1 FOR UPDATE NOWAIT`,
      [userId]
    );

    // Validate new supervisor
    const { rows: newSupRows } = await client.query(
      'SELECT * FROM users WHERE id = $1',
      [newSupervisorId]
    );
    const newSupervisor = newSupRows[0];
    if (!newSupervisor) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `User ${newSupervisorId} not found.` });
    }
    if (!['supervisor', 'admin'].includes(newSupervisor.role)) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'Target user does not have a reviewer role (supervisor or admin).',
      });
    }
    if (!newSupervisor.active) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'Target supervisor is inactive.' });
    }

    // Move evaluations
    for (const ev of pendingEvals) {
      const check = canReassign(ev, newSupervisor);
      if (!check.allowed) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: check.reason });
      }
      const auditEntry = {
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        actorId: req.user.id,
        actorName: req.user.name,
        actorRole: req.user.role,
        action: 'SUPERVISOR_REASSIGNED_BULK',
        details: { oldSupervisorId: userId, newSupervisorId, reason },
      };
      const existingLog = ev.audit_log ?? [];
      await client.query(
        `UPDATE evaluations
         SET supervisor_id = $1, audit_log = $2, updated_at = now()
         WHERE id = $3`,
        [newSupervisorId, JSON.stringify([...existingLog, auditEntry]), ev.id]
      );
    }

    // Move direct reports
    for (const report of reports) {
      await client.query(
        'UPDATE users SET supervisor_id = $1 WHERE id = $2',
        [newSupervisorId, report.id]
      );
    }

    // Bump old supervisor token_version
    await client.query(
      'UPDATE users SET token_version = token_version + 1 WHERE id = $1',
      [userId]
    );

    await client.query('COMMIT');

    res.json({
      updatedEvaluations: pendingEvals.length,
      updatedUsers: reports.length,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export default router;
