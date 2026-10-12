// ─────────────────────────────────────────────────────────────────────────────
//  src/routes/auth.js
//  POST /auth/login   GET /auth/me
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { signToken, requireAuth } from '../auth.js';

const router = Router();

// POST /auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    const { rows } = await query(
      `SELECT id, name, email, password_hash, role, department, position,
              avatar_initials, supervisor_id, active, token_version
       FROM users WHERE lower(email) = lower($1)`,
      [email.trim()]
    );
    const user = rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!user.active) {
      return res.status(401).json({ error: 'Account is deactivated.' });
    }

    const token = signToken(user);
    const { password_hash: _, token_version: __, ...safeUser } = user;
    return res.json({ token, user: safeUser });
  } catch (err) {
    next(err);
  }
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
