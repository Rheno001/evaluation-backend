import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import {
  getVisibleUserIds,
  canViewUser,
  directReports,
  canViewEvaluation,
  canViewSelfAssessment,
} from '../src/lib/rules.js';
import { signToken } from '../src/auth.js';

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

test('admin can review submitted self-assessments while draft data remains guarded', () => {
  const ev = {
    id: 'ev-1',
    employee_id: 'e-1',
    supervisor_id: 's-1',
    status: 'self_assessment',
  };

  assert.equal(canViewEvaluation(ev, { id: 'admin', role: 'admin' }), true);
  assert.equal(canViewEvaluation(ev, { id: 's-1', role: 'supervisor' }), true);
  assert.equal(canViewEvaluation(ev, { id: 'e-1', role: 'employee' }), true);
  assert.equal(canViewEvaluation(ev, { id: 'other', role: 'supervisor' }), false);

  assert.equal(canViewSelfAssessment(ev, { id: 'admin', role: 'admin' }), true);
  assert.equal(canViewSelfAssessment({ ...ev, status: 'draft' }, { id: 'admin', role: 'admin' }), false);
});

test('auth tokens last one hour and expire correctly', () => {
  const token = signToken({ id: 'u-1', name: 'Test User', role: 'employee', token_version: 2, supervisor_id: null });
  const decoded = jwt.decode(token);
  const ttl = Number(decoded.exp) - Number(decoded.iat);

  assert.equal(ttl, 3600);
  assert.ok(decoded.exp > decoded.iat);
});
