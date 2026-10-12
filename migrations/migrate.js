// ─────────────────────────────────────────────────────────────────────────────
//  migrations/migrate.js
//  Runs all pending *.sql files in order, tracks applied migrations in
//  schema_migrations table. Safe to run multiple times (idempotent).
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    // Ensure tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows: applied } = await client.query(
      'SELECT filename FROM schema_migrations'
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    const files = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  skip  ${file}`);
        continue;
      }
      console.log(`  apply ${file} …`);
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`  ✓     ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log('\nMigrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
