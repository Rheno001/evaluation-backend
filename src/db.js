// ─────────────────────────────────────────────────────────────────────────────
//  src/db.js
//  pg Pool singleton + query helpers.
// ─────────────────────────────────────────────────────────────────────────────

import pg from 'pg';

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

export { pool };
