// ─────────────────────────────────────────────────────────────────────────────
//  src/routes/feedback.js
//  Colleague feedback routers: evaluation feedback, feedback items, and author list.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { query, getClient } from '../db.js';
import {
  canGiveFeedback,
  canMarkNotRelevant,
  canHideFeedback,
  feedbackWindowOpen,
  shapeFeedbackFor,
  averageRatingByBehaviour,
} from '../lib/feedbackRules.js';
import { canAct } from '../lib/rules.js';

export function isFeedbackFeatureEnabled() {
  return process.env.FEATURE_COLLEAGUE_FEEDBACK === 'true' || process.env.FEATURE_COLLEAGUE_FEEDBACK === '1';
}

export function requireColleagueFeedbackFeature(req, res, next) {
  if (!isFeedbackFeatureEnabled()) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

// In-memory rate limiter: max 20 submissions per hour per user
const rateLimitMap = new Map();

export function checkFeedbackRateLimit(userId, now = Date.now()) {
  const oneHourAgo = now - 3600_000;
  const timestamps = (rateLimitMap.get(userId) || []).filter((t) => t > oneHourAgo);
  if (timestamps.length >= 20) {
    return false;
  }
  timestamps.push(now);
  rateLimitMap.set(userId, timestamps);
  return true;
}

export function resetRateLimits() {
  rateLimitMap.clear();
}

// Strict Zod schemas (reject unknown fields)
const createFeedbackSchema = z
  .object({
    project: z.string().trim().min(3).max(100),
    behaviour: z.enum(['communication', 'ownership', 'quality', 'teamwork', 'clientFocus']),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    context: z.string().trim().min(10).max(300),
    comment: z.string().trim().min(20).max(1000),
  })
  .strict();

const updateFeedbackSchema = z
  .object({
    project: z.string().trim().min(3).max(100).optional(),
    behaviour: z.enum(['communication', 'ownership', 'quality', 'teamwork', 'clientFocus']).optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    context: z.string().trim().min(10).max(300).optional(),
    comment: z.string().trim().min(20).max(1000).optional(),
  })
  .strict();

const reasonSchema = z
  .object({
    reason: z.string().trim().min(5).max(1000),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Router 1: Evaluations Feedback Router (Mounted at /evaluations)
// ─────────────────────────────────────────────────────────────────────────────
export const evaluationsFeedbackRouter = Router();

// POST /evaluations/:id/feedback — Give feedback (with row locking for caps)
evaluationsFeedbackRouter.post('/:id/feedback', requireColleagueFeedbackFeature, requireAuth, async (req, res, next) => {
  try {
    const parseRes = createFeedbackSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseRes.error.flatten() });
    }
    const data = parseRes.data;

    if (!checkFeedbackRateLimit(req.user.id)) {
      return res.status(429).json({ error: 'Rate limit exceeded. Maximum 20 feedback submissions per hour.' });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      const evalRes = await client.query(
        'SELECT id, employee_id, supervisor_id, status FROM evaluations WHERE id = $1 FOR UPDATE',
        [req.params.id]
      );

      if (evalRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Evaluation not found.' });
      }

      const ev = evalRes.rows[0];
      const evaluation = {
        id: ev.id,
        employeeId: ev.employee_id,
        supervisorId: ev.supervisor_id,
        status: ev.status,
      };

      const existingRes = await client.query(
        'SELECT id, author_id, status FROM feedback WHERE evaluation_id = $1 FOR UPDATE',
        [evaluation.id]
      );

      const check = canGiveFeedback(req.user, evaluation, existingRes.rows);
      if (!check.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: check.reason });
      }

      const feedbackId = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const insertRes = await client.query(
        `INSERT INTO feedback (
          id, evaluation_id, author_id, project, behaviour, rating, context, comment, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted')
        RETURNING *`,
        [
          feedbackId,
          evaluation.id,
          req.user.id,
          data.project,
          data.behaviour,
          data.rating ?? null,
          data.context,
          data.comment,
        ]
      );

      await client.query('COMMIT');
      res.status(201).json(insertRes.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// GET /evaluations/:id/feedback — Named feedback for supervisor & admin
evaluationsFeedbackRouter.get('/:id/feedback', requireColleagueFeedbackFeature, requireAuth, async (req, res, next) => {
  try {
    const evalRes = await query('SELECT * FROM evaluations WHERE id = $1', [req.params.id]);
    if (evalRes.rows.length === 0) {
      return res.status(404).json({ error: 'Evaluation not found.' });
    }

    const ev = evalRes.rows[0];
    const evaluation = {
      id: ev.id,
      employeeId: ev.employee_id,
      supervisorId: ev.supervisor_id,
      status: ev.status,
    };

    if (!canAct(req.user, evaluation, 'view_feedback_named')) {
      return res.status(403).json({ error: 'Not authorized to view colleague feedback.' });
    }

    const { rows: entries } = await query(
      `SELECT f.*, u.name as author_name, u.department as author_department
       FROM feedback f
       JOIN users u ON u.id = f.author_id
       WHERE f.evaluation_id = $1
       ORDER BY f.created_at ASC`,
      [evaluation.id]
    );

    const shaped = shapeFeedbackFor(req.user, evaluation, entries);
    res.json(shaped);
  } catch (err) {
    next(err);
  }
});

// GET /evaluations/:id/feedback/summary — Evaluated person summary (only after agreed scores confirmed)
evaluationsFeedbackRouter.get('/:id/feedback/summary', requireColleagueFeedbackFeature, requireAuth, async (req, res, next) => {
  try {
    const evalRes = await query('SELECT * FROM evaluations WHERE id = $1', [req.params.id]);
    if (evalRes.rows.length === 0) {
      return res.status(404).json({ error: 'Evaluation not found.' });
    }

    const ev = evalRes.rows[0];
    const evaluation = {
      id: ev.id,
      employeeId: ev.employee_id,
      supervisorId: ev.supervisor_id,
      status: ev.status,
    };

    if (!canAct(req.user, evaluation, 'view_feedback_anonymous')) {
      return res.status(403).json({
        error: 'Colleague feedback is only visible after agreed scores are confirmed.',
      });
    }

    const { rows: entries } = await query(
      `SELECT f.*
       FROM feedback f
       WHERE f.evaluation_id = $1 AND f.status = 'submitted'
       ORDER BY f.created_at ASC`,
      [evaluation.id]
    );

    const shaped = shapeFeedbackFor(req.user, evaluation, entries);
    const averages = averageRatingByBehaviour(entries, 3);

    res.json({ entries: shaped, averages });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Router 2: Author's Own Feedback (Mounted at /me)
// ─────────────────────────────────────────────────────────────────────────────
export const meFeedbackRouter = Router();

// GET /me/feedback-given
meFeedbackRouter.get('/feedback-given', requireColleagueFeedbackFeature, requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT f.*, u.name as colleague_name, u.department as colleague_department,
              e.status as eval_status, e.period
       FROM feedback f
       JOIN evaluations e ON e.id = f.evaluation_id
       JOIN users u ON u.id = e.employee_id
       WHERE f.author_id = $1
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );

    res.json(
      rows.map((r) => ({
        id: r.id,
        evaluationId: r.evaluation_id,
        colleagueName: r.colleague_name,
        colleagueDepartment: r.colleague_department,
        period: r.period,
        evalStatus: r.eval_status,
        windowOpen: feedbackWindowOpen(r.eval_status),
        project: r.project,
        behaviour: r.behaviour,
        rating: r.rating,
        context: r.context,
        comment: r.comment,
        status: r.status,
        statusReason: r.status_reason,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Router 3: Feedback Item Management & Moderation (Mounted at /feedback)
// ─────────────────────────────────────────────────────────────────────────────
export const feedbackItemRouter = Router();
feedbackItemRouter.use(requireColleagueFeedbackFeature);

// GET /feedback/flags — Super Admin lists flagged feedback
feedbackItemRouter.get('/flags', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only super_admin can view flagged feedback.' });
    }

    const { rows } = await query(
      `SELECT ff.id as flag_id, ff.reason as flag_reason, ff.created_at as flagged_at, ff.resolved,
              f.id as feedback_id, f.evaluation_id, f.project, f.behaviour, f.rating, f.context, f.comment,
              f.status as feedback_status, f.status_reason,
              u_author.name as author_name, u_flag.name as flagged_by_name
       FROM feedback_flags ff
       JOIN feedback f ON f.id = ff.feedback_id
       JOIN users u_author ON u_author.id = f.author_id
       JOIN users u_flag ON u_flag.id = ff.by_user_id
       ORDER BY ff.created_at DESC`
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /feedback/:id — Author edits own entry while window is open
feedbackItemRouter.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const parseRes = updateFeedbackSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseRes.error.flatten() });
    }
    const data = parseRes.data;

    const { rows } = await query(
      `SELECT f.*, e.status as eval_status
       FROM feedback f
       JOIN evaluations e ON e.id = f.evaluation_id
       WHERE f.id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Feedback entry not found.' });
    }

    const entry = rows[0];
    if (entry.author_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit your own feedback.' });
    }

    if (!feedbackWindowOpen(entry.eval_status)) {
      return res.status(403).json({ error: 'Feedback window is closed for this evaluation.' });
    }

    if (entry.status !== 'submitted') {
      return res.status(403).json({ error: 'This feedback entry can no longer be edited.' });
    }

    const updated = await query(
      `UPDATE feedback SET
         project = COALESCE($1, project),
         behaviour = COALESCE($2, behaviour),
         rating = CASE WHEN $3::boolean THEN $4::integer ELSE rating END,
         context = COALESCE($5, context),
         comment = COALESCE($6, comment),
         updated_at = now()
       WHERE id = $7
       RETURNING *`,
      [
        data.project ?? null,
        data.behaviour ?? null,
        data.rating !== undefined,
        data.rating ?? null,
        data.context ?? null,
        data.comment ?? null,
        req.params.id,
      ]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /feedback/:id — Author withdraws entry while window is open
feedbackItemRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT f.*, e.status as eval_status
       FROM feedback f
       JOIN evaluations e ON e.id = f.evaluation_id
       WHERE f.id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Feedback entry not found.' });
    }

    const entry = rows[0];
    if (entry.author_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only withdraw your own feedback.' });
    }

    if (!feedbackWindowOpen(entry.eval_status)) {
      return res.status(403).json({ error: 'Feedback window is closed for this evaluation.' });
    }

    await query('DELETE FROM feedback WHERE id = $1', [req.params.id]);
    res.json({ ok: true, message: 'Feedback withdrawn successfully.' });
  } catch (err) {
    next(err);
  }
});

// POST /feedback/:id/not-relevant — Supervisor marks not relevant
feedbackItemRouter.post('/:id/not-relevant', requireAuth, async (req, res, next) => {
  try {
    const parseRes = reasonSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ error: 'A valid reason (at least 5 characters) is required.' });
    }
    const { reason } = parseRes.data;

    const { rows } = await query(
      `SELECT f.*, e.status as eval_status, e.supervisor_id, e.employee_id, e.audit_log
       FROM feedback f
       JOIN evaluations e ON e.id = f.evaluation_id
       WHERE f.id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Feedback entry not found.' });
    }

    const entry = rows[0];
    const evaluation = {
      id: entry.evaluation_id,
      status: entry.eval_status,
      supervisorId: entry.supervisor_id,
      employeeId: entry.employee_id,
    };

    const check = canMarkNotRelevant(req.user, evaluation, entry);
    if (!check.allowed) {
      return res.status(403).json({ error: check.reason });
    }

    const updated = await query(
      `UPDATE feedback SET status = 'not_relevant', status_reason = $1, status_by = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [reason, req.user.id, req.params.id]
    );

    const auditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      actorId: req.user.id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action: 'MARK_FEEDBACK_NOT_RELEVANT',
      details: { feedbackId: req.params.id, reason },
    };
    const newLog = [...(entry.audit_log || []), auditEntry];
    await query('UPDATE evaluations SET audit_log = $1, updated_at = now() WHERE id = $2', [
      JSON.stringify(newLog),
      entry.evaluation_id,
    ]);

    res.json(updated.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /feedback/:id/hide — Super Admin hides an entry
feedbackItemRouter.post('/:id/hide', requireAuth, async (req, res, next) => {
  try {
    const parseRes = reasonSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ error: 'A valid reason (at least 5 characters) is required.' });
    }
    const { reason } = parseRes.data;

    const { rows } = await query(
      `SELECT f.*, e.status as eval_status, e.supervisor_id, e.employee_id, e.audit_log
       FROM feedback f
       JOIN evaluations e ON e.id = f.evaluation_id
       WHERE f.id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Feedback entry not found.' });
    }

    const entry = rows[0];
    const evaluation = {
      id: entry.evaluation_id,
      status: entry.eval_status,
      supervisorId: entry.supervisor_id,
      employeeId: entry.employee_id,
    };

    const check = canHideFeedback(req.user, evaluation, entry);
    if (!check.allowed) {
      return res.status(403).json({ error: check.reason });
    }

    const updated = await query(
      `UPDATE feedback SET status = 'hidden', status_reason = $1, status_by = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [reason, req.user.id, req.params.id]
    );

    const auditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      actorId: req.user.id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action: 'HIDE_FEEDBACK',
      details: { feedbackId: req.params.id, reason },
    };
    const newLog = [...(entry.audit_log || []), auditEntry];
    await query('UPDATE evaluations SET audit_log = $1, updated_at = now() WHERE id = $2', [
      JSON.stringify(newLog),
      entry.evaluation_id,
    ]);

    res.json(updated.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /feedback/:id/flag — Evaluated person flags an entry as unfair
feedbackItemRouter.post('/:id/flag', requireAuth, async (req, res, next) => {
  try {
    const parseRes = reasonSchema.safeParse(req.body);
    if (!parseRes.success) {
      return res.status(400).json({ error: 'A valid reason (at least 5 characters) is required.' });
    }
    const { reason } = parseRes.data;

    const { rows } = await query(
      `SELECT f.*, e.status as eval_status, e.employee_id, e.audit_log
       FROM feedback f
       JOIN evaluations e ON e.id = f.evaluation_id
       WHERE f.id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Feedback entry not found.' });
    }

    const entry = rows[0];
    if (entry.employee_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the evaluated person can flag feedback as unfair.' });
    }

    if (feedbackWindowOpen(entry.eval_status)) {
      return res.status(403).json({ error: 'Feedback cannot be flagged before agreed scores are confirmed.' });
    }

    const flagId = `flag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await query(
      `INSERT INTO feedback_flags (id, feedback_id, by_user_id, reason, created_at, resolved)
       VALUES ($1, $2, $3, $4, now(), false)`,
      [flagId, req.params.id, req.user.id, reason]
    );

    const auditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      actorId: req.user.id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action: 'FLAG_FEEDBACK_UNFAIR',
      details: { feedbackId: req.params.id, flagId, reason },
    };
    const newLog = [...(entry.audit_log || []), auditEntry];
    await query('UPDATE evaluations SET audit_log = $1, updated_at = now() WHERE id = $2', [
      JSON.stringify(newLog),
      entry.evaluation_id,
    ]);

    res.status(201).json({ ok: true, flagId, message: 'Feedback flagged for review.' });
  } catch (err) {
    next(err);
  }
});

export default feedbackItemRouter;
