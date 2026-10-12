// ─────────────────────────────────────────────────────────────────────────────
//  src/routes/evaluations.js
//  All evaluation endpoints including the step 7b exceptional-situation ones:
//    PATCH  /evaluations/:id/reassign-supervisor   reassignEvaluationSupervisor
//    POST   /evaluations/:id/open-self-assessment  openSelfAssessmentFor
//    POST   /evaluations/:id/waive-self-assessment waiveSelfAssessment
//    POST   /evaluations/:id/goals-on-behalf       saveGoalsOnBehalf
//    POST   /evaluations/:id/waive-employee-sig    waiveEmployeeSignature
//  Plus the existing step 1-6 endpoints.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth.js';
import { query, getClient } from '../db.js';
import { canReassign, canSign, departureWaivers } from '../lib/rules.js';

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function appendAudit(existingLog, actor, action, details = {}) {
  const entry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action,
    details,
  };
  return [...(existingLog ?? []), entry];
}

async function getEvalOrFail(res, id, client) {
  const q = client ?? query;
  const { rows } = await (client
    ? client.query('SELECT * FROM evaluations WHERE id = $1', [id])
    : query('SELECT * FROM evaluations WHERE id = $1', [id]));
  if (!rows[0]) {
    res.status(404).json({ error: `Evaluation ${id} not found.` });
    return null;
  }
  return rows[0];
}

/** Load signature rows for an evaluation, returns object keyed by slot. */
async function loadSignatures(evalId, client) {
  const q = client ?? query;
  const fn = client
    ? (sql, p) => client.query(sql, p)
    : query;
  const { rows } = await fn(
    'SELECT * FROM signatures WHERE evaluation_id = $1',
    [evalId]
  );
  const map = {};
  for (const sig of rows) {
    map[sig.slot] = sig;
  }
  return map;
}

// ── GET /evaluations/mine ─────────────────────────────────────────────────
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.*, u.name AS supervisor_name
       FROM evaluations e
       LEFT JOIN users u ON u.id = e.supervisor_id
       WHERE e.employee_id = $1
       ORDER BY e.updated_at DESC`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No evaluation found for your account.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── GET /evaluations  (team / admin) ────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    let rows;
    if (req.user.role === 'admin') {
      ({ rows } = await query(
        `SELECT e.*, eu.name AS employee_name, su.name AS supervisor_name
         FROM evaluations e
         LEFT JOIN users eu ON eu.id = e.employee_id
         LEFT JOIN users su ON su.id = e.supervisor_id
         ORDER BY e.updated_at DESC`
      ));
    } else {
      ({ rows } = await query(
        `SELECT e.*, eu.name AS employee_name, su.name AS supervisor_name
         FROM evaluations e
         LEFT JOIN users eu ON eu.id = e.employee_id
         LEFT JOIN users su ON su.id = e.supervisor_id
         WHERE e.supervisor_id = $1
         ORDER BY e.updated_at DESC`,
        [req.user.id]
      ));
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /evaluations/:id ──────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const ev = await getEvalOrFail(res, req.params.id, null);
    if (!ev) return;
    const canRead =
      req.user.role === 'admin' ||
      ev.employee_id === req.user.id ||
      ev.supervisor_id === req.user.id;
    if (!canRead) {
      return res.status(403).json({ error: 'Forbidden: you do not have permission to view this evaluation.' });
    }
    const sigs = await loadSignatures(ev.id, null);
    res.json({ ...ev, signatures: sigs });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/reassign-supervisor  (reassignEvaluationSupervisor) ──
router.patch('/:id/reassign-supervisor', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { newSupervisorId, reason } = req.body ?? {};
    if (!newSupervisorId || !reason) {
      return res.status(400).json({ error: 'newSupervisorId and reason are required.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    const { rows: newSupRows } = await query('SELECT * FROM users WHERE id = $1', [newSupervisorId]);
    const newSup = newSupRows[0];
    if (!newSup) return res.status(404).json({ error: `User ${newSupervisorId} not found.` });

    const sigs = await loadSignatures(id, null);
    const check = canReassign({ ...ev, signatures: sigs }, newSup);
    if (!check.allowed) {
      return res.status(422).json({ error: check.reason });
    }

    const oldSupId = ev.supervisor_id;
    const newLog = appendAudit(ev.audit_log, req.user, 'SUPERVISOR_REASSIGNED', {
      oldSupervisorId: oldSupId,
      newSupervisorId,
      reason,
    });

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET supervisor_id = $1, audit_log = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [newSupervisorId, JSON.stringify(newLog), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/open-self-assessment  (openSelfAssessmentFor) ──────
router.post('/:id/open-self-assessment', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (!['draft', 'goals_set'].includes(ev.status)) {
      return res.status(422).json({
        error: `Cannot open self-assessment from status ${ev.status}.`,
      });
    }

    const newLog = appendAudit(ev.audit_log, req.user, 'SELF_ASSESSMENT_OPENED_MANUALLY', {});
    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'self_assessment', audit_log = $1, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(newLog), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/waive-self-assessment  (waiveSelfAssessment) ────────
router.post('/:id/waive-self-assessment', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note } = req.body ?? {};
    if (!note?.trim()) {
      return res.status(400).json({ error: 'note is required to waive self-assessment.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.status !== 'self_assessment') {
      return res.status(422).json({
        error: `Can only waive self-assessment during self_assessment status (current: ${ev.status}).`,
      });
    }

    // App-layer departure check (DB trigger also enforces this)
    if (!ev.departure) {
      return res.status(422).json({
        error: 'Waiving self-assessment requires a departure record on the evaluation.',
      });
    }

    // Departure waivers check
    const waivers = departureWaivers(ev);
    if (!waivers.canWaiveSelfAssessment) {
      return res.status(422).json({
        error: 'Self-assessment waiver is not permitted at this stage.',
      });
    }

    const newLog = appendAudit(ev.audit_log, req.user, 'SELF_ASSESSMENT_WAIVED', { note });
    const { rows: [updated] } = await query(
      `UPDATE evaluations
       SET status = 'supervisor_assessment',
           waived_self_assessment_note = $1,
           audit_log = $2,
           updated_at = now()
       WHERE id = $3 RETURNING *`,
      [note.trim(), JSON.stringify(newLog), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/goals-on-behalf  (saveGoalsOnBehalf) ─────────────
const GoalSchema = z.object({
  id:       z.string(),
  outcome:  z.string().min(1),
  measure:  z.string().min(1),
  achieved: z.string().optional().default(''),
  staff:    z.number().nullable().optional(),
  entered_on_behalf: z.boolean().optional(),
});

router.post('/:id/goals-on-behalf', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { goals } = req.body ?? {};

    if (!Array.isArray(goals) || goals.length < 1) {
      return res.status(400).json({ error: 'Goals must be a non-empty array.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    // App-layer departure check (DB trigger also enforces)
    if (!ev.departure) {
      return res.status(422).json({
        error: 'Goals entered on behalf require a departure record on the evaluation.',
      });
    }

    const waivers = departureWaivers(ev);
    if (!waivers.canSupervisorSaveGoals) {
      return res.status(422).json({
        error: 'Goals-on-behalf is not permitted at this stage.',
      });
    }

    // Mark all goals as entered_on_behalf
    const taggedGoals = goals.map((g) => ({ ...g, entered_on_behalf: true }));

    const newLog = appendAudit(ev.audit_log, req.user, 'GOALS_SAVED_ON_BEHALF', {});
    const { rows: [updated] } = await query(
      `UPDATE evaluations
       SET goals = $1, status = 'goals_set', audit_log = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [JSON.stringify(taggedGoals), JSON.stringify(newLog), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/waive-employee-sig  (waiveEmployeeSignature) ────────
router.post('/:id/waive-employee-sig', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note } = req.body ?? {};
    if (!note?.trim()) {
      return res.status(400).json({ error: 'note is required to waive a signature.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.status !== 'signoff') {
      return res.status(422).json({
        error: `Evaluation must be in signoff status (current: ${ev.status}).`,
      });
    }

    // App-layer departure check (DB trigger fn_check_waiver_requires_departure also enforces)
    if (!ev.departure) {
      return res.status(422).json({
        error: 'A waived signature requires a departure record on the evaluation.',
      });
    }

    const waivers = departureWaivers(ev);
    if (!waivers.canWaiveEmployeeSignature) {
      return res.status(422).json({
        error: 'Employee signature waiver is not permitted at this stage.',
      });
    }

    const sigs = await loadSignatures(id, null);
    if (sigs.employee?.signed_at) {
      return res.status(422).json({ error: 'Employee has already signed.' });
    }

    // Insert waived signature (DB trigger validates departure record too)
    await query(
      `INSERT INTO signatures (evaluation_id, slot, signer_id, signer_name, signer_role, type, note)
       VALUES ($1, 'employee', $2, $3, $4, 'waived', $5)`,
      [id, req.user.id, req.user.name, req.user.role, note.trim()]
    );

    // Check if all 4 slots are now filled
    const updatedSigs = await loadSignatures(id, null);
    const allSigned =
      !!updatedSigs.employee?.signed_at &&
      !!updatedSigs.supervisor?.signed_at &&
      !!updatedSigs.hr_officer?.signed_at &&
      !!updatedSigs.managing_partner?.signed_at;

    const newStatus = allSigned ? 'hr_review' : 'signoff';
    const newLog = appendAudit(ev.audit_log, req.user, 'EMPLOYEE_SIGNATURE_WAIVED', {
      note,
      waivedBy: req.user.name,
    });

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = $1, audit_log = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [newStatus, JSON.stringify(newLog), id]
    );

    res.json({ ...updated, signatures: updatedSigs });
  } catch (err) {
    // Surface DB trigger error (departure check) as 422
    if (err.message?.includes('departure record')) {
      return res.status(422).json({ error: err.message });
    }
    next(err);
  }
});

// ── POST /evaluations/:id/sign  (signEvaluation) ──────────────────────────
router.post('/:id/sign', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { slot, password } = req.body ?? {};
    if (!slot || !password) {
      return res.status(400).json({ error: 'slot and password are required.' });
    }

    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.status !== 'signoff') {
      return res.status(422).json({
        error: `Evaluation is not ready for sign-off (current status: ${ev.status}).`,
      });
    }

    // Re-authenticate password
    const bcrypt = await import('bcryptjs');
    const { rows: userRows } = await query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );
    const valid = await bcrypt.default.compare(password, userRows[0]?.password_hash ?? '');
    if (!valid) {
      return res.status(401).json({ error: 'Password confirmation failed. Incorrect password.' });
    }

    const sigs = await loadSignatures(id, null);
    const context = {
      isTargetEmployee: ev.employee_id === req.user.id,
      isTargetSupervisor: ev.supervisor_id === req.user.id,
    };

    if (!canSign(req.user.role, slot, sigs, context)) {
      return res.status(403).json({ error: `Forbidden: you cannot sign the ${slot} slot at this time.` });
    }

    await query(
      `INSERT INTO signatures (evaluation_id, slot, signer_id, signer_name, signer_role, type)
       VALUES ($1, $2, $3, $4, $5, 'signed')`,
      [id, slot, req.user.id, req.user.name, req.user.role]
    );

    const updatedSigs = await loadSignatures(id, null);
    const allSigned =
      !!updatedSigs.employee?.signed_at &&
      !!updatedSigs.supervisor?.signed_at &&
      !!updatedSigs.hr_officer?.signed_at &&
      !!updatedSigs.managing_partner?.signed_at;

    const newStatus = allSigned ? 'hr_review' : 'signoff';
    const newLog = appendAudit(ev.audit_log, req.user, 'SIGNATURE_ADDED', {
      slot,
      signerName: req.user.name,
      newStatus,
    });

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = $1, audit_log = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [newStatus, JSON.stringify(newLog), id]
    );

    res.json({ ...updated, signatures: updatedSigs });
  } catch (err) {
    next(err);
  }
});

export default router;
