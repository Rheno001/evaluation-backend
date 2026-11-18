// ─────────────────────────────────────────────────────────────────────────────
//  src/routes/config.js
//  Client feature flag & system config endpoint.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import { requireAuth } from '../auth.js';

const router = Router();

export function isColleagueFeedbackEnabled() {
  return process.env.FEATURE_COLLEAGUE_FEEDBACK === 'true' || process.env.FEATURE_COLLEAGUE_FEEDBACK === '1';
}

router.get('/', requireAuth, (req, res) => {
  res.json({ colleagueFeedback: isColleagueFeedbackEnabled() });
});

export default router;
