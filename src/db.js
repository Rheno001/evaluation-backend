// ─────────────────────────────────────────────────────────────────────────────
//  src/db.js
//  pg Pool singleton + query helpers.
// ─────────────────────────────────────────────────────────────────────────────

import pg from 'pg';
import bcrypt from 'bcryptjs';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon serverless recommends max 1 connection per serverless function but
  // for a traditional Express server 10 is fine.
  max: 10,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error:', err);
});

/**
 * Run a single query on a pool connection.
 * @param {string} text
 * @param {unknown[]} [params]
 */
export async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

/**
 * Obtain a dedicated client for multi-statement transactions.
 * Caller MUST call client.release() when done.
 */
export async function getClient() {
  return pool.connect();
}

export async function ensureDefaultAdmin() {
  try {
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS raw_password TEXT');

    const email = 'admin@cppgroup.com';
    const passwordHash = await bcrypt.hash('123456', 10);

    await query(
      `INSERT INTO users (
        id, name, email, password_hash, raw_password, role, department, position,
        avatar_initials, active, start_date, token_version
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, CURRENT_DATE, 0)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         password_hash = EXCLUDED.password_hash,
         raw_password = EXCLUDED.raw_password,
         role = EXCLUDED.role,
         department = EXCLUDED.department,
         position = EXCLUDED.position,
         avatar_initials = EXCLUDED.avatar_initials,
         active = EXCLUDED.active,
         start_date = EXCLUDED.start_date,
         token_version = EXCLUDED.token_version`,
      ['u-admin', 'Admin', email, passwordHash, '123456', 'admin', 'Administration', 'Administrator', 'A']
    );
  } catch (error) {
    console.error('Failed to ensure default admin account exists:', error);
  }
}

export { pool };
