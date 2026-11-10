import test from 'node:test';
import assert from 'node:assert/strict';

import { getVisibleUserIds, canViewUser, directReports } from '../src/lib/rules.js';

test('supervisors can see all descendants in the reporting tree', () => {
  const users = [
    { id: 's1', supervisor_id: null, active: true },
    { id: 's2', supervisor_id: 's1', active: true },
    { id: 's3', supervisor_id: 's2', active: true },
    { id: 's4', supervisor_id: 's2', active: true },
    { id: 's5', supervisor_id: 's3', active: true },
  ];

  const visible = getVisibleUserIds(users, 's1');
  assert.deepEqual(visible.sort(), ['s1', 's2', 's3', 's4', 's5'].sort());
  assert.equal(canViewUser({ id: 's1', role: 'supervisor' }, { id: 's5' }, users), true);
  assert.equal(canViewUser({ id: 's1', role: 'supervisor' }, { id: 's2' }, users), true);
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
