// ─────────────────────────────────────────────────────────────────────────────
//  src/server.js
//  Express app bootstrap.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express from 'express';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import cycleRoutes from './routes/cycles.js';
import evaluationRoutes from './routes/evaluations.js';

const app = express();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());

// CORS — adjust origins for production
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth',        authRoutes);
app.use('/users',       userRoutes);
app.use('/cycles',      cycleRoutes);
app.use('/evaluations', evaluationRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(err);

  // Postgres check-constraint / trigger violations
  if (err.code === '23514' || err.severity === 'ERROR') {
    return res.status(422).json({ error: err.message });
  }

  // Unique constraint
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Duplicate value — resource already exists.' });
  }

  res.status(500).json({ error: 'Internal server error.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`evaluation-api listening on port ${PORT}`);
});

export default app; // for test imports
