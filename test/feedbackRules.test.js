// ─────────────────────────────────────────────────────────────────────────────
//  test/feedbackRules.test.js
//  Pure function unit tests for Colleague Feedback rules & boundaries.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVAL_STATUS_ORDER,
  FEEDBACK_CLOSES_AT_STATUS,
  MAX_ENTRIES_PER_EVALUATION,
  MAX_ENTRIES_PER_AUTHOR,
  feedbackWindowOpen,
  canGiveFeedback,
  canMarkNotRelevant,
  canHideFeedback,
  shapeFeedbackFor,
  averageRatingByBehaviour,
  escapePlainText,
} from '../src/lib/feedbackRules.js';
import { canAct } from '../src/lib/rules.js';

test('boundary: feedbackWindowOpen across all evaluation statuses', () => {
  // Open through supervisor_assessment and review_meeting
  const openStatuses = [
    'draft',
    'goals_submitted',
    'goals_set',
    'self_assessment',
    'supervisor_assessment',
    'review_meeting',
  ];
  for (const s of openStatuses) {
    assert.equal(feedbackWindowOpen(s), true, `status ${s} should be OPEN`);
    assert.equal(feedbackWindowOpen({ status: s }), true, `status object ${s} should be OPEN`);
  }

  // Closed at executive_review, signoff, hr_review, locked, completed
  const closedStatuses = [
    'executive_review',
    'signoff',
    'hr_review',
    'locked',
    'completed',
  ];
  for (const s of closedStatuses) {
    assert.equal(feedbackWindowOpen(s), false, `status ${s} should be CLOSED`);
    assert.equal(feedbackWindowOpen({ status: s }), false, `status object ${s} should be CLOSED`);
  }

  // Unknown, missing, or empty statuses
  assert.equal(feedbackWindowOpen('unknown_status'), false);
  assert.equal(feedbackWindowOpen(null), false);
  assert.equal(feedbackWindowOpen(undefined), false);
  assert.equal(feedbackWindowOpen({}), false);
});

test('boundary: canGiveFeedback author restrictions (self, supervisor, upward, inactive, no eval)', () => {
  const evalObj = { id: 'eval-1', employeeId: 'emp-1', supervisorId: 'sup-1', status: 'draft' };
  const authorColleague = { id: 'colleague-1', role: 'employee', active: true };
  const authorSelf = { id: 'emp-1', role: 'employee', active: true };
  const authorDirectSupervisor = { id: 'sup-1', role: 'supervisor', active: true };
  const authorDirectReport = { id: 'report-1', role: 'employee', active: true };
  const inactiveUser = { id: 'colleague-2', role: 'employee', active: false };

  // 1. Regular colleague
  assert.equal(canGiveFeedback(authorColleague, evalObj).allowed, true);

  // 2. Evaluated person themselves (forbidden)
  const selfRes = canGiveFeedback(authorSelf, evalObj);
  assert.equal(selfRes.allowed, false);
  assert.match(selfRes.reason, /yourself/i);

  // 3. Evaluation's own direct supervisor (forbidden)
  const supRes = canGiveFeedback(authorDirectSupervisor, evalObj);
  assert.equal(supRes.allowed, false);
  assert.match(supRes.reason, /supervisor evaluates directly/i);

  // 4. Upward feedback: direct report giving feedback on supervisor's evaluation (allowed!)
  const supervisorEval = { id: 'eval-sup', employeeId: 'sup-1', supervisorId: 'exec-1', status: 'draft' };
  const upwardRes = canGiveFeedback(authorDirectReport, supervisorEval);
  assert.equal(upwardRes.allowed, true);

  // 5. Inactive author
  const inactiveRes = canGiveFeedback(inactiveUser, evalObj);
  assert.equal(inactiveRes.allowed, false);
  assert.match(inactiveRes.reason, /inactive/i);

  // 6. Person without evaluation
  const noEvalRes = canGiveFeedback(authorColleague, null);
  assert.equal(noEvalRes.allowed, false);
});

test('boundary: 10th and 11th entry limits on evaluation (MAX_ENTRIES_PER_EVALUATION = 10)', () => {
  const evalObj = { id: 'eval-1', employeeId: 'emp-1', supervisorId: 'sup-1', status: 'draft' };
  const author = { id: 'author-10', role: 'employee', active: true };

  // Create 9 entries by different authors
  const nineEntries = Array.from({ length: 9 }, (_, i) => ({
    id: `fb-${i}`,
    authorId: `author-${i}`,
    status: 'submitted',
  }));

  // 10th entry: allowed
  assert.equal(canGiveFeedback(author, evalObj, nineEntries).allowed, true);

  // Add 10th entry
  const tenEntries = [...nineEntries, { id: 'fb-9', authorId: 'author-9', status: 'submitted' }];
  // 11th entry: blocked
  const res11 = canGiveFeedback(author, evalObj, tenEntries);
  assert.equal(res11.allowed, false);
  assert.match(res11.reason, /maximum of 10/i);
});

test('boundary: 3rd and 4th entry by one author (MAX_ENTRIES_PER_AUTHOR = 3)', () => {
  const evalObj = { id: 'eval-1', employeeId: 'emp-1', supervisorId: 'sup-1', status: 'draft' };
  const author = { id: 'author-prolific', role: 'employee', active: true };

  const twoOwnEntries = [
    { id: 'fb-1', authorId: 'author-prolific', status: 'submitted' },
    { id: 'fb-2', authorId: 'author-prolific', status: 'submitted' },
    { id: 'fb-3', authorId: 'other-author', status: 'submitted' },
  ];

  // 3rd entry by this author: allowed
  assert.equal(canGiveFeedback(author, evalObj, twoOwnEntries).allowed, true);

  // 3 existing entries by this author: 4th entry blocked
  const threeOwnEntries = [
    ...twoOwnEntries,
    { id: 'fb-4', authorId: 'author-prolific', status: 'submitted' },
  ];
  const res4 = canGiveFeedback(author, evalObj, threeOwnEntries);
  assert.equal(res4.allowed, false);
  assert.match(res4.reason, /maximum of 3/i);
});

test('boundary: supervisor trying to mark not relevant while window is open vs just after closed', () => {
  const supervisor = { id: 'sup-1', role: 'supervisor' };
  const otherSupervisor = { id: 'sup-2', role: 'supervisor' };
  const superAdmin = { id: 'admin-1', role: 'super_admin' };
  const entry = { id: 'fb-1', status: 'submitted' };

  // While window is open (review_meeting)
  const openEval = { id: 'eval-1', employeeId: 'emp-1', supervisorId: 'sup-1', status: 'review_meeting' };
  assert.equal(canMarkNotRelevant(supervisor, openEval, entry).allowed, true);
  assert.equal(canMarkNotRelevant(otherSupervisor, openEval, entry).allowed, false);

  // Just after window closes (executive_review)
  const closedEval = { id: 'eval-1', employeeId: 'emp-1', supervisorId: 'sup-1', status: 'executive_review' };
  const closedRes = canMarkNotRelevant(supervisor, closedEval, entry);
  assert.equal(closedRes.allowed, false);
  assert.match(closedRes.reason, /while the feedback window is open/i);

  // Super admin can still moderate while evaluation is not locked
  assert.equal(canMarkNotRelevant(superAdmin, closedEval, entry).allowed, true);

  // When locked, nobody can moderate
  const lockedEval = { id: 'eval-1', employeeId: 'emp-1', supervisorId: 'sup-1', status: 'locked' };
  assert.equal(canMarkNotRelevant(superAdmin, lockedEval, entry).allowed, false);
});

test('boundary: super_admin hiding feedback until locked', () => {
  const superAdmin = { id: 'admin-1', role: 'super_admin' };
  const supervisor = { id: 'sup-1', role: 'supervisor' };
  const entry = { id: 'fb-1', status: 'submitted' };

  const evalUnlocked = { id: 'eval-1', status: 'executive_review' };
  const evalLocked = { id: 'eval-1', status: 'locked' };

  assert.equal(canHideFeedback(superAdmin, evalUnlocked, entry).allowed, true);
  assert.equal(canHideFeedback(supervisor, evalUnlocked, entry).allowed, false);
  assert.equal(canHideFeedback(superAdmin, evalLocked, entry).allowed, false);
});

test('boundary: shapeFeedbackFor for author, supervisor, super_admin, executive, evaluated person (before & after agreed scores)', () => {
  const openEval = { id: 'eval-1', employeeId: 'emp-1', supervisorId: 'sup-1', status: 'review_meeting' };
  const closedEval = { id: 'eval-1', employeeId: 'emp-1', supervisorId: 'sup-1', status: 'executive_review' };

  const entries = [
    {
      id: 'fb-1',
      evaluationId: 'eval-1',
      authorId: 'auth-1',
      authorName: 'Alice Green',
      authorDepartment: 'Engineering',
      project: 'Core Architecture',
      behaviour: 'teamwork',
      rating: 5,
      context: 'Great collaboration in sprint',
      comment: 'Alice helped untangle the dependencies and shared clear diagrams.',
      status: 'submitted',
      createdAt: '2026-05-01T10:00:00Z',
    },
    {
      id: 'fb-2',
      evaluationId: 'eval-1',
      authorId: 'auth-2',
      authorName: 'Bob Brown',
      authorDepartment: 'Design',
      project: 'Design System',
      behaviour: 'quality',
      rating: 4,
      context: 'Reviewing tokens',
      comment: 'Bob provided thorough design token documentation.',
      status: 'not_relevant',
      statusReason: 'Off-cycle task outside scope',
      statusBy: 'sup-1',
      createdAt: '2026-05-02T10:00:00Z',
    },
    {
      id: 'fb-3',
      evaluationId: 'eval-1',
      authorId: 'auth-3',
      authorName: 'Charlie Grey',
      authorDepartment: 'Finance',
      project: 'Budget tool',
      behaviour: 'ownership',
      rating: 1,
      context: 'Budget calculations',
      comment: 'Spam comment with unconstructive remarks.',
      status: 'hidden',
      statusReason: 'Violates feedback etiquette',
      statusBy: 'admin-1',
      createdAt: '2026-05-03T10:00:00Z',
    },
  ];

  const evaluatedUser = { id: 'emp-1', role: 'employee' };
  const supervisorUser = { id: 'sup-1', role: 'supervisor' };
  const superAdminUser = { id: 'admin-1', role: 'super_admin' };
  const executiveUser = { id: 'exec-1', role: 'executive' };
  const authorUser = { id: 'auth-1', role: 'employee' };
  const strangerUser = { id: 'stranger-99', role: 'employee' };

  // 1. Evaluated person BEFORE agreed scores (window open): sees EMPTY list
  const empBefore = shapeFeedbackFor(evaluatedUser, openEval, entries);
  assert.equal(empBefore.length, 0);

  // 2. Evaluated person AFTER agreed scores (executive_review):
  // Excludes not_relevant and hidden; authorName is strictly "A colleague", NO authorId, NO authorDepartment
  const empAfter = shapeFeedbackFor(evaluatedUser, closedEval, entries);
  assert.equal(empAfter.length, 1);
  assert.equal(empAfter[0].id, 'fb-1');
  assert.equal(empAfter[0].authorName, 'A colleague');
  assert.equal(empAfter[0].authorId, undefined);
  assert.equal(empAfter[0].authorDepartment, undefined);

  // 3. Supervisor: sees author names, sees not_relevant, excludes hidden
  const supView = shapeFeedbackFor(supervisorUser, openEval, entries);
  assert.equal(supView.length, 2);
  assert.deepEqual(supView.map((e) => e.authorName), ['Alice Green', 'Bob Brown']);
  assert.equal(supView[1].status, 'not_relevant');

  // 4. Super Admin: sees all 3 entries with status, reasons, and author names
  const adminView = shapeFeedbackFor(superAdminUser, closedEval, entries);
  assert.equal(adminView.length, 3);
  assert.equal(adminView[2].status, 'hidden');
  assert.equal(adminView[2].statusReason, 'Violates feedback etiquette');

  // 5. Executive: before agreed scores sees nothing; after agreed scores sees anonymised submitted entries only
  assert.equal(shapeFeedbackFor(executiveUser, openEval, entries).length, 0);
  const execView = shapeFeedbackFor(executiveUser, closedEval, entries);
  assert.equal(execView.length, 1);
  assert.equal(execView[0].authorName, 'A colleague');

  // 6. Author: sees their own entry even while window is open
  const authorView = shapeFeedbackFor(authorUser, openEval, entries);
  assert.equal(authorView.length, 1);
  assert.equal(authorView[0].id, 'fb-1');

  // 7. Unrelated colleague: sees nothing
  assert.equal(shapeFeedbackFor(strangerUser, openEval, entries).length, 0);
});

test('boundary: averageRatingByBehaviour with exactly 3 ratings vs 2', () => {
  // Behaviour 'communication' with 2 ratings: average should be null
  const entriesTwo = [
    { behaviour: 'communication', rating: 4, status: 'submitted' },
    { behaviour: 'communication', rating: 5, status: 'submitted' },
  ];
  const resTwo = averageRatingByBehaviour(entriesTwo, 3);
  assert.equal(resTwo.communication.count, 2);
  assert.equal(resTwo.communication.average, null);

  // Add 3rd rating: exactly 3 ratings -> average computed (4 + 5 + 3) / 3 = 4.00
  const entriesThree = [
    ...entriesTwo,
    { behaviour: 'communication', rating: 3, status: 'submitted' },
  ];
  const resThree = averageRatingByBehaviour(entriesThree, 3);
  assert.equal(resThree.communication.count, 3);
  assert.equal(resThree.communication.average, 4.0);

  // Hidden or not_relevant entries must NOT count towards the average
  const entriesWithIrrelevant = [
    ...entriesThree,
    { behaviour: 'communication', rating: 1, status: 'not_relevant' },
    { behaviour: 'communication', rating: 1, status: 'hidden' },
  ];
  const resClean = averageRatingByBehaviour(entriesWithIrrelevant, 3);
  assert.equal(resClean.communication.count, 3);
  assert.equal(resClean.communication.average, 4.0);
});

test('canAct permission integration for colleague feedback actions', () => {
  const evalOpen = { id: 'eval-1', employeeId: 'emp-1', supervisorId: 'sup-1', status: 'review_meeting' };
  const evalClosed = { id: 'eval-1', employeeId: 'emp-1', supervisorId: 'sup-1', status: 'executive_review' };
  const evalLocked = { id: 'eval-1', employeeId: 'emp-1', supervisorId: 'sup-1', status: 'locked' };

  const emp = { id: 'emp-1', role: 'employee' };
  const sup = { id: 'sup-1', role: 'supervisor' };
  const colleague = { id: 'colleague-1', role: 'employee', active: true };
  const admin = { id: 'admin-1', role: 'super_admin' };

  // give_feedback
  assert.equal(canAct(colleague, evalOpen, 'give_feedback'), true);
  assert.equal(canAct(emp, evalOpen, 'give_feedback'), false);
  assert.equal(canAct(sup, evalOpen, 'give_feedback'), false);
  assert.equal(canAct(colleague, evalClosed, 'give_feedback'), false);

  // view_feedback_named
  assert.equal(canAct(sup, evalOpen, 'view_feedback_named'), true);
  assert.equal(canAct(admin, evalOpen, 'view_feedback_named'), true);
  assert.equal(canAct(emp, evalOpen, 'view_feedback_named'), false);
  assert.equal(canAct(colleague, evalOpen, 'view_feedback_named'), false);

  // view_feedback_anonymous
  assert.equal(canAct(emp, evalOpen, 'view_feedback_anonymous'), false);
  assert.equal(canAct(emp, evalClosed, 'view_feedback_anonymous'), true);

  // mark_feedback_not_relevant
  assert.equal(canAct(sup, evalOpen, 'mark_feedback_not_relevant'), true);
  assert.equal(canAct(sup, evalClosed, 'mark_feedback_not_relevant'), false);

  // hide_feedback
  assert.equal(canAct(admin, evalClosed, 'hide_feedback'), true);
  assert.equal(canAct(admin, evalLocked, 'hide_feedback'), false);
  assert.equal(canAct(sup, evalClosed, 'hide_feedback'), false);
});
