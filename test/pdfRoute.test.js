// ─────────────────────────────────────────────────────────────────────────────
//  test/pdfRoute.test.js
//  Unit tests for GET /evaluations/:id/pdf header rules, access control, and error handling.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import zlib from 'zlib';

function extractPdfText(buf) {
  let idx = 0;
  let allText = '';
  while (true) {
    const s = buf.indexOf('stream', idx);
    if (s === -1) break;
    let ds = s + 6;
    while (buf[ds] === 10 || buf[ds] === 13) ds++;
    const e = buf.indexOf('endstream', ds);
    if (e === -1) break;
    let de = e;
    while (buf[de - 1] === 10 || buf[de - 1] === 13) de--;
    try {
      const dec = zlib.inflateSync(buf.subarray(ds, de)).toString('utf8');
      const hexMatches = dec.match(/<([0-9a-fA-F]+)>/g) || [];
      for (const h of hexMatches) {
        allText += Buffer.from(h.slice(1, -1), 'hex').toString('utf8');
      }
    } catch {}
    idx = e + 9;
  }
  return allText;
}

// ── Mock data layer before importing the app ─────────────────────────────────
import { pool } from '../src/db.js';

let currentUsersById = {};
let currentEval = null;
let currentArch = null;
let currentSignatures = [];
let currentFeedback = [];

pool.query = async (sql, params) => {
  const queryStr = typeof sql === 'string' ? sql : sql.text;

  if (/FROM users WHERE id = \$1/i.test(queryStr)) {
    const u = currentUsersById[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }

  if (/FROM users/i.test(queryStr)) {
    return { rows: Object.values(currentUsersById), rowCount: Object.values(currentUsersById).length };
  }

  if (/FROM evaluation_archives/i.test(queryStr)) {
    return { rows: currentArch ? [{ pdf: Buffer.from('%PDF-1.4 test mock archive') }] : [], rowCount: currentArch ? 1 : 0 };
  }

  if (/FROM signatures/i.test(queryStr)) {
    return { rows: currentSignatures, rowCount: currentSignatures.length };
  }

  if (/FROM feedback/i.test(queryStr)) {
    return { rows: currentFeedback, rowCount: currentFeedback.length };
  }

  if (/FROM evaluations/i.test(queryStr)) {
    return { rows: currentEval ? [currentEval] : [], rowCount: currentEval ? 1 : 0 };
  }

  if (/INSERT INTO evaluation_archives/i.test(queryStr)) {
    return { rows: [], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
};

pool.connect = async () => ({
  query: pool.query,
  release: () => {},
});

// Import the full app and auth utilities
const { default: app } = await import('../src/server.js');
const { signToken } = await import('../src/auth.js');

function request(method, path, headers = {}) {
  return new Promise((resolve) => {
    const req = new http.IncomingMessage();
    req.method = method.toUpperCase();
    req.url = path;
    req.headers = {
      host: 'localhost',
      ...headers,
    };

    const res = new http.ServerResponse(req);
    let chunks = [];
    res.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };

    res.end = (chunk) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        body: Buffer.concat(chunks),
      });
    };

    app.handle(req, res);
  });
}

function userToken(user) {
  const u = {
    token_version: 0,
    active: true,
    supervisor_id: null,
    ...user,
  };
  currentUsersById[u.id] = u;
  return signToken(u);
}

// ── Test suites ──────────────────────────────────────────────────────────────

test('GET /evaluations/:id/pdf header rules (no-store, no ETag, content-type, expose-headers)', async () => {
  const employee = {
    id: 'emp-1',
    name: 'Jane Doe',
    role: 'employee',
    active: true,
  };
  const token = userToken(employee);

  currentEval = {
    id: 'ev-1',
    employee_id: 'emp-1',
    supervisor_id: 'sup-1',
    period: '2026-Q1',
    status: 'locked',
  };
  currentArch = true; // Serves from archive

  const res = await request('GET', '/evaluations/ev-1/pdf', {
    authorization: `Bearer ${token}`,
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store', 'Cache-Control must be no-store');
  assert.equal(res.headers['etag'], undefined, 'ETag header must not be sent');
  assert.equal(res.headers['content-type'], 'application/pdf', 'Content-Type must be application/pdf');
  assert.match(
    String(res.headers['content-disposition']),
    /attachment;\s*filename="evaluation-ev-1\.pdf"/,
    'Content-Disposition must be attachment with safe filename'
  );
  assert.match(
    String(res.headers['access-control-expose-headers']),
    /Content-Disposition/i,
    'Access-Control-Expose-Headers must include Content-Disposition'
  );
});

test('Access Control: employee can download own evaluation but not another employee evaluation', async () => {
  const emp1 = { id: 'emp-1', name: 'Emp One', role: 'employee', active: true };
  const emp2 = { id: 'emp-2', name: 'Emp Two', role: 'employee', active: true };
  const tokenEmp1 = userToken(emp1);
  const tokenEmp2 = userToken(emp2);

  currentEval = {
    id: 'ev-100',
    employee_id: 'emp-1',
    supervisor_id: 'sup-1',
    status: 'locked',
  };
  currentArch = true;

  // Own evaluation -> 200
  const resOwn = await request('GET', '/evaluations/ev-100/pdf', {
    authorization: `Bearer ${tokenEmp1}`,
  });
  assert.equal(resOwn.status, 200);

  // Another employee's evaluation -> 403 Forbidden
  const resOther = await request('GET', '/evaluations/ev-100/pdf', {
    authorization: `Bearer ${tokenEmp2}`,
  });
  assert.equal(resOther.status, 403);
  const body = JSON.parse(resOther.body.toString());
  assert.equal(body.error, 'Forbidden.');
});

test('Access Control: supervisor can download assigned evaluation in locked state but not draft or unassigned', async () => {
  const supAssigned = { id: 'sup-1', name: 'Supervisor 1', role: 'supervisor', active: true };
  const supUnassigned = { id: 'sup-2', name: 'Supervisor 2', role: 'supervisor', active: true };
  const tokenAssigned = userToken(supAssigned);
  const tokenUnassigned = userToken(supUnassigned);

  // Locked evaluation
  currentEval = {
    id: 'ev-200',
    employee_id: 'emp-5',
    supervisor_id: 'sup-1',
    status: 'locked',
  };
  currentArch = true;

  // Assigned supervisor -> 200
  const resAssigned = await request('GET', '/evaluations/ev-200/pdf', {
    authorization: `Bearer ${tokenAssigned}`,
  });
  assert.equal(resAssigned.status, 200);

  // Unassigned supervisor -> 403 Forbidden
  const resUnassigned = await request('GET', '/evaluations/ev-200/pdf', {
    authorization: `Bearer ${tokenUnassigned}`,
  });
  assert.equal(resUnassigned.status, 403);

  // Evaluation in draft -> assigned supervisor cannot view draft (canView forbids supervisor on draft)
  currentEval = {
    id: 'ev-201',
    employee_id: 'emp-5',
    supervisor_id: 'sup-1',
    status: 'draft',
  };
  const resDraft = await request('GET', '/evaluations/ev-201/pdf', {
    authorization: `Bearer ${tokenAssigned}`,
  });
  assert.equal(resDraft.status, 403);
});

test('Access Control: executive can download only at review/signoff/locked stages, not in draft', async () => {
  const exec = { id: 'exec-1', name: 'Executive Leader', role: 'executive', active: true };
  const tokenExec = userToken(exec);

  // Draft -> 403
  currentEval = {
    id: 'ev-300',
    employee_id: 'emp-9',
    supervisor_id: 'sup-9',
    status: 'draft',
  };
  currentArch = true;

  const resDraft = await request('GET', '/evaluations/ev-300/pdf', {
    authorization: `Bearer ${tokenExec}`,
  });
  assert.equal(resDraft.status, 403);

  // Locked -> 200
  currentEval = {
    id: 'ev-301',
    employee_id: 'emp-9',
    supervisor_id: 'sup-9',
    status: 'locked',
  };
  const resLocked = await request('GET', '/evaluations/ev-301/pdf', {
    authorization: `Bearer ${tokenExec}`,
  });
  assert.equal(resLocked.status, 200);
});

test('Error handling: returns clear JSON error with right status and no internal stack trace when evaluation not found', async () => {
  const admin = { id: 'adm-1', name: 'Admin User', role: 'admin', active: true };
  const tokenAdmin = userToken(admin);

  currentEval = null;

  const res = await request('GET', '/evaluations/nonexistent/pdf', {
    authorization: `Bearer ${tokenAdmin}`,
  });
  assert.equal(res.status, 404);
  const json = JSON.parse(res.body.toString());
  assert.equal(json.error, 'Evaluation nonexistent not found.');
  assert.equal(json.stack, undefined);
});

test('Colleague Feedback: live PDF generation includes colleague feedback', async () => {
  const admin = { id: 'adm-1', name: 'Admin User', role: 'admin', active: true };
  const tokenAdmin = userToken(admin);

  currentEval = {
    id: 'ev-400',
    employee_id: 'emp-1',
    supervisor_id: 'sup-1',
    period: '2026-Q1',
    status: 'locked',
  };
  currentArch = false;
  currentSignatures = [
    { slot: 'employee', signer_name: 'Emp One', signed_at: new Date().toISOString() },
    { slot: 'supervisor', signer_name: 'Sup One', signed_at: new Date().toISOString() },
    { slot: 'hr_officer', signer_name: 'HR One', signed_at: new Date().toISOString() },
  ];
  currentFeedback = [
    {
      id: 'fb-1',
      evaluation_id: 'ev-400',
      author_id: 'col-1',
      author_name: 'Jane Colleague',
      project: 'Core Platform',
      behaviour: 'teamwork',
      rating: 5,
      context: 'Worked on Q1 release together',
      comment: 'Exceptional cross-team collaboration.',
      status: 'submitted',
      created_at: new Date().toISOString(),
    },
    {
      id: 'fb-2',
      evaluation_id: 'ev-400',
      author_id: 'col-2',
      author_name: 'Bob Colleague',
      project: 'API Gateway',
      behaviour: 'quality',
      rating: 4,
      context: 'Reviewed code quality and tests',
      comment: 'High standards of code craftsmanship.',
      status: 'submitted',
      created_at: new Date().toISOString(),
    },
  ];

  const res = await request('GET', '/evaluations/ev-400/pdf', {
    authorization: `Bearer ${tokenAdmin}`,
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.ok(res.body.length > 500, 'Live generated PDF with feedback must have substantial content');
  const text = extractPdfText(res.body);
  assert.ok(text.includes('Jane Colleague'), 'Supervisor/Admin PDF includes Jane Colleague');
  assert.ok(text.includes('Bob Colleague'), 'Supervisor/Admin PDF includes Bob Colleague');
  assert.ok(text.includes('Core Platform'), 'PDF includes project name');
  assert.ok(text.includes('API Gateway'), 'PDF includes second project name');
  assert.ok(text.includes('Teamwork & Collaboration'), 'PDF includes behaviour category');
});

test('Colleague Feedback: employee receives anonymous "A colleague" and no author names in PDF', async () => {
  const emp = { id: 'emp-1', name: 'Emp One', role: 'employee', active: true };
  const tokenEmp = userToken(emp);

  currentEval = {
    id: 'ev-401',
    employee_id: 'emp-1',
    supervisor_id: 'sup-1',
    period: '2026-Q1',
    status: 'locked',
  };
  currentArch = false;
  currentSignatures = [
    { slot: 'employee', signer_name: 'Emp One', signed_at: new Date().toISOString() },
    { slot: 'supervisor', signer_name: 'Sup One', signed_at: new Date().toISOString() },
    { slot: 'hr_officer', signer_name: 'HR One', signed_at: new Date().toISOString() },
  ];
  currentFeedback = [
    {
      id: 'fb-1',
      evaluation_id: 'ev-401',
      author_id: 'secret-author-999',
      author_name: 'Secret Colleague Name',
      project: 'Top Secret Project',
      behaviour: 'communication',
      rating: 5,
      context: 'Observed communication in team standups',
      comment: 'Very clear communication style.',
      status: 'submitted',
      created_at: new Date().toISOString(),
    },
  ];

  const res = await request('GET', '/evaluations/ev-401/pdf', {
    authorization: `Bearer ${tokenEmp}`,
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  const text = extractPdfText(res.body);
  assert.ok(!text.includes('Secret Colleague Name'), 'Employee PDF must never expose author real name');
  assert.ok(!text.includes('secret-author-999'), 'Employee PDF must never expose author ID');
  assert.ok(text.includes('A colleague'), 'Employee PDF must display "A colleague"');
});

test('Colleague Feedback: empty feedback state renders gracefully', async () => {
  const admin = { id: 'adm-1', name: 'Admin User', role: 'admin', active: true };
  const tokenAdmin = userToken(admin);

  currentEval = {
    id: 'ev-402',
    employee_id: 'emp-1',
    supervisor_id: 'sup-1',
    period: '2026-Q1',
    status: 'locked',
  };
  currentArch = false;
  currentSignatures = [
    { slot: 'employee', signer_name: 'Emp One', signed_at: new Date().toISOString() },
    { slot: 'supervisor', signer_name: 'Sup One', signed_at: new Date().toISOString() },
    { slot: 'hr_officer', signer_name: 'HR One', signed_at: new Date().toISOString() },
  ];
  currentFeedback = [];

  const res = await request('GET', '/evaluations/ev-402/pdf', {
    authorization: `Bearer ${tokenAdmin}`,
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  const text = extractPdfText(res.body);
  assert.ok(text.includes('No colleague feedback was submitted'), 'Must render empty state message in PDF');
});
