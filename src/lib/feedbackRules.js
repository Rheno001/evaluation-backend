// ─────────────────────────────────────────────────────────────────────────────
//  src/lib/feedbackRules.js
//  Pure rule functions for Colleague Feedback.
// ─────────────────────────────────────────────────────────────────────────────

export const EVAL_STATUS_ORDER = [
  'draft',
  'goals_submitted',
  'goals_set',
  'self_assessment',
  'supervisor_assessment',
  'review_meeting',
  'executive_review',
  'signoff',
  'hr_review',
  'locked',
  'completed',
];

export const FEEDBACK_CLOSES_AT_STATUS = 'executive_review';

export const MAX_ENTRIES_PER_EVALUATION = 10;
export const MAX_ENTRIES_PER_AUTHOR = 3;

export const ALLOWED_BEHAVIOURS = [
  'communication',
  'ownership',
  'quality',
  'teamwork',
  'clientFocus',
];

/**
 * Checks whether the colleague feedback window is open for an evaluation or status string.
 * Open from evaluation creation until submitted for leader review (executive_review).
 * Closed at: executive_review, signoff, hr_review, locked, completed.
 *
 * @param {Object|string} evaluationOrStatus
 * @returns {boolean}
 */
export function feedbackWindowOpen(evaluationOrStatus) {
  if (!evaluationOrStatus) return false;
  const status = typeof evaluationOrStatus === 'string'
    ? evaluationOrStatus
    : (evaluationOrStatus.status ?? '');

  const normalized = String(status).trim().toLowerCase();
  const closingIdx = EVAL_STATUS_ORDER.indexOf(FEEDBACK_CLOSES_AT_STATUS);
  const statusIdx = EVAL_STATUS_ORDER.indexOf(normalized);

  if (statusIdx === -1 || closingIdx === -1) return false;
  return statusIdx < closingIdx;
}

/**
 * Validates whether an actor can submit feedback on an evaluation.
 *
 * @param {Object} actor - The user attempting to give feedback
 * @param {Object} evaluation - The evaluation record
 * @param {Array<Object>} existingEntries - Existing feedback entries on this evaluation
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canGiveFeedback(actor, evaluation, existingEntries = []) {
  if (!actor || !actor.id) {
    return { allowed: false, reason: 'Actor must be signed in.' };
  }

  if (actor.active === false) {
    return { allowed: false, reason: 'Inactive users cannot provide feedback.' };
  }

  if (!evaluation || !evaluation.id) {
    return { allowed: false, reason: 'Person has no evaluation for this period.' };
  }

  const employeeId = evaluation.employeeId ?? evaluation.employee_id;
  const supervisorId = evaluation.supervisorId ?? evaluation.supervisor_id;

  if (actor.id === employeeId) {
    return { allowed: false, reason: 'You cannot write feedback about yourself.' };
  }

  if (actor.id === supervisorId) {
    return { allowed: false, reason: 'The direct supervisor evaluates directly and cannot submit colleague feedback.' };
  }

  if (!feedbackWindowOpen(evaluation)) {
    return { allowed: false, reason: 'Feedback window is closed for this evaluation.' };
  }

  // Active / non-withdrawn entries check
  const activeEntries = (existingEntries || []).filter((e) => e.status !== 'withdrawn');

  if (activeEntries.length >= MAX_ENTRIES_PER_EVALUATION) {
    return {
      allowed: false,
      reason: `Evaluation has reached the maximum of ${MAX_ENTRIES_PER_EVALUATION} feedback entries.`,
    };
  }

  const authorEntries = activeEntries.filter(
    (e) => (e.authorId ?? e.author_id) === actor.id
  );

  if (authorEntries.length >= MAX_ENTRIES_PER_AUTHOR) {
    return {
      allowed: false,
      reason: `You have already submitted the maximum of ${MAX_ENTRIES_PER_AUTHOR} entries for this colleague.`,
    };
  }

  return { allowed: true };
}

/**
 * Checks if the evaluation supervisor can mark an entry as "not relevant".
 * Allowed only while the feedback window is open.
 *
 * @param {Object} actor
 * @param {Object} evaluation
 * @param {Object} entry
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canMarkNotRelevant(actor, evaluation, entry) {
  if (!actor || !evaluation || !entry) {
    return { allowed: false, reason: 'Missing required parameters.' };
  }

  const supervisorId = evaluation.supervisorId ?? evaluation.supervisor_id;
  if (actor.id !== supervisorId && actor.role !== 'super_admin' && actor.role !== 'admin') {
    return { allowed: false, reason: 'Only the direct supervisor or super_admin can mark feedback not relevant.' };
  }

  if (actor.id === supervisorId && !feedbackWindowOpen(evaluation)) {
    return { allowed: false, reason: 'Supervisors can only mark feedback not relevant while the feedback window is open.' };
  }

  if (evaluation.status === 'locked') {
    return { allowed: false, reason: 'Locked evaluations cannot be moderated.' };
  }

  return { allowed: true };
}

/**
 * Checks if super_admin can hide an entry.
 * Allowed until the evaluation is locked.
 *
 * @param {Object} actor
 * @param {Object} evaluation
 * @param {Object} entry
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canHideFeedback(actor, evaluation, entry) {
  if (!actor || !evaluation || !entry) {
    return { allowed: false, reason: 'Missing required parameters.' };
  }

  if (actor.role !== 'super_admin' && actor.role !== 'admin') {
    return { allowed: false, reason: 'Only super_admin can hide feedback.' };
  }

  if (evaluation.status === 'locked') {
    return { allowed: false, reason: 'Locked evaluations cannot be modified.' };
  }

  return { allowed: true };
}

/**
 * Sanitizes plain text for rendering (escapes HTML).
 *
 * @param {string} str
 * @returns {string}
 */
export function escapePlainText(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Shapes feedback entries based on viewer permissions and evaluation status.
 *
 * @param {Object} viewer - User viewing feedback
 * @param {Object} evaluation - Evaluation record
 * @param {Array<Object>} entries - Feedback records
 * @returns {Array<Object>}
 */
export function shapeFeedbackFor(viewer, evaluation, entries = []) {
  if (!viewer || !evaluation || !Array.isArray(entries)) return [];

  const employeeId = evaluation.employeeId ?? evaluation.employee_id;
  const supervisorId = evaluation.supervisorId ?? evaluation.supervisor_id;
  const isSuperAdmin = viewer.role === 'super_admin' || viewer.role === 'admin';
  const isSupervisor = viewer.id === supervisorId;
  const isEvaluatedPerson = viewer.id === employeeId;
  const isExecutive = viewer.role === 'executive';

  // 1. super_admin sees all entries with names and status reasons
  if (isSuperAdmin) {
    return entries.map((e) => ({
      id: e.id,
      evaluationId: e.evaluationId ?? e.evaluation_id,
      authorId: e.authorId ?? e.author_id,
      authorName: e.authorName ?? e.author_name ?? 'Colleague',
      authorDepartment: e.authorDepartment ?? e.author_department ?? '',
      project: e.project,
      behaviour: e.behaviour,
      rating: e.rating ?? null,
      context: e.context,
      comment: e.comment,
      status: e.status,
      statusReason: e.statusReason ?? e.status_reason ?? null,
      statusBy: e.statusBy ?? e.status_by ?? null,
      createdAt: e.createdAt ?? e.created_at,
      updatedAt: e.updatedAt ?? e.updated_at,
      flags: e.flags || [],
    }));
  }

  // 2. Direct supervisor sees names, excludes hidden entries
  if (isSupervisor) {
    return entries
      .filter((e) => e.status !== 'hidden')
      .map((e) => ({
        id: e.id,
        evaluationId: e.evaluationId ?? e.evaluation_id,
        authorId: e.authorId ?? e.author_id,
        authorName: e.authorName ?? e.author_name ?? 'Colleague',
        authorDepartment: e.authorDepartment ?? e.author_department ?? '',
        project: e.project,
        behaviour: e.behaviour,
        rating: e.rating ?? null,
        context: e.context,
        comment: e.comment,
        status: e.status,
        statusReason: e.statusReason ?? e.status_reason ?? null,
        createdAt: e.createdAt ?? e.created_at,
      }));
  }

  // 3. Evaluated person: only after agreed scores confirmed (executive_review or later)
  // Completely anonymised ("A colleague", no author id, no department). Never sees not_relevant or hidden.
  if (isEvaluatedPerson) {
    if (feedbackWindowOpen(evaluation)) {
      return [];
    }

    return entries
      .filter((e) => e.status === 'submitted')
      .map((e) => ({
        id: e.id,
        evaluationId: e.evaluationId ?? e.evaluation_id,
        authorName: 'A colleague',
        project: e.project,
        behaviour: e.behaviour,
        rating: e.rating ?? null,
        context: e.context,
        comment: e.comment,
        createdAt: e.createdAt ?? e.created_at,
      }));
  }

  // 4. Executive: only after agreed scores confirmed, anonymised, excludes not_relevant and hidden
  if (isExecutive) {
    if (feedbackWindowOpen(evaluation)) {
      return [];
    }

    return entries
      .filter((e) => e.status === 'submitted')
      .map((e) => ({
        id: e.id,
        evaluationId: e.evaluationId ?? e.evaluation_id,
        authorName: 'A colleague',
        project: e.project,
        behaviour: e.behaviour,
        rating: e.rating ?? null,
        context: e.context,
        comment: e.comment,
        createdAt: e.createdAt ?? e.created_at,
      }));
  }

  // 5. Author: can see their own entries
  const ownEntries = entries.filter((e) => (e.authorId ?? e.author_id) === viewer.id);
  if (ownEntries.length > 0) {
    return ownEntries.map((e) => ({
      id: e.id,
      evaluationId: e.evaluationId ?? e.evaluation_id,
      authorId: viewer.id,
      authorName: viewer.name ?? 'You',
      project: e.project,
      behaviour: e.behaviour,
      rating: e.rating ?? null,
      context: e.context,
      comment: e.comment,
      status: e.status,
      statusReason: e.statusReason ?? e.status_reason ?? null,
      createdAt: e.createdAt ?? e.created_at,
    }));
  }

  return [];
}

/**
 * Calculates average rating per behaviour when count >= minRaters (default 3).
 * Ignores non-submitted entries and null ratings.
 *
 * @param {Array<Object>} entries
 * @param {number} minRaters
 * @returns {Record<string, { average: number|null, count: number }>}
 */
export function averageRatingByBehaviour(entries = [], minRaters = 3) {
  const result = {};

  for (const b of ALLOWED_BEHAVIOURS) {
    result[b] = { average: null, count: 0 };
  }

  const validEntries = (entries || []).filter(
    (e) => (e.status === undefined || e.status === 'submitted') &&
      e.rating !== null &&
      e.rating !== undefined &&
      Number.isInteger(Number(e.rating)) &&
      Number(e.rating) >= 1 &&
      Number(e.rating) <= 5
  );

  const groups = {};
  for (const e of validEntries) {
    if (!groups[e.behaviour]) groups[e.behaviour] = [];
    groups[e.behaviour].push(Number(e.rating));
  }

  for (const [b, ratings] of Object.entries(groups)) {
    if (result[b]) {
      result[b].count = ratings.length;
      if (ratings.length >= minRaters) {
        const sum = ratings.reduce((acc, curr) => acc + curr, 0);
        result[b].average = Number((sum / ratings.length).toFixed(2));
      }
    }
  }

  return result;
}
