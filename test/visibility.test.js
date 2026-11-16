import test from 'node:test';
import assert from 'node:assert/strict';

import { getVisibleUserIds, canViewUser, directReports, canView, canAct } from '../src/lib/rules.js';

test('supervisors only see direct reports and not descendants below them', () => {
  const users = [
    { id: 's1', supervisor_id: null, active: true },
    { id: 's2', supervisor_id: 's1', active: true },
    { id: 's3', supervisor_id: 's2', active: true },
    { id: 's4', supervisor_id: 's2', active: true },
    { id: 's5', supervisor_id: 's3', active: true },
  ];

  const visible = getVisibleUserIds(users, 's1');
  assert.deepEqual(visible.sort(), ['s2'].sort());
  assert.equal(canViewUser({ id: 's1', role: 'supervisor' }, { id: 's2' }, users), true);
  assert.equal(canViewUser({ id: 's1', role: 'supervisor' }, { id: 's3' }, users), false);
  assert.equal(canViewUser({ id: 's2', role: 'supervisor' }, { id: 's1' }, users), false);
  assert.deepEqual(directReports(users, 's2').map((u) => u.id).sort(), ['s3', 's4'].sort());
});

test('directReports accepts DB snake_case keys', () => {
  const users = [
    { id: 'u-1', supervisor_id: 'mgr-1', active: true },
    { id: 'u-2', supervisor_id: 'mgr-1', active: true },
    { id: 'u-3', supervisor_id: 'mgr-2', active: true },
  ];

  assert.deepEqual(directReports(users, 'mgr-1').map((u) => u.id).sort(), ['u-1', 'u-2'].sort());
});

test('shared permission matrix is consistent for view and admin-scope actions', () => {
  const matrix = [
    { name: 'employee can view their own draft', user: { id: 'emp-1', role: 'employee' }, evaluation: { employeeId: 'emp-1', supervisorId: 'sup-1', status: 'draft' }, action: 'view', expected: true },
    { name: 'supervisor can view a direct report', user: { id: 'sup-1', role: 'supervisor' }, evaluation: { employeeId: 'emp-1', supervisorId: 'sup-1', status: 'executive_review' }, action: 'view', expected: true },
    { name: 'other supervisor cannot view another team', user: { id: 'sup-2', role: 'supervisor' }, evaluation: { employeeId: 'emp-1', supervisorId: 'sup-1', status: 'executive_review' }, action: 'view', expected: false },
    { name: 'admin can view any evaluation', user: { id: 'admin-1', role: 'admin' }, evaluation: { employeeId: 'emp-2', supervisorId: 'sup-9', status: 'executive_review' }, action: 'view', expected: true },
    { name: 'admin can edit attendance on unlocked evaluation', user: { id: 'admin-1', role: 'admin' }, evaluation: { employeeId: 'emp-2', supervisorId: 'sup-9', status: 'draft' }, action: 'edit_attendance', expected: true },
    { name: 'compliance can edit attendance on unlocked evaluation', user: { id: 'comp-1', role: 'compliance' }, evaluation: { employeeId: 'emp-2', supervisorId: 'sup-9', status: 'supervisor_assessment' }, action: 'edit_attendance', expected: true },
    { name: 'admin can edit incidents on unlocked evaluation', user: { id: 'admin-1', role: 'admin' }, evaluation: { employeeId: 'emp-2', supervisorId: 'sup-9', status: 'draft' }, action: 'edit_incidents', expected: true },
    { name: 'supervisor cannot edit attendance on other team', user: { id: 'sup-2', role: 'supervisor' }, evaluation: { employeeId: 'emp-1', supervisorId: 'sup-1', status: 'draft' }, action: 'edit_attendance', expected: false },
    { name: 'supervisor cannot edit incidents', user: { id: 'sup-1', role: 'supervisor' }, evaluation: { employeeId: 'emp-1', supervisorId: 'sup-1', status: 'draft' }, action: 'edit_incidents', expected: false },
    { name: 'supervisor can approve their own goals', user: { id: 'sup-1', role: 'supervisor' }, evaluation: { employeeId: 'emp-1', supervisorId: 'sup-1', status: 'goals_submitted' }, action: 'approve_goals', expected: true },
    { name: 'supervisor cannot approve another team goals', user: { id: 'sup-2', role: 'supervisor' }, evaluation: { employeeId: 'emp-1', supervisorId: 'sup-1', status: 'goals_submitted' }, action: 'approve_goals', expected: false },
    { name: 'locked evaluations deny attendance edits', user: { id: 'admin-1', role: 'admin' }, evaluation: { employeeId: 'emp-2', supervisorId: 'sup-9', status: 'locked' }, action: 'edit_attendance', expected: false },
    { name: 'locked evaluations deny incident edits', user: { id: 'admin-1', role: 'admin' }, evaluation: { employeeId: 'emp-2', supervisorId: 'sup-9', status: 'locked' }, action: 'edit_incidents', expected: false },
  ];

  for (const row of matrix) {
    const actual = row.action === 'view' ? canView(row.user, row.evaluation) : canAct(row.user, row.evaluation, row.action);
    assert.equal(actual, row.expected, `${row.name}: expected ${row.expected} but got ${actual}`);
  }
});
