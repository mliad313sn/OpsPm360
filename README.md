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
| **War Room** | Red/Amber-first steering view, presenter drawer (log decision / log blocker / override RAG with mandatory audited reason), meeting session ledger, Markdown minutes + printable PDF minutes page |
| **RAG engine** | `H = 100·(0.40·schedule + 0.35·budget + 0.25·blocker)`; bands GREEN ≥80, AMBER 60–79, RED <60; hard rules: milestone >14d late → ≤AMBER; budget variance >10% → ≤AMBER, >20% → RED; critical blocker open >7d → RED. Null-safe, zero-division-safe, fully unit-tested |
| **Stage-Gate engine** | Five COBIT gates with mandatory exit checklists (business case, InfoSec, vendor risk, EA alignment, training, SLA docs, asset tagging); advancement is blocked until every item is confirmed; each snapshot is persisted and audited |
| **EVA** | Milestone-weighted Earned Value Analysis per project: PV / EV / AC, SV / CV, SPI / CPI on the financial ledger |
| **Kanban board** | `/board` — stage-gate columns with RAG-sorted project cards for site-level execution tracking (shortcut **B**) |
| **Blocker SLA escalation** | Idempotent sweep: unresolved 48h → Group IT Manager, 120h → Group CIO; audit-logged, webhook notifications, cron-driven (`/api/escalations`) |
| **Financials** | USD base ledger with integer-cent arithmetic, XOF/EUR local display via stored FX rates, CapEx/OpEx variance reporting, scope-change approvals atomically re-baseline budget & schedule |

## Stack

Next.js 14 (App Router, Server Actions, Route Handlers) · TypeScript (strict, no `any`) ·
Prisma + PostgreSQL · Dexie.js · Tailwind CSS + shadcn-style components · Zod · jose · Vitest.

**Design system:** "Slate & Indigo Enterprise" (Stitch) — light slate surfaces with Indigo 700
primary actions, tonal layers + 1px slate borders instead of shadows, Hanken Grotesk headlines /
Inter body / JetBrains Mono for codes-labels-timestamps, pill status chips with dots, RAG
priority stripes on table rows, fixed sidebar + top-bar shell, 1280px max content width.

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

Keyboard shortcuts: **D** dashboard · **B** board · **M** war room · **N** new project.

### Quality gates

```bash
npm run typecheck   # strict TS, noUncheckedIndexedAccess, noUnusedLocals — 0 errors
npm test            # unit tests: RAG engine, finance/EVA engine, SLA ladder, stage gates
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

## SRS compliance matrix

Alignment with the Master SRS & Architecture Blueprint:

| SRS requirement | Status | Notes |
|---|---|---|
| M1 RBAC (4 roles) + multi-tenant scoping | ✅ | `rbac.ts` where-fragments on every read; write guards on every mutation |
| M1 audit trail (timestamp, user, IP, old/new state) | ✅ | Client IP auto-captured from forwarded headers in `writeAudit` |
| M2 intake wizard + COBIT stage-gate engine | ✅ | 5 gates with enforced exit checklists (`lib/gates.ts`, `advanceGateAction`) |
| M3 multi-currency ledger (USD base, EUR/XOF) + SAP WBS | ✅ | Integer-cent math, validated FX rates |
| M3 Earned Value Analysis (PV/EV/AC) | ✅ | `computeEva` incl. SV/CV/SPI/CPI, milestone-weighted |
| M3 Kanban execution view | ✅ | `/board` grouped by stage gate |
| M3 Gantt + CPM, resource capacity matrix | 🔶 Roadmap | Milestone list with dates shipped; CPM/resource heatmaps are a follow-on epic |
| M4 offline cache + optimistic UI + delta sync queue | ✅ | Dexie outbox, UUID idempotency, ≤50-op batches |
| M4 LWW conflict resolution w/ server timestamps | ✅ | On version conflict: newer offline edit wins (clock-capped); older loses and receives authoritative state to rebase; both outcomes logged |
| M5 War Room + H∈[0,100] RAG (80/60 bands, 10%/20% variance) | ✅ | Exact SRS formula and thresholds, unit-tested |
| M5 RAG override w/ mandatory justification + PDF minutes | ✅ | Printable minutes page (browser save-as-PDF) + Markdown export |
| M6 48h/120h SLA escalation + War Room flagging | ✅ | Idempotent sweep, webhook notifications, RAG refresh |
| M6 scope change impact (Δ USD / Δ days) + approval | ✅ | Approval atomically re-baselines budget & target end date |
| NFR TLS 1.3 / AES-256 at rest | ✅ (infra) | Terminate TLS at the edge; enable storage encryption on RDS/Neon volumes |
| NFR Redis pub/sub live meeting sync | 🔶 Roadmap | Server actions centralize revalidation as the integration seam |

Deliberate improvements over the SRS Prisma blueprint (kept intentionally):
`Decimal(16,2)` instead of `Float` for money (audit-grade precision), `siteId` nullable so
GROUP projects don't need a fake site row, blocker `escalationLevel` enum + `SyncMutationLog`
for idempotent replay, scoped `ApprovalStatus` on scope changes instead of a lone boolean,
and scrypt password hashes on `User`.

## Tier-1 Enterprise upgrade pass

Implemented in response to the enterprise deep-assessment (P0/P1 items):

- **Postgres Row-Level Security**: FORCE-enabled policies on the whole project tree
  (Project + financials, milestones, blockers, risks, scope changes, decisions,
  dependency edges). Every query runs through `withUserDb`/`withSystemDb`, which set
  transaction-local context GUCs; a query that skips the wrapper sees zero rows —
  tenant leaks fail closed. App-level scope fragments remain as a second layer.
- **Identity**: 15-minute access JWTs with a 7-day sliding refresh window (silent
  rotation in edge middleware); **OIDC SSO** (Entra ID/Okta/Keycloak) with PKCE,
  discovery, JWKS validation, and no JIT provisioning — IdP authenticates,
  OpsPM360 authorizes. Enabled via `OIDC_*` env vars.
- **Explicit sync conflict resolution**: last-write-wins removed. Version clashes
  surface in the Sync Tray with a local-vs-server field diff and Keep Mine
  (rebase + re-send under a fresh idempotency key) / Keep Theirs choices.
  Per-field manual merge: roadmap.
- **Risk register** (PMBOK): categorized risks with probability × impact scoring,
  financial exposure (USD), mitigation/contingency plans, and one-click
  materialization into an SLA-tracked blocker (linked both ways).
- **Cross-project dependencies**: FS/SS/FF/SF edges with lag, cross-site flagging,
  full-graph cycle rejection (DFS, inside the write transaction), a dependency
  impact rail in the War Room, and RAG cascade to downstream projects on approved
  schedule shifts (dates are never auto-shifted — successors re-baseline explicitly).
- **RAG engine upgrades**: CPI/SPI < 0.85 caps at AMBER; ≥2 unmitigated high risks
  force RED; active risk exposure >25% of budget caps at AMBER; budget-weighted
  **Portfolio Health** indicator on the dashboard.
- **Financial forecasting**: CPI-trend EAC / ETC / VAC on every project ledger.
- **Compliance operations**: `/api/audit-retention` archives audit rows older than
  `AUDIT_RETENTION_DAYS` as NDJSON to `ARCHIVE_WEBHOOK_URL` and purges only after
  successful archive; War-Room decisions dispatch to the notification webhook.
- **Accessibility**: skip-link, landmarks, aria-live feedback, `:focus-visible`,
  `prefers-reduced-motion`, and a high-contrast mode for bright field conditions.

## Gap Audit & Self-Correction Log

Defects caught and corrected by the autonomous audit loop before delivery:

| ID | Gate | Severity | Defect | Correction |
|---|---|---|---|---|
| GAP-001 | 4 — Type safety | Low | Unused `Rag` import in `project-actions.tsx`; compiler not enforcing dead code | Removed import; enabled `noUnusedLocals` + `noUnusedParameters` |
| GAP-002 | 2 — Offline sync | **Medium** | Dexie `.limit().sortBy()` applied the limit in *index* order, so a >50-op outbox could replay mutations out of chronological order | Sort by `occurredAt` first, then slice the batch |
| GAP-003 | 3 — Workflows | Medium | `/api/escalations` only accepted POST; Vercel Cron invokes with GET, so scheduled sweeps would 405 | Shared handler exported for both GET and POST |
| GAP-004 | 4 — Resilience | Medium | No React error boundaries; a render error would white-screen the war room mid-meeting | Added `app/error.tsx` (with digest ref + offline reassurance) and `app/not-found.tsx` |
| GAP-005 | 3 — Workflows | Low | Escalations were persisted+audited but had no outbound notification seam | Added `lib/notify.ts` webhook dispatcher (non-throwing; delivery failure never rolls back the audited escalation) |
| GAP-006 | SRS M5 | **Medium** | RAG bands/thresholds deviated from the SRS (0–1 score, 0.75/0.5 bands, 15% RED variance) | Realigned to H∈[0,100], GREEN ≥80 / AMBER ≥60, variance >10% → ≤AMBER, >20% → RED; tests updated |
| GAP-007 | SRS M2 | **Medium** | `currentGate` was a free label — no enforcement of gate-exit checklists | Stage-gate engine with per-gate mandatory items; advancement blocked until all confirmed; snapshot persisted + audited |
| GAP-008 | SRS M3 | Medium | No Earned Value Analysis | `computeEva` (PV/EV/AC/SV/CV/SPI/CPI) with zero-division and zero-weight guards, tested, on project ledger |
| GAP-009 | SRS M4 | Medium | Conflict policy was strict server-wins, not the specified LWW | Version conflicts now resolve last-write-wins on server timestamps (future-dated client clocks capped at now); losing side still gets rebase state |
| GAP-010 | SRS M1 | Low | `AuditLog.ipAddress` column existed but was never populated | `writeAudit` auto-captures `x-forwarded-for` / `x-real-ip` |
| GAP-011 | Deploy | **P0** | No `prisma/migrations` baseline — `migrate deploy` on a fresh DB created no schema | Baseline `0_init` migration generated from the schema; CI drift check added |
| GAP-012 | Offline | **P0** | No service worker — a page reload while offline failed to boot the app | `sw.js` (cache-first static assets, network-first navigations with cache fallback), PWA manifest + icon, registration in shell, `no-cache` header on the worker |
| GAP-013 | Security | **P1** | `recalculateRag` exported from a `"use server"` module — an unauthenticated client-invokable endpoint | Moved to `server/rag-service.ts` (server-only, non-action) |
| GAP-014 | Security | **P1** | Login endpoint had no brute-force protection | Sliding-window rate limiter: 5/15min per IP+account, 30/15min per IP (tested) |
| GAP-015 | Security | **P1** | Minutes page showed all decisions to any authenticated user | Decisions filtered to the caller's tenant scope |
| GAP-016 | Integrity | P2 | Offline blocker timestamps trusted unboundedly — SLA clock could be backdated to force instant CIO escalation | `occurredAt` clamped to `[now − 7d, now]` on sync |
| GAP-017 | UX | P2 | Conflicted/rejected sync ops were a dead-end badge with no review path | Sync tray: inspect queue, see server verdicts, discard reviewed ops |
| GAP-018 | Process | P2 | No CI — quality gates ran only manually | GitHub Actions: typecheck, tests, build+lint, migration drift check |

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
