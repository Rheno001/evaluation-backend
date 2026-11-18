// ─────────────────────────────────────────────────────────────────────────────
//  test/feedbackRoutes.test.js
//  Unit tests for feedback routes with mocked data layer.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkFeedbackRateLimit,
  resetRateLimits,
  requireColleagueFeedbackFeature,
  isFeedbackFeatureEnabled,
} from '../src/routes/feedback.js';
import { isColleagueFeedbackEnabled } from '../src/routes/config.js';

test('feature flag: 404 gating when FEATURE_COLLEAGUE_FEEDBACK is off', () => {
  const originalEnv = process.env.FEATURE_COLLEAGUE_FEEDBACK;
  delete process.env.FEATURE_COLLEAGUE_FEEDBACK;

  assert.equal(isFeedbackFeatureEnabled(), false);
  assert.equal(isColleagueFeedbackEnabled(), false);

  let statusCalled = null;
  let jsonCalled = null;
  const mockRes = {
    status(s) {
      statusCalled = s;
      return this;
    },
    json(d) {
      jsonCalled = d;
      return this;
    },
  };
  let nextCalled = false;

  requireColleagueFeedbackFeature({}, mockRes, () => {
    nextCalled = true;
  });

  assert.equal(statusCalled, 404);
  assert.deepEqual(jsonCalled, { error: 'Not found' });
  assert.equal(nextCalled, false);

  // Restore env
  process.env.FEATURE_COLLEAGUE_FEEDBACK = originalEnv;
});

test('isolation: evaluationsFeedbackRouter does not intercept standard evaluation routes when flag is off', async () => {
  const originalEnv = process.env.FEATURE_COLLEAGUE_FEEDBACK;
  delete process.env.FEATURE_COLLEAGUE_FEEDBACK;

  const { evaluationsFeedbackRouter } = await import('../src/routes/feedback.js');

  // Verify router stack only contains routes matching /:id/feedback and /:id/feedback/summary
  for (const layer of evaluationsFeedbackRouter.stack) {
    if (layer.route) {
      assert.match(
        layer.route.path,
        /\/feedback/,
        `evaluationsFeedbackRouter route ${layer.route.path} must only target feedback endpoints`
      );
    }
  }

  process.env.FEATURE_COLLEAGUE_FEEDBACK = originalEnv;
});

test('rate limiting: allows up to 20 submissions per hour per user, blocks 21st', () => {
  resetRateLimits();
  const userId = 'user-test-rate';
  const baseTime = 1700000000000;

  for (let i = 0; i < 20; i++) {
    const allowed = checkFeedbackRateLimit(userId, baseTime + i * 1000);
    assert.equal(allowed, true, `Submission ${i + 1} should be allowed`);
  }

  // 21st submission within the hour
  const blocked = checkFeedbackRateLimit(userId, baseTime + 25000);
  assert.equal(blocked, false, '21st submission within the hour should be blocked');

  // After 1 hour has passed (3600001 ms)
  const afterHour = checkFeedbackRateLimit(userId, baseTime + 3600005);
  assert.equal(afterHour, true, 'Submission after an hour window should be allowed');

  resetRateLimits();
});

test('validation: strict schema rejects unknown fields in feedback payload', async () => {
  // Simulate POST /evaluations/:id/feedback validation via router stack
  const { evaluationsFeedbackRouter } = await import('../src/routes/feedback.js');
  process.env.FEATURE_COLLEAGUE_FEEDBACK = 'true';

  // Find the post handler
  const postLayer = evaluationsFeedbackRouter.stack.find(
    (s) => s.route && s.route.path === '/:id/feedback' && s.route.methods.post
  );
  assert.ok(postLayer, 'POST /:id/feedback route layer should exist');

  const handler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

  // Payload with unknown property "maliciousField"
  const payloadWithUnknown = {
    project: 'Core Platform',
    behaviour: 'teamwork',
    rating: 5,
    context: 'Pair programmed on auth',
    comment: 'Great peer support and clear architectural discussion throughout.',
    maliciousField: 'exploit',
  };

  let statusCalled = null;
  let jsonCalled = null;
  const mockReq = {
    params: { id: 'eval-123' },
    user: { id: 'colleague-1', role: 'employee' },
    body: payloadWithUnknown,
  };
  const mockRes = {
    status(s) {
      statusCalled = s;
      return this;
    },
    json(d) {
      jsonCalled = d;
      return this;
    },
  };

  await handler(mockReq, mockRes, () => {});

  assert.equal(statusCalled, 400);
  assert.equal(jsonCalled.error, 'Validation failed');
  assert.ok(jsonCalled.details.fieldErrors.maliciousField || jsonCalled.details.formErrors);
});

test('validation: field length boundaries enforced (project, context, comment)', async () => {
  const { evaluationsFeedbackRouter } = await import('../src/routes/feedback.js');
  process.env.FEATURE_COLLEAGUE_FEEDBACK = 'true';

  const postLayer = evaluationsFeedbackRouter.stack.find(
    (s) => s.route && s.route.path === '/:id/feedback' && s.route.methods.post
  );
  const handler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

  // Project too short (< 3 chars)
  let statusCalled = null;
  let jsonCalled = null;
  const mockRes = {
    status(s) {
      statusCalled = s;
      return this;
    },
    json(d) {
      jsonCalled = d;
      return this;
    },
  };

  await handler(
    {
      params: { id: 'eval-123' },
      user: { id: 'colleague-1', role: 'employee' },
      body: {
        project: 'ab', // too short
        behaviour: 'quality',
        context: 'Valid context line here',
        comment: 'Valid comment line here that is long enough.',
      },
    },
    mockRes,
    () => {}
  );
  assert.equal(statusCalled, 400);

  // Context too short (< 10 chars)
  await handler(
    {
      params: { id: 'eval-123' },
      user: { id: 'colleague-1', role: 'employee' },
      body: {
        project: 'Valid Project',
        behaviour: 'quality',
        context: 'Too short', // 9 chars
        comment: 'Valid comment line here that is long enough.',
      },
    },
    mockRes,
    () => {}
  );
  assert.equal(statusCalled, 400);

  // Comment too short (< 20 chars)
  await handler(
    {
      params: { id: 'eval-123' },
      user: { id: 'colleague-1', role: 'employee' },
      body: {
        project: 'Valid Project',
        behaviour: 'quality',
        context: 'Valid context line here',
        comment: 'Too short comment', // 17 chars
      },
    },
    mockRes,
    () => {}
  );
  assert.equal(statusCalled, 400);
});
