// ─────────────────────────────────────────────────────────────────────────────
//  src/lib/rules.js
//  Pure business rules module — meeting rates, trends, escalation flags & goal validation.
// ─────────────────────────────────────────────────────────────────────────────

// Server-side copy: attendanceRate stub (scoring is computed client-side)
function attendanceRate(rows = []) {
  let totalScheduled = 0, totalAttended = 0, totalLate = 0, totalAuthorised = 0;
  for (const r of rows) {
    totalScheduled  += (r.scheduled  ?? 0);
    totalAttended   += (r.attended   ?? 0);
    totalLate       += (r.late       ?? 0);
    totalAuthorised += (r.authorised ?? 0);
  }
  const denom = totalScheduled - totalAuthorised;
  if (denom <= 0) return null;
  return (totalAttended - 0.5 * totalLate) / denom;
}

/**
 * Attendance rate for a single meeting row.
 * Formula: (attended - 0.5 * late) / (scheduled - authorised)
 * Returns null if denominator is 0.
 *
 * @param {{ scheduled: number, attended: number, late: number, authorised: number }} row
 * @returns {number|null}
 */
export function meetingRate({ scheduled = 0, attended = 0, late = 0, authorised = 0 }) {
  const denom = scheduled - authorised;
  if (denom <= 0) return null;
  return (attended - 0.5 * late) / denom;
}

/**
 * Overall attendance rate across meeting rows. Reuses scoring.js attendanceRate.
 *
 * @param {Array<{ scheduled: number, attended: number, late: number, authorised: number }>} rows
 * @returns {number|null}
 */
export function overallRate(rows) {
  return attendanceRate(rows);
}

/**
 * Quarter-on-quarter trend between current rate and previous rate with 1 percentage point (0.01) tolerance.
 * - "up": current > previous + 0.01
 * - "down": current < previous - 0.01
 * - "flat": within 0.01 tolerance
 * - "n/a": when previous rate is null or undefined
 *
 * @param {number|null} current
 * @param {number|null} previous
 * @returns {"up" | "down" | "flat" | "n/a"}
 */
export function trend(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return 'n/a';
  }
  const diff = current - previous;
  if (diff > 0.01) return 'up';
  if (diff < -0.01) return 'down';
  return 'flat';
}

/**
 * Attendance escalation check.
 * Returns { escalated: boolean, reasons: string[] }.
 * Escalated if:
 * 1. Attendance rate was below 0.75 in 2 or more of the last 3 quarters.
 * 2. BPR missed without authorised reason >= 2.
 *
 * @param {{ lastThreeRates?: (number|null)[], bprMissedUnauthorised?: number }} params
 * @returns {{ escalated: boolean, reasons: string[] }}
 */
export function attendanceEscalation({ lastThreeRates = [], bprMissedUnauthorised = 0 } = {}) {
  const reasons = [];

  const lowRateQuarters = (lastThreeRates || []).filter(
    (rate) => rate !== null && rate !== undefined && rate < 0.75
  ).length;

  if (lowRateQuarters >= 2) {
    reasons.push(`Attendance rate was below 75% in ${lowRateQuarters} of the last 3 quarters.`);
  }

  if (bprMissedUnauthorised >= 2) {
    reasons.push(`Missed ${bprMissedUnauthorised} BPR sessions without an authorised reason.`);
  }

  return {
    escalated: reasons.length > 0,
    reasons,
  };
}

/**
 * Validates goals array (1 to 5 goals, each with non-empty outcome and measure).
 *
 * @param {Array<{ outcome?: string, measure?: string }>} goals
 * @returns {boolean}
 */
export function goalsAreValid(goals) {
  if (!Array.isArray(goals) || goals.length < 1 || goals.length > 5) {
    return false;
  }

  return goals.every((g) => {
    const outcomeValid = typeof g.outcome === 'string' && g.outcome.trim().length > 0;
    const measureValid = typeof g.measure === 'string' && g.measure.trim().length > 0;
    return outcomeValid && measureValid;
  });
}

/**
 * Checks if a user role can sign at the current signature status / existing signatures.
 * Order: employee & supervisor first (any order between them), then hr_officer, then managing_partner.
 *
 * @param {string} role - Current user role ('employee' | 'supervisor' | 'executive' | 'super_admin')
 * @param {string} slot - Signature slot to sign ('employee' | 'supervisor' | 'hr_officer' | 'managing_partner')
 * @param {Object} existingSignatures - Map of existing signature objects { employee, supervisor, hr_officer, managing_partner }
 * @param {Object} context - Optional context like { isTargetEmployee: boolean, isTargetSupervisor: boolean }
 * @returns {boolean}
 */
export function canSign(role, slot, existingSignatures = {}, context = {}) {
  // If already signed, cannot sign again
  if (existingSignatures[slot]?.signedAt) return false;

  const empSigned = !!existingSignatures.employee?.signedAt;
  const supSigned = !!existingSignatures.supervisor?.signedAt;
  const hrSigned = !!existingSignatures.hr_officer?.signedAt;

  if (slot === 'employee') {
    return role === 'employee' || role === 'super_admin' || context.isTargetEmployee;
  }

  if (slot === 'supervisor') {
    return role === 'supervisor' || role === 'super_admin' || context.isTargetSupervisor;
  }

  if (slot === 'hr_officer') {
    // Requires employee and supervisor to have signed first
    if (!empSigned || !supSigned) return false;
    return role === 'super_admin' || role === 'hr_officer';
  }

  if (slot === 'managing_partner') {
    // Requires HR officer to have signed first
    if (!empSigned || !supSigned || !hrSigned) return false;
    return role === 'super_admin' || role === 'executive';
  }

  return false;
}

/**
 * Evaluates promotion readiness rule set.
 * Returns { ready: boolean, reasons: string[] }
 *
 * Requirements:
 * 1. Overall Weighted Rating score >= 4.0 (Outperformance / Exceeds)
 * 2. Time in current rank >= minYears (default 2 years)
 * 3. No active unresolved major disciplinary/escalated incidents in the period
 *
 * @param {{ score: number, timeInRankYears: number, minYears?: number, hasActiveIncidents?: boolean }} params
 * @returns {{ ready: boolean, reasons: string[] }}
 */
export function promotionReadiness({ score = 0, timeInRankYears = 0, minYears = 2, hasActiveIncidents = false }) {
  const reasons = [];

  if (score < 4.0) {
    reasons.push(`Overall score (${score.toFixed(2)}) is below 4.0 threshold.`);
  }

  if (timeInRankYears < minYears) {
    reasons.push(`Time in current rank (${timeInRankYears} yrs) is below required ${minYears} yrs.`);
  }

  if (hasActiveIncidents) {
    reasons.push(`Has active or unresolved disciplinary incidents recorded.`);
  }

  return {
    ready: reasons.length === 0,
    reasons,
  };
}

/**
 * Determines HR decision rating implications for Part K.
 *
 * @param {string} decision - 'confirm_promo' | 'merit_increase' | 'retain_grade' | 'pip'
 * @returns {{ label: string, actionRequired: string }}
 */
export function ratingImplication(decision) {
  switch (decision) {
    case 'confirm_promo':
      return {
        label: 'Promoted to Next Grade',
        actionRequired: 'Update employee grade title and step in HRIS.',
      };
    case 'merit_increase':
      return {
        label: 'Salary Step Merit Increase',
        actionRequired: 'Process annual salary step increment without grade change.',
      };
    case 'pip':
      return {
        label: 'Performance Improvement Plan (PIP)',
        actionRequired: 'Initiate 90-day structured PIP with HR & Supervisor.',
      };
    case 'retain_grade':
    default:
      return {
        label: 'Retain Current Grade & Salary Step',
        actionRequired: 'No change to rank or compensation.',
      };
  }
}

/**
 * Returns evaluations where the specified user is supervisor and still has work to do.
 * Counts status in: draft, goals_submitted, goals_set, self_assessment, supervisor_assessment, review_meeting, executive_review,
 * OR status is signoff and supervisor signature is missing.
 * Excludes hr_review and locked, and signoff where supervisor already signed.
 *
 * @param {Array<Object>} evaluations
 * @param {string} userId
 * @returns {Array<Object>}
 */
export function supervisorPendingWork(evaluations = [], userId = '') {
  if (!userId) return [];
  const PENDING_STATUSES = [
    'draft',
    'goals_submitted',
    'goals_set',
    'self_assessment',
    'supervisor_assessment',
    'review_meeting',
    'executive_review',
  ];

  return evaluations.filter((ev) => {
    if (ev.supervisorId !== userId) return false;
    if (PENDING_STATUSES.includes(ev.status)) return true;
    if (ev.status === 'signoff') {
      const supSig = ev.signatures?.supervisor;
      const hasSigned = supSig?.signedAt || supSig?.type === 'waived';
      return !hasSigned;
    }
    return false;
  });
}

/**
 * Returns active users whose supervisorId is that user.
 *
 * @param {Array<Object>} users
 * @param {string} userId
 * @returns {Array<Object>}
 */
export function directReports(users = [], userId = '') {
  if (!userId) return [];
  return users.filter((u) => u.active !== false && u.supervisorId === userId);
}

/**
 * Checks if a target user can be deactivated.
 *
 * @param {{ target: Object, users: Array<Object>, evaluations: Array<Object> }} params
 * @returns {{ allowed: boolean, blockers: Array<Object>, needsDepartureNote?: boolean, openEvaluationIds?: Array<string> }}
 */
export function canDeactivate({ target, users = [], evaluations = [] }) {
  const blockers = [];
  if (!target) return { allowed: false, blockers: [{ type: 'invalid_target' }] };

  // 1. Last super admin check
  if (target.role === 'admin' && target.active !== false) {
    const activeAdmins = users.filter((u) => u.role === 'admin' && u.active !== false);
    if (activeAdmins.length <= 1) {
      blockers.push({ type: 'last_super_admin' });
    }
  }

  // 2. Direct reports check
  const reports = directReports(users, target.id);
  if (reports.length > 0) {
    blockers.push({ type: 'direct_reports', count: reports.length });
  }

  // 3. Supervisor pending work check
  const pending = supervisorPendingWork(evaluations, target.id);
  if (pending.length > 0) {
    blockers.push({ type: 'pending_supervisor_work', count: pending.length });
  }

  // Check open evaluations where target is employee (needs departure note)
  const openEmployeeEvals = evaluations.filter(
    (ev) => ev.employeeId === target.id && ev.status !== 'locked'
  );
  const needsDepartureNote = openEmployeeEvals.length > 0;

  return {
    allowed: blockers.length === 0,
    blockers,
    needsDepartureNote,
    openEvaluationIds: openEmployeeEvals.map((e) => e.id),
  };
}

/**
 * Roles capable of conducting evaluations.
 */
export const REVIEWER_ROLES = ['supervisor', 'admin'];

/**
 * Checks if a role change is allowed.
 *
 * @param {{ actor: Object, target: Object, newRole: string, users: Array<Object>, evaluations: Array<Object> }} params
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canChangeRole({ actor, target, newRole, users = [], evaluations = [] }) {
  if (!actor || !target) return { allowed: false, reason: 'Invalid parameters.' };

  // Cannot change own role
  if (actor.id === target.id) {
    return { allowed: false, reason: "You can't change your own role." };
  }

  // Last super admin check when changing from admin to non-admin
  if (target.role === 'admin' && newRole !== 'admin') {
    const activeAdmins = users.filter((u) => u.role === 'admin' && u.active !== false);
    if (activeAdmins.length <= 1) {
      return { allowed: false, reason: 'Cannot remove the last active super_admin role.' };
    }
  }

  // If target is losing reviewer capability, check direct reports and pending supervisor work
  const retainsReviewer = REVIEWER_ROLES.includes(newRole);
  if (!retainsReviewer) {
    const reports = directReports(users, target.id);
    if (reports.length > 0) {
      return {
        allowed: false,
        reason: `Cannot change role of ${target.name} because they have ${reports.length} direct report(s). Reassign their reports first.`,
      };
    }
    const pending = supervisorPendingWork(evaluations, target.id);
    if (pending.length > 0) {
      return {
        allowed: false,
        reason: `Cannot change role of ${target.name} because they have ${pending.length} pending evaluation review(s). Reassign them first.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Returns active users with a supervisor and no evaluation in the specified cycle.
 *
 * @param {Array<Object>} users
 * @param {Array<Object>} evaluations
 * @param {string} cycleId
 * @returns {Array<Object>}
 */
export function eligibleForLateAdd(users = [], evaluations = [], cycleId = '') {
  if (!cycleId) return [];
  const existingEmployeeIds = new Set(
    evaluations.filter((ev) => ev.cycleId === cycleId).map((ev) => ev.employeeId)
  );

  return users.filter((u) => {
    if (u.active === false) return false;
    if (!u.supervisorId) return false;
    return !existingEmployeeIds.has(u.id);
  });
}

/**
 * Checks whether an evaluation can be reassigned to a new supervisor.
 *
 * @param {Object} evaluation
 * @param {Object} newSupervisor
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canReassign(evaluation, newSupervisor) {
  if (!evaluation || !newSupervisor) {
    return { allowed: false, reason: 'Missing evaluation or new supervisor.' };
  }

  if (evaluation.status === 'locked') {
    return { allowed: false, reason: 'Evaluation is locked and cannot be reassigned.' };
  }

  const supSig = evaluation.signatures?.supervisor;
  if (supSig?.signedAt || supSig?.type === 'waived') {
    return { allowed: false, reason: 'Current supervisor has already signed this evaluation.' };
  }

  if (newSupervisor.id === evaluation.employeeId) {
    return { allowed: false, reason: 'An employee cannot supervise their own evaluation.' };
  }

  if (newSupervisor.active === false) {
    return { allowed: false, reason: 'Target supervisor is inactive.' };
  }

  if (!REVIEWER_ROLES.includes(newSupervisor.role)) {
    return { allowed: false, reason: 'Target user does not have a reviewer role (supervisor or admin).' };
  }

  return { allowed: true };
}

/**
 * Returns allowed departure waiver flags for an evaluation whose employee has left.
 *
 * @param {Object} evaluation
 * @returns {{ canWaiveSelfAssessment: boolean, canSupervisorSaveGoals: boolean, canWaiveEmployeeSignature: boolean }}
 */
export function departureWaivers(evaluation) {
  if (!evaluation) {
    return {
      canWaiveSelfAssessment: false,
      canSupervisorSaveGoals: false,
      canWaiveEmployeeSignature: false,
    };
  }

  const status = evaluation.status;
  const isGoalsApproved = status !== 'draft' && status !== 'goals_submitted';
  const selfSubmitted = status !== 'draft' && status !== 'goals_submitted' && status !== 'goals_set' && status !== 'self_assessment';

  // Waive self-assessment: only if goals approved AND self-assessment not already completed/submitted
  const canWaiveSelfAssessment = isGoalsApproved && !selfSubmitted;

  // Supervisor enters goals on behalf: only if goals NOT approved yet
  const canSupervisorSaveGoals = !isGoalsApproved;

  // Waive employee signature: only when status is signoff and employee has not signed
  const empSig = evaluation.signatures?.employee;
  const empSigned = empSig?.signedAt || empSig?.type === 'waived';
  const canWaiveEmployeeSignature = status === 'signoff' && !empSigned;

  return {
    canWaiveSelfAssessment,
    canSupervisorSaveGoals,
    canWaiveEmployeeSignature,
  };
}

/**
 * Evaluates setup warnings for system administration.
 * Warns if fewer than 2 active super_admins or no active executive.
 *
 * @param {Array<Object>} users
 * @returns {Array<string>}
 */
export function setupWarnings(users = []) {
  const warnings = [];
  const activeAdmins = users.filter((u) => u.role === 'admin' && u.active !== false);
  if (activeAdmins.length < 2) {
    warnings.push('Fewer than 2 active Super Admins (HR evaluations cannot be signed by a different HR officer if only 1 exists).');
  }

  const activeExecutives = users.filter((u) => u.role === 'executive' && u.active !== false);
  if (activeExecutives.length === 0) {
    warnings.push('No active Executive / Managing Partner account found.');
  }

  return warnings;
}


