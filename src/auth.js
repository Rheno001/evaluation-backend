// ─────────────────────────────────────────────────────────────────────────────
//  src/auth.js
//  JWT sign/verify + session middleware with token_version invalidation.
// ─────────────────────────────────────────────────────────────────────────────

import jwt from 'jsonwebtoken';
import { query } from './db.js';

const SECRET = process.env.JWT_SECRET || 'insecure-dev-secret';
const EXPIRES_IN = '15m';

/**
 * Sign a JWT for the given user row.
 * Payload stores token_version so the server can invalidate old tokens.
 *
 * @param {{ id: string, name: string, role: string, token_version: number }} user
 * @returns {string}
 */
export function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, role: user.role, tv: user.token_version },
    SECRET,
    { expiresIn: EXPIRES_IN }
  );
}

/**
 * Express middleware: verify JWT and check token_version against DB.
 * Attaches req.user = { id, name, role } on success.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated. Please sign in.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: 'Not authenticated. Please sign in.' });
  }

  // Check token_version against DB to catch invalidated sessions
  try {
    const { rows } = await query(
      'SELECT id, name, role, active, token_version FROM users WHERE id = $1',
      [payload.id]
    );
    const dbUser = rows[0];

    if (!dbUser) {
      return res.status(401).json({ error: 'Not authenticated. Please sign in.' });
    }

    if (!dbUser.active) {
      return res.status(401).json({ error: 'Account is deactivated.' });
    }

    if (dbUser.token_version !== payload.tv) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    req.user = { id: dbUser.id, name: dbUser.name, role: dbUser.role };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Returns a middleware that requires one of the listed roles.
 * @param {...string} roles
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated. Please sign in.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: admins only.' });
    }
    next();
  };
}
