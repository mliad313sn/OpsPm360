# OpsPM360 — Endeavour Mining Group IT PPM Platform

Single source of truth for Group IT and Site IT project portfolios across corporate offices
(London/Abidjan) and remote West-African mine sites (Sabodala-Massawa, Ity, Houndé, Mana,
Boungou). Built offline-first for high-latency/unstable WAN links.

## Feature map

| Module | What it does |
|---|---|
| **Governance & IAM** | Role-based access (Group IT Manager, Site IT Lead, Exec Stakeholder, Sys Admin), strict tenant scoping (site leads see only their site + published Group projects), scrypt-hashed credentials, JWT sessions (12h), immutable COBIT 2019 audit trail on every state change |
| **PPM & Stage-Gate intake** | 5-step project wizard (context/site → COBIT 2019 checklist → CapEx/OpEx dual-currency financials → weighted milestones → review), auto-generated project codes (`HND-2026-003`), portfolio grid with instant RAG/text filters |
| **Offline delta-sync** | Dexie.js (IndexedDB) read cache + mutation outbox, optimistic UI, idempotent replay via client op UUIDs, `syncVersion` optimistic-concurrency conflict detection with server-authoritative rebase payloads, exponential backoff |
| **War Room** | Red/Amber-first steering view, presenter drawer (log decision / log blocker / override RAG with mandatory audited reason), meeting session ledger, one-click Markdown minutes generation |
| **RAG engine** | `0.40·schedule + 0.35·budget + 0.25·blocker` composite with hard rules: milestone >14d late → ≤AMBER; critical blocker open >7d → RED; budget variance >15% → RED. Null-safe, zero-division-safe, fully unit-tested |
| **Blocker SLA escalation** | Idempotent sweep: unresolved 48h → Group IT Manager, 120h → Group CIO; audit-logged, webhook notifications, cron-driven (`/api/escalations`) |
| **Financials** | USD base ledger with integer-cent arithmetic, XOF/EUR local display via stored FX rates, CapEx/OpEx variance reporting, scope-change approvals atomically re-baseline budget & schedule |

## Stack

Next.js 14 (App Router, Server Actions, Route Handlers) · TypeScript (strict, no `any`) ·
Prisma + PostgreSQL · Dexie.js · Tailwind CSS + shadcn-style components · Zod · jose · Vitest.

## Getting started

```bash
cp .env.example .env          # set DATABASE_URL, SESSION_SECRET (32+ chars), CRON_SECRET
npm install
npx prisma db push            # or: npx prisma migrate dev
npm run db:seed               # 6 sites, 8 users, sample portfolio
npm run dev
```

Seed login: `amara.kone@endeavourmining.com` / `Endeavour#2026` (Group IT Manager).
Site lead example: `lead.hnd@endeavourmining.com` (scoped to Houndé only).

Keyboard shortcuts: **D** dashboard · **M** war room · **N** new project.

### Quality gates

```bash
npm run typecheck   # strict TS, noUncheckedIndexedAccess, noUnusedLocals — 0 errors
npm test            # 41 unit tests: RAG engine, finance engine, SLA ladder
npm run build       # production build + next lint
```

### Simulating offline (Gate 2 validation)

1. Load the dashboard, then set DevTools → Network → Offline.
2. The grid falls back to the IndexedDB cache (amber “Offline — cached data” badge).
3. Raise a blocker from the war room drawer — it queues in the outbox (“N queued”).
4. Go back online: the outbox flushes automatically; duplicates are impossible
   (server-side `clientOpId` idempotency), stale edits come back as explicit conflicts.

### SLA sweep

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/escalations
```

## Deployment

### Docker (self-hosted / AWS ECS / on-prem site server)

```bash
echo "SESSION_SECRET=$(openssl rand -base64 48)" >> .env
echo "CRON_SECRET=$(openssl rand -base64 32)" >> .env
docker compose up --build
```

Compose runs Postgres 16, the app (auto-applies migrations), and a 15-minute SLA sweep
side-car. For AWS: push the image to ECR, run on ECS Fargate behind an ALB, use RDS
PostgreSQL Multi-AZ, store secrets in Secrets Manager, and schedule the sweep with
EventBridge → the `/api/escalations` endpoint.

### Vercel

1. Import the repo; set `DATABASE_URL` (e.g. Neon/RDS), `SESSION_SECRET`, `CRON_SECRET`,
   optionally `NOTIFY_WEBHOOK_URL`.
2. `vercel.json` already schedules the SLA sweep every 15 min — Vercel automatically sends
   `Authorization: Bearer $CRON_SECRET` when the `CRON_SECRET` env var is set.
3. Run `npx prisma migrate deploy` from CI (or a one-off shell) against the production DB.

### Production checklist

- [ ] Rotate seeded passwords / disable seed users
- [ ] `SESSION_SECRET` ≥ 48 random chars, distinct per environment
- [ ] TLS termination at the edge (cookies are `secure` in production)
- [ ] Point `NOTIFY_WEBHOOK_URL` at Slack/Teams incident channel
- [ ] Database backups + PITR (RDS/Neon)
- [ ] Optional: Redis-backed WebSocket fan-out for live meeting co-viewing (integration
      seam: revalidation already centralizes on server actions)

## Gap Audit & Self-Correction Log

Defects caught and corrected by the autonomous audit loop before delivery:

| ID | Gate | Severity | Defect | Correction |
|---|---|---|---|---|
| GAP-001 | 4 — Type safety | Low | Unused `Rag` import in `project-actions.tsx`; compiler not enforcing dead code | Removed import; enabled `noUnusedLocals` + `noUnusedParameters` |
| GAP-002 | 2 — Offline sync | **Medium** | Dexie `.limit().sortBy()` applied the limit in *index* order, so a >50-op outbox could replay mutations out of chronological order | Sort by `occurredAt` first, then slice the batch |
| GAP-003 | 3 — Workflows | Medium | `/api/escalations` only accepted POST; Vercel Cron invokes with GET, so scheduled sweeps would 405 | Shared handler exported for both GET and POST |
| GAP-004 | 4 — Resilience | Medium | No React error boundaries; a render error would white-screen the war room mid-meeting | Added `app/error.tsx` (with digest ref + offline reassurance) and `app/not-found.tsx` |
| GAP-005 | 3 — Workflows | Low | Escalations were persisted+audited but had no outbound notification seam | Added `lib/notify.ts` webhook dispatcher (non-throwing; delivery failure never rolls back the audited escalation) |

Design decisions verified during the audit (no change required):

- **Tenant isolation**: every read composes `projectReadScope()`; every write passes
  `assertProjectWrite/Create()`; `/api/sync` re-runs the same guards per queued op — an
  offline site lead cannot smuggle a write into another site's project.
- **Zero-division/null edges**: RAG engine returns healthy for *unknown* inputs (no
  milestones/financials) but RED for *provably bad* ones (spend against zero budget);
  all covered by tests.
- **Audit immutability**: `AuditLog` writes occur inside the same transaction as the
  mutation; the application exposes no update/delete path for audit rows.
- **Money math**: ledger arithmetic in integer cents (`0.1 + 0.2 = 0.3` exactly);
  FX rates validated positive at every conversion.
- **SLA idempotency**: sweep computes target level from age, never stacks increments —
  replayed cron ticks are no-ops (tested).

## Architecture notes

```
src/
├── app/                    # App Router pages + route handlers
│   ├── api/sync            # offline delta-sync (idempotent, conflict-aware)
│   ├── api/escalations     # cron-driven SLA sweep (GET/POST, bearer-secret)
│   ├── meeting             # War Room
│   └── projects/[id]|new   # detail + intake wizard
├── components/             # shadcn-style UI + feature components
├── lib/                    # pure engines: rag.ts, finance.ts, sla.ts (unit-tested)
│   ├── auth.ts             # scrypt + JWT sessions (server-only)
│   ├── rbac.ts             # tenant scoping fragments + write guards
│   └── audit.ts            # transactional COBIT audit writer
├── offline/                # Dexie schema, sync engine, React hook
└── server/                 # server actions (all mutations) + read models
```

The three business engines (`rag`, `finance`, `sla`) are pure functions with no I/O so the
governance math is testable and identical everywhere it runs.
