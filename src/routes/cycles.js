// ─────────────────────────────────────────────────────────────────────────────
//  src/routes/cycles.js
//  POST /cycles                          openQuarter
//  GET  /cycles                          getCycles
//  POST /cycles/:period/open-self-assessment
//  POST /cycles/:cycleId/add-user        addToCycle (late joiners)
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth.js';
import { query } from '../db.js';
import { eligibleForLateAdd } from '../lib/rules.js';

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build empty scores skeleton for a new evaluation stub. */
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

function emptyComments() {
  return { B: { staff: '', supervisor: '' }, C: { staff: '', supervisor: '' }, D: { staff: '', supervisor: '' }, E: { staff: '', supervisor: '' } };
}

function emptyPartH() {
  return { strengths: '', developmentAreas: '', agreedActions: '', reviewDate: '' };
}

// ── GET /cycles ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM cycles ORDER BY starts_on DESC');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── POST /cycles  (openQuarter) ──────────────────────────────────────────────
const OpenQuarterSchema = z.object({
  period:    z.string().min(1),
  starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'starts_on must be YYYY-MM-DD'),
  ends_on:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ends_on must be YYYY-MM-DD'),
});

router.post('/', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const parse = OpenQuarterSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return res.status(400).json({ error: parse.error.issues[0].message });
    }
    const { period, starts_on, ends_on } = parse.data;

    if (ends_on < starts_on) {
      return res.status(400).json({ error: 'ends_on must be on or after starts_on.' });
    }

    // Check for duplicate period
    const existing = await query('SELECT id FROM cycles WHERE period = $1', [period.trim()]);
    if (existing.rows.length) {
      return res.status(422).json({ error: `Quarter "${period}" already exists.` });
    }

    const cycleId = `cycle-${period.trim().replace(/\s+/g, '-').toLowerCase()}`;

    // Create the cycle
    const { rows: [cycle] } = await query(
      `INSERT INTO cycles (id, period, status, starts_on, ends_on)
       VALUES ($1, $2, 'draft', $3, $4) RETURNING *`,
      [cycleId, period.trim(), starts_on, ends_on]
    );

    // Create evaluation stubs for all active employees
    const { rows: employees } = await query(
      `SELECT * FROM users WHERE role = 'employee' AND active = true`
    );
    const { rows: existingEvals } = await query(
      `SELECT employee_id FROM evaluations WHERE period = $1`,
      [period.trim()]
    );
    const existingSet = new Set(existingEvals.map((e) => e.employee_id));

    for (const emp of employees) {
      if (existingSet.has(emp.id)) continue;
      const evalId = `ev-${period.trim().replace(/\s+/g, '-').toLowerCase()}-${emp.id}`;
      await query(
        `INSERT INTO evaluations
           (id, employee_id, supervisor_id, period, status, attendance, goals, scores,
            comments, part_h, review_meeting)
         VALUES ($1,$2,$3,$4,'draft','[]','[]',$5,$6,$7,'{}')`,
        [
          evalId,
          emp.id,
          emp.supervisor_id ?? null,
          period.trim(),
          JSON.stringify(emptyScores()),
          JSON.stringify(emptyComments()),
          JSON.stringify(emptyPartH()),
        ]
      );
    }

    res.status(201).json(cycle);
  } catch (err) {
    next(err);
  }
});

// ── POST /cycles/:period/open-self-assessment ─────────────────────────────────
router.post('/:period/open-self-assessment', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { period } = req.params;

    const { rows: cycleRows } = await query(
      `SELECT * FROM cycles WHERE period = $1`,
      [period]
    );
    if (!cycleRows[0]) {
      return res.status(404).json({ error: `Quarter "${period}" not found.` });
    }

    const { rowCount } = await query(
      `UPDATE evaluations SET status = 'self_assessment', updated_at = now()
       WHERE period = $1 AND status = 'goals_set'`,
      [period]
    );

    const { rows: [updatedCycle] } = await query(
      `UPDATE cycles SET status = 'self_assessment', self_assessment_opened_at = now()
       WHERE period = $1 RETURNING *`,
      [period]
    );

    res.json({ cycle: updatedCycle, updatedEvaluations: rowCount });
  } catch (err) {
    next(err);
  }
});

// ── POST /cycles/:cycleId/add-user  (addToCycle — late joiner) ────────────────
router.post('/:cycleId/add-user', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { cycleId } = req.params;
    const { userId } = req.body ?? {};
    if (!userId) {
      return res.status(400).json({ error: 'userId is required.' });
    }

    const { rows: cycleRows } = await query('SELECT * FROM cycles WHERE id = $1', [cycleId]);
    const cycle = cycleRows[0];
    if (!cycle) return res.status(404).json({ error: `Cycle ${cycleId} not found.` });

    const { rows: userRows } = await query('SELECT * FROM users WHERE id = $1', [userId]);
    const targetUser = userRows[0];
    if (!targetUser) return res.status(404).json({ error: `User ${userId} not found.` });

    // Eligibility check using shared rules
    const { rows: allUsers }  = await query('SELECT * FROM users', []);
    const { rows: allEvals }  = await query('SELECT * FROM evaluations', []);

    const eligible = eligibleForLateAdd(allUsers, allEvals, cycleId);
    const isEligible = eligible.some((u) => u.id === userId);
    if (!isEligible) {
      return res.status(422).json({
        error: `User ${userId} is already in cycle ${cycle.period} or is not eligible.`,
      });
    }

    // Late joiners go directly to self_assessment if cycle is open
    const evalStatus = cycle.status === 'draft' ? 'draft' : 'self_assessment';
    const evalId = `ev-${cycle.period.trim().replace(/\s+/g, '-').toLowerCase()}-${userId}`;

    const auditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      actorId: req.user.id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action: 'LATE_JOINER_ADDED',
      details: { cycleId },
    };

    const { rows: [newEval] } = await query(
      `INSERT INTO evaluations
         (id, employee_id, supervisor_id, period, status,
          attendance, goals, scores, comments, part_h, review_meeting,
          departure, audit_log)
       VALUES ($1,$2,$3,$4,$5,'[]','[]',$6,$7,$8,'{}',NULL,$9)
       RETURNING *`,
      [
        evalId,
        userId,
        targetUser.supervisor_id ?? null,
        cycle.period,
        evalStatus,
        JSON.stringify(emptyScores()),
        JSON.stringify(emptyComments()),
        JSON.stringify(emptyPartH()),
        JSON.stringify([auditEntry]),
      ]
    );

    res.status(201).json(newEval);
  } catch (err) {
    next(err);
  }
});

export default router;
