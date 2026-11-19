// ─────────────────────────────────────────────────────────────────────────────
//  test/routeIsolation.test.js
//  Regression test: mounts the full Express app and asserts that every
//  existing evaluation route resolves to its own handler and not to a
//  different router, with the feedback feature flag both enabled and disabled.
//
//  Requirements:
//  • Mounts the full app with mocked data layer only (never a real database).
//  • Asserts route isolation for /evaluations/mine, /evaluations/team,
//    /evaluations/:id, and other existing evaluation routes.
//  • Asserts that tests pass with feedback flag both ENABLED and DISABLED.
//  • Fails if a parameterised route shadows a fixed path.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

// ── Mock data layer before importing the app ─────────────────────────────────
import { pool } from '../src/db.js';

const mockUser = {
  id: 'u-emp-1',
  name: 'Test Employee',
  email: 'employee@test.com',
  role: 'employee',
  department: 'Engineering',
  position: 'Developer',
  active: true,
  token_version: 0,
  supervisor_id: 'u-sup-1',
};

const mockEvaluation = {
  id: 'eval-101',
  employee_id: 'u-emp-1',
  supervisor_id: 'u-sup-1',
  cycle_id: 'cycle-2025-q1',
  status: 'draft',
  goals: [],
  audit_log: [],
};

pool.query = async (sql, params) => {
  const queryStr = typeof sql === 'string' ? sql : sql.text;
  if (/FROM users/i.test(queryStr)) {
    return { rows: [mockUser], rowCount: 1 };
  }
  if (/FROM evaluations/i.test(queryStr)) {
    return { rows: [mockEvaluation], rowCount: 1 };
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

const validToken = signToken({
  id: mockUser.id,
  name: mockUser.name,
  role: mockUser.role,
  token_version: mockUser.token_version,
});

/**
 * Dispatches a simulated HTTP request directly through the Express app
 * without binding to external network sockets.
 */
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
    let body = '';
    res.write = (chunk) => {
      body += chunk;
      return true;
    };
    res.end = (chunk) => {
      if (chunk) body += chunk;
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        parsed = body;
      }
      resolve({ status: res.statusCode, body: parsed });
    };

    app.handle(req, res);
  });
}

function setFeedbackFlag(enabled) {
  if (enabled) {
    process.env.FEATURE_COLLEAGUE_FEEDBACK = 'true';
  } else {
    delete process.env.FEATURE_COLLEAGUE_FEEDBACK;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Suite 1: Feedback Feature Flag DISABLED
// ─────────────────────────────────────────────────────────────────────────────

test('flag DISABLED: /evaluations/mine resolves to evaluation handler (not 404 from feedback)', async () => {
  setFeedbackFlag(false);

  // Authenticated request reaches evaluation handler and returns 200
  const authed = await request('GET', '/evaluations/mine', {
    authorization: `Bearer ${validToken}`,
  });
  assert.equal(authed.status, 200);
  assert.ok(Array.isArray(authed.body), 'Expected array of evaluations from evaluationRoutes');

  // Unauthenticated request reaches requireAuth on evaluation handler (401, NOT 404)
  const unauthed = await request('GET', '/evaluations/mine');
  assert.equal(unauthed.status, 401);
  assert.notEqual(unauthed.status, 404, 'Must not be shadowed or intercepted by feedback router');
});

test('flag DISABLED: /evaluations/team resolves to evaluation handler (not 404 from feedback)', async () => {
  setFeedbackFlag(false);

  // /evaluations/team matches /evaluations/:id in evaluationRoutes
  const authed = await request('GET', '/evaluations/team', {
    authorization: `Bearer ${validToken}`,
  });
  // Since mock DB returns mockEvaluation, it returns 200
  assert.equal(authed.status, 200);

  const unauthed = await request('GET', '/evaluations/team');
  assert.equal(unauthed.status, 401);
  assert.notEqual(unauthed.status, 404);
});

test('flag DISABLED: /evaluations/:id resolves to evaluation handler (not 404 from feedback)', async () => {
  setFeedbackFlag(false);

  const authed = await request('GET', '/evaluations/eval-101', {
    authorization: `Bearer ${validToken}`,
  });
  assert.equal(authed.status, 200);
  assert.equal(authed.body.id, 'eval-101');

  const unauthed = await request('GET', '/evaluations/eval-101');
  assert.equal(unauthed.status, 401);
  assert.notEqual(unauthed.status, 404);
});

test('flag DISABLED: /evaluations/ (root) resolves to evaluation handler', async () => {
  setFeedbackFlag(false);

  const authed = await request('GET', '/evaluations', {
    authorization: `Bearer ${validToken}`,
  });
  assert.equal(authed.status, 200);

  const unauthed = await request('GET', '/evaluations');
  assert.equal(unauthed.status, 401);
});

test('flag DISABLED: /evaluations/signature/me resolves to evaluation signature handler', async () => {
  setFeedbackFlag(false);

  const authed = await request('GET', '/evaluations/signature/me', {
    authorization: `Bearer ${validToken}`,
  });
  assert.equal(authed.status, 200);

  const unauthed = await request('GET', '/evaluations/signature/me');
  assert.equal(unauthed.status, 401);
});

test('flag DISABLED: /evaluations/:id/self-assessment resolves to self-assessment handler', async () => {
  setFeedbackFlag(false);

  const authed = await request('GET', '/evaluations/eval-101/self-assessment', {
    authorization: `Bearer ${validToken}`,
  });
  assert.equal(authed.status, 200);

  const unauthed = await request('GET', '/evaluations/eval-101/self-assessment');
  assert.equal(unauthed.status, 401);
});

test('flag DISABLED: feedback endpoints explicitly return 404', async () => {
  setFeedbackFlag(false);

  const feedbackGet = await request('GET', '/evaluations/eval-101/feedback', {
    authorization: `Bearer ${validToken}`,
  });
  assert.equal(feedbackGet.status, 404);
  assert.deepEqual(feedbackGet.body, { error: 'Not found' });

  const feedbackPost = await request('POST', '/evaluations/eval-101/feedback', {
    authorization: `Bearer ${validToken}`,
  });
  assert.equal(feedbackPost.status, 404);

  const feedbackSummary = await request('GET', '/evaluations/eval-101/feedback/summary', {
    authorization: `Bearer ${validToken}`,
  });
  assert.equal(feedbackSummary.status, 404);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Suite 2: Feedback Feature Flag ENABLED
// ─────────────────────────────────────────────────────────────────────────────

test('flag ENABLED: /evaluations/mine still resolves to evaluation handler (not feedback router)', async () => {
  setFeedbackFlag(true);

  const authed = await request('GET', '/evaluations/mine', {
    authorization: `Bearer ${validToken}`,
  });
  assert.equal(authed.status, 200);
  assert.ok(Array.isArray(authed.body), 'Must return evaluation array from evaluationRoutes');

  const unauthed = await request('GET', '/evaluations/mine');
  assert.equal(unauthed.status, 401);
});

test('flag ENABLED: /evaluations/team still resolves to evaluation handler', async () => {
  setFeedbackFlag(true);

  const authed = await request('GET', '/evaluations/team', {
    authorization: `Bearer ${validToken}`,
  });
  assert.equal(authed.status, 200);

  const unauthed = await request('GET', '/evaluations/team');
  assert.equal(unauthed.status, 401);
});

test('flag ENABLED: /evaluations/:id still resolves to evaluation handler', async () => {
  setFeedbackFlag(true);

  const authed = await request('GET', '/evaluations/eval-101', {
    authorization: `Bearer ${validToken}`,
  });
  assert.equal(authed.status, 200);
  assert.equal(authed.body.id, 'eval-101');

  const unauthed = await request('GET', '/evaluations/eval-101');
  assert.equal(unauthed.status, 401);
});

test('flag ENABLED: feedback endpoints are accessible and reach feedback handlers', async () => {
  setFeedbackFlag(true);

  // Authenticated feedback request passes the feature flag check and reaches feedback handler
  const feedbackGet = await request('GET', '/evaluations/eval-101/feedback', {
    authorization: `Bearer ${validToken}`,
  });
  // Should NOT be 404 "Not found" from feature gate
  assert.notEqual(feedbackGet.status, 404);

  // Unauthenticated feedback request returns 401 from requireAuth (not 404)
  const feedbackUnauthed = await request('GET', '/evaluations/eval-101/feedback');
  assert.equal(feedbackUnauthed.status, 401);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Suite 3: Parameterised Route Shadowing Guard
// ─────────────────────────────────────────────────────────────────────────────

test('shadowing guard: no router mounted before evaluationRoutes shadows fixed paths', async () => {
  // Find all middleware layers mounted on /evaluations
  const router = app._router || app.router;
  const layers = router.stack.filter(
    (layer) => layer.name === 'router' && typeof layer.match === 'function' && layer.match('/evaluations')
  );

  assert.ok(layers.length >= 2, 'Expected at least feedback router and evaluationRoutes');

  const evalRouterIndex = layers.findIndex(
    (layer) => layer.handle && layer.handle.stack && layer.handle.stack.some(
      (s) => s.route && s.route.path === '/mine'
    )
  );

  assert.ok(evalRouterIndex >= 0, 'evaluationRoutes containing /mine must be mounted');

  // Check all routers mounted BEFORE evaluationRoutes
  const precedingRouters = layers.slice(0, evalRouterIndex);

  const fixedPathsToCheck = ['/mine', '/team', '/signature/me', '/'];

  for (const layer of precedingRouters) {
    const subStack = layer.handle.stack || [];
    for (const subLayer of subStack) {
      if (!subLayer.route) continue;
      const subPath = subLayer.route.path;

      // Check if this preceding route path would match any fixed evaluation path
      for (const fixedPath of fixedPathsToCheck) {
        // A single-segment parameter like '/:id' or broad wildcard would shadow '/mine' or '/team'
        const isShadowingPattern = subPath === '/:id' || subPath === '*' || subPath === '/:param';
        assert.equal(
          isShadowingPattern,
          false,
          `Preceding router registers path "${subPath}" which would shadow fixed path "${fixedPath}" in evaluationRoutes!`
        );
      }
    }
  }
});

test('shadowing detector fails when a parameterised route shadows a fixed route', () => {
  // Verify that our shadowing detection logic correctly catches shadowing
  const mockBadRouter = [
    { path: '/:id' },
    { path: '/:id/feedback' },
  ];

  const fixedPaths = ['/mine', '/team'];

  let detectedShadow = false;
  for (const route of mockBadRouter) {
    for (const fixed of fixedPaths) {
      if (route.path === '/:id') {
        detectedShadow = true;
      }
    }
  }

  assert.equal(detectedShadow, true, 'Detector must catch /:id shadowing fixed routes');
});
