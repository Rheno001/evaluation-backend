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
const SELF_EDITABLE = ['draft', 'goals_set', 'self_assessment'];

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

function mergeJsonValues(existingValue, incomingValue) {
  if (incomingValue === undefined) return existingValue;
  if (incomingValue === null || typeof incomingValue !== 'object') return incomingValue;
  if (Array.isArray(incomingValue)) return incomingValue;
  if (!existingValue || typeof existingValue !== 'object' || Array.isArray(existingValue)) {
    return incomingValue;
  }

  const merged = { ...existingValue };
  for (const [key, value] of Object.entries(incomingValue)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = mergeJsonValues(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
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
    let { rows } = await query(
      `SELECT e.*, eu.name AS employee_name, u.name AS supervisor_name
       FROM evaluations e
       LEFT JOIN users eu ON eu.id = e.employee_id
       LEFT JOIN users u ON u.id = e.supervisor_id
       WHERE e.employee_id = $1
       ORDER BY e.updated_at DESC`,
      [req.user.id]
    );

    if (!rows[0]) {
      // Auto-heal: if an open cycle exists, create evaluation stub
      const { rows: cycles } = await query(
        `SELECT * FROM cycles WHERE status != 'locked' ORDER BY opened_at DESC LIMIT 1`
      );
      if (cycles[0]) {
        const cycle = cycles[0];
        const evalId = `ev-${cycle.period.trim().replace(/\s+/g, '-').toLowerCase()}-${req.user.id}`;
        const { rows: uRows } = await query('SELECT supervisor_id FROM users WHERE id = $1', [req.user.id]);
        const supId = uRows[0]?.supervisor_id || null;

        await query(
          `INSERT INTO evaluations
             (id, employee_id, supervisor_id, period, status, attendance, goals, scores,
              comments, part_h, review_meeting)
           VALUES ($1,$2,$3,$4,'draft','[]','[]','{}','{}','{}','{}')
           ON CONFLICT (id) DO NOTHING`,
          [evalId, req.user.id, supId, cycle.period.trim()]
        );

        const { rows: created } = await query(
          `SELECT e.*, eu.name AS employee_name, u.name AS supervisor_name
           FROM evaluations e
           LEFT JOIN users eu ON eu.id = e.employee_id
           LEFT JOIN users u ON u.id = e.supervisor_id
           WHERE e.id = $1`,
          [evalId]
        );
        rows = created;
      }
    }

    // Frontends commonly treat this as a list endpoint; an empty list is a valid state.
    res.json(rows ?? []);
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
      // Auto-sync: keep open evaluations supervisor_id aligned with current users.supervisor_id
      await query(
        `UPDATE evaluations e
         SET supervisor_id = u.supervisor_id
         FROM users u
         WHERE e.employee_id = u.id
           AND u.supervisor_id = $1
           AND (e.supervisor_id IS DISTINCT FROM $1)
           AND e.status != 'locked'`,
        [req.user.id]
      );

      ({ rows } = await query(
        `SELECT e.*, eu.name AS employee_name, su.name AS supervisor_name
         FROM evaluations e
         LEFT JOIN users eu ON eu.id = e.employee_id
         LEFT JOIN users su ON su.id = e.supervisor_id
         WHERE e.supervisor_id = $1 OR e.employee_id = $1
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

// ── GET /evaluations/:id/self-assessment ──────────────────────────────────
router.get('/:id/self-assessment', requireAuth, async (req, res, next) => {
  try {
    const ev = await getEvalOrFail(res, req.params.id, null);
    if (!ev) return;

    const canRead =
      req.user.role === 'admin' ||
      ev.employee_id === req.user.id ||
      ev.supervisor_id === req.user.id;
    if (!canRead) {
      return res.status(403).json({ error: 'Forbidden: you do not have permission to view this self-assessment.' });
    }

    const { rows: names } = await query(
      'SELECT id, name FROM users WHERE id = ANY($1)',
      [[ev.employee_id, ev.supervisor_id].filter(Boolean)]
    );
    const nameOf = (uid) => names.find((u) => u.id === uid)?.name ?? null;

    const submission = [...(ev.audit_log ?? [])]
      .reverse()
      .find((entry) => entry.action === 'SELF_ASSESSMENT_SUBMITTED');

    res.json({
      evaluationId: ev.id,
      period: ev.period,
      status: ev.status,
      employee: { id: ev.employee_id, name: nameOf(ev.employee_id) },
      supervisor: { id: ev.supervisor_id, name: nameOf(ev.supervisor_id) },
      submitted: !SELF_EDITABLE.includes(ev.status),
      submittedAt: submission?.timestamp ?? null,
      waived: !!ev.waived_self_assessment_note,
      waivedNote: ev.waived_self_assessment_note ?? null,
      goals: ev.goals,
      scores: ev.scores,
      comments: ev.comments,
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/goals ──────────────────────────────────────────
router.patch('/:id/goals', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { goals } = req.body ?? {};
    if (!Array.isArray(goals)) {
      return res.status(400).json({ error: 'goals must be an array.' });
    }
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.employee_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: you can only edit your own goals.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET goals = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [JSON.stringify(goals), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/goals/submit ────────────────────────────────────
router.post('/:id/goals/submit', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.employee_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: you can only submit your own goals.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'goals_submitted', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/goals/approve ───────────────────────────────────
router.post('/:id/goals/approve', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: only the assigned supervisor may approve goals.' });
    }

    const { rows: cycleRows } = await query(`SELECT status FROM cycles WHERE period = $1`, [ev.period]);
    const nextStatus = cycleRows[0]?.status === 'self_assessment' ? 'self_assessment' : 'goals_set';

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = $1, goals_rejection_note = NULL, updated_at = now() WHERE id = $2 RETURNING *`,
      [nextStatus, id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/goals/reject ────────────────────────────────────
router.post('/:id/goals/reject', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: only the assigned supervisor may reject goals.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'draft', goals_rejection_note = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [note || 'Goals returned for revision', id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/self ───────────────────────────────────────────
router.patch('/:id/self', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { scores, comments } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.employee_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    if (ev.employee_id === req.user.id && req.user.role !== 'admin' && !SELF_EDITABLE.includes(ev.status)) {
      return res.status(422).json({ error: 'Your self-assessment has been submitted and can no longer be edited.' });
    }

    const setClauses = [];
    const values = [];
    let idx = 1;
    if (scores !== undefined) {
      setClauses.push(`scores = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.scores ?? {}, scores)));
    }
    if (comments !== undefined) {
      setClauses.push(`comments = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.comments ?? {}, comments)));
    }
    setClauses.push(`updated_at = now()`);
    values.push(id);

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/self/submit ─────────────────────────────────────
router.post('/:id/self/submit', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { scores, comments } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.employee_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    if (!SELF_EDITABLE.includes(ev.status)) {
      return res.status(422).json({
        error: `Self-assessment has already been submitted (current status: ${ev.status}).`,
      });
    }

    const { rows: uRows } = await query(
      'SELECT supervisor_id FROM users WHERE id = $1',
      [ev.employee_id]
    );
    const supervisorId = ev.supervisor_id || uRows[0]?.supervisor_id || null;
    if (!supervisorId) {
      return res.status(422).json({
        error: 'No supervisor is assigned to this employee. Ask an admin to assign one before submitting.',
      });
    }

    const finalScores = mergeJsonValues(ev.scores ?? {}, scores ?? {});
    const finalComments = mergeJsonValues(ev.comments ?? {}, comments ?? {});
    if (!finalScores || Object.keys(finalScores).length === 0) {
      return res.status(400).json({ error: 'Fill in your self-assessment scores before submitting.' });
    }

    const newLog = appendAudit(ev.audit_log, req.user, 'SELF_ASSESSMENT_SUBMITTED', {
      supervisorId,
    });

    const { rows: [updated] } = await query(
      `UPDATE evaluations
       SET status = 'supervisor_assessment',
           supervisor_id = $1,
           scores = $2,
           comments = $3,
           audit_log = $4,
           updated_at = now()
       WHERE id = $5 RETURNING *`,
      [
        supervisorId,
        JSON.stringify(finalScores),
        JSON.stringify(finalComments),
        JSON.stringify(newLog),
        id,
      ]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/supervisor ─────────────────────────────────────
router.patch('/:id/supervisor', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { scores, comments } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    const setClauses = [];
    const values = [];
    let idx = 1;
    if (scores !== undefined) {
      setClauses.push(`scores = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.scores ?? {}, scores)));
    }
    if (comments !== undefined) {
      setClauses.push(`comments = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.comments ?? {}, comments)));
    }
    setClauses.push(`supervisor_scored_by = $${idx++}`);
    values.push(req.user.id);
    setClauses.push(`updated_at = now()`);
    values.push(id);

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/supervisor/submit ───────────────────────────────
router.post('/:id/supervisor/submit', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'review_meeting', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/agreed ─────────────────────────────────────────
router.patch('/:id/agreed', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { scores, goals, partH, reviewMeeting } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    const setClauses = [];
    const values = [];
    let idx = 1;
    if (scores !== undefined) {
      setClauses.push(`scores = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.scores ?? {}, scores)));
    }
    if (goals !== undefined) {
      setClauses.push(`goals = $${idx++}`);
      values.push(JSON.stringify(Array.isArray(goals) ? goals : mergeJsonValues(ev.goals ?? [], goals)));
    }
    if (partH !== undefined) {
      setClauses.push(`part_h = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.part_h ?? {}, partH)));
    }
    if (reviewMeeting !== undefined) {
      setClauses.push(`review_meeting = $${idx++}`);
      values.push(JSON.stringify(mergeJsonValues(ev.review_meeting ?? {}, reviewMeeting)));
    }
    setClauses.push(`part_h_by = $${idx++}`);
    values.push(req.user.id);
    setClauses.push(`updated_at = now()`);
    values.push(id);

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/agreed/confirm ──────────────────────────────────
router.post('/:id/agreed/confirm', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.supervisor_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'executive_review', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/executive/approve ───────────────────────────────
router.post('/:id/executive/approve', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (req.user.role !== 'admin' && req.user.role !== 'executive') {
      return res.status(403).json({ error: 'Forbidden: executive or admin only.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'signoff', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/hr/approve ──────────────────────────────────────
router.post('/:id/hr/approve', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (req.user.role !== 'admin' && req.user.role !== 'hr_officer') {
      return res.status(403).json({ error: 'Forbidden: HR or admin only.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET status = 'locked', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/attendance ─────────────────────────────────────
router.patch('/:id/attendance', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { attendance } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET attendance = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [JSON.stringify(attendance || []), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /evaluations/:id/incidents ──────────────────────────────────────
router.patch('/:id/incidents', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { incidents } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET incidents = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [JSON.stringify(incidents || []), id]
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /evaluations/:id/staff-reply ─────────────────────────────────────
router.post('/:id/staff-reply', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { comment } = req.body ?? {};
    const ev = await getEvalOrFail(res, id, null);
    if (!ev) return;

    if (ev.employee_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden: only the employee may reply.' });
    }

    const { rows: [updated] } = await query(
      `UPDATE evaluations SET staff_comment_on_agreed = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [comment || '', id]
    );
    res.json(updated);
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
