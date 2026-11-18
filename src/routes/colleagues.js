// ─────────────────────────────────────────────────────────────────────────────
//  src/routes/colleagues.js
//  Search active colleagues eligible for feedback.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import { EVAL_STATUS_ORDER, FEEDBACK_CLOSES_AT_STATUS } from '../lib/feedbackRules.js';

const router = Router();

// GET /colleagues?q=
// Minimum 2 characters, maximum 10 results, only active people whose evaluation is currently accepting feedback, never the caller
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters.' });
    }

    const closingIdx = EVAL_STATUS_ORDER.indexOf(FEEDBACK_CLOSES_AT_STATUS);
    const openStatuses = EVAL_STATUS_ORDER.slice(0, closingIdx);

    const sql = `
      SELECT DISTINCT u.id, u.name, u.department, e.id as evaluation_id
      FROM users u
      JOIN evaluations e ON e.employee_id = u.id
      WHERE u.active = true
        AND u.id != $1
        AND (e.supervisor_id IS NULL OR e.supervisor_id != $1)
        AND e.status = ANY($2::eval_status[])
        AND (u.name ILIKE $3 OR u.department ILIKE $3)
      ORDER BY u.name ASC
      LIMIT 10;
    `;

    const { rows } = await query(sql, [req.user.id, openStatuses, `%${q}%`]);
    const results = rows.map((r) => ({
      id: r.id,
      name: r.name,
      department: r.department,
      evaluationId: r.evaluation_id,
    }));

    res.json(results);
  } catch (err) {
    next(err);
  }
});

export default router;
