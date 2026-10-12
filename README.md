# evaluation-api

Real Express + PostgreSQL backend for the CPP Group Evaluation app.  
Pairs with the `evaluation` Vite frontend (same repository root, separate `evaluation-api/` folder).

---

## Prerequisites
- Node.js 22 +
- A [Neon](https://neon.tech) Postgres database (free tier is fine)

---

## Setup

```bash
cd evaluation-api
npm install

# Copy the env template and fill in your Neon connection string + JWT secret
cp .env.example .env
# Edit .env — set DATABASE_URL and JWT_SECRET

# Run migrations (creates all tables and triggers)
npm run migrate

# Start the dev server (restarts on file changes)
npm run dev
```

The server listens on **port 4000** by default (`PORT` in `.env`).

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon Postgres connection string |
| `JWT_SECRET` | ✅ | At least 64 random bytes |
| `PORT` | optional | Default `4000` |
| `CORS_ORIGIN` | optional | Allowed origin, default `*` |

---

## API surface

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/login` | — | Login, returns JWT |
| GET | `/auth/me` | Bearer | Current user |
| GET | `/users` | admin | List all users |
| GET | `/users/:id` | self/admin | Get user |
| PATCH | `/users/:id` | admin | Update user (role/supervisor/name…) |
| POST | `/users/:id/deactivate` | admin | Deactivate + optional departure |
| POST | `/users/:id/activate` | admin | Re-activate |
| POST | `/users/reassign-all` | admin | Atomic bulk reassignment |
| GET | `/cycles` | any | List cycles |
| POST | `/cycles` | admin | Open a new quarter (`period`, `starts_on`, `ends_on`) |
| POST | `/cycles/:period/open-self-assessment` | admin | Open self-assessment for a period |
| POST | `/cycles/:cycleId/add-user` | admin | Add late joiner |
| GET | `/evaluations` | auth | Team/all evaluations |
| GET | `/evaluations/mine` | auth | My evaluation |
| GET | `/evaluations/:id` | auth | Single evaluation |
| PATCH | `/evaluations/:id/reassign-supervisor` | admin | Reassign one evaluation's supervisor |
| POST | `/evaluations/:id/open-self-assessment` | admin | Force open self-assessment on one eval |
| POST | `/evaluations/:id/waive-self-assessment` | admin | Waive (needs departure record) |
| POST | `/evaluations/:id/goals-on-behalf` | admin | Enter goals on behalf (needs departure) |
| POST | `/evaluations/:id/waive-employee-sig` | admin | Waive employee signature (needs departure) |
| POST | `/evaluations/:id/sign` | auth | Sign an evaluation slot |
| GET | `/health` | — | `{ ok: true }` |

---

## Step 7b integrity rules

| Rule | Enforced at |
|---|---|
| Waived signature requires departure record | App layer + DB trigger `trg_waiver_requires_departure` |
| Waived self-assessment requires departure | App layer + DB trigger `trg_waived_sa_requires_departure` |
| Goals entered on behalf require departure | App layer + DB trigger `trg_goals_on_behalf_requires_departure` |
| `reassignAllFrom` is one atomic transaction | `SELECT … FOR UPDATE NOWAIT` + `BEGIN/COMMIT` |
| Deactivation checks run inside locked transaction | `SELECT … FOR UPDATE NOWAIT` on target + their evals |
| Role/supervisor/active changes bump `token_version` | `UPDATE users SET token_version = token_version + 1` |
| No emergency override for stuck evaluations | Not implemented |

---

## Tests

```bash
# Point tests at a real Neon DB (can be the same DB — tests use TRUNCATE to reset)
export DATABASE_URL="postgresql://..."
export JWT_SECRET="test-secret"

npm test
```

The test suite in `tests/concurrent.test.js` covers:
1. Concurrent deactivation of the last super_admin (only one may succeed)
2. `reassignAllFrom` atomicity (failure leaves nothing changed)
3. Waived signature without departure record (app + DB trigger rejection)
4. Departed employee end-to-end (deactivate → waive SA → waive sig)
5. Deactivated user's session rejected on next request (token_version invalidation)

---

## Schema migrations

Migrations live in `migrations/` as plain `.sql` files, tracked in `schema_migrations`.  
Run `npm run migrate` to apply any pending migrations.
