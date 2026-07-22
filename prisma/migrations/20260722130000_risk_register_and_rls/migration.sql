-- Risk register (PMBOK probability x impact) with category + financial exposure
CREATE TYPE "RiskStatus" AS ENUM ('OPEN', 'MITIGATING', 'REALIZED', 'CLOSED');
CREATE TYPE "RiskCategory" AS ENUM ('FINANCIAL', 'TECHNICAL', 'SAFETY', 'SUPPLY_CHAIN', 'ENVIRONMENTAL', 'REGULATORY');
CREATE TYPE "DependencyType" AS ENUM ('FINISH_TO_START', 'START_TO_START', 'FINISH_TO_FINISH', 'START_TO_FINISH');

CREATE TABLE "Risk" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "raisedById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "RiskCategory" NOT NULL DEFAULT 'TECHNICAL',
    "probability" INTEGER NOT NULL,
    "impact" INTEGER NOT NULL,
    "potentialLossUSD" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "mitigation" TEXT,
    "contingencyPlan" TEXT,
    "status" "RiskStatus" NOT NULL DEFAULT 'OPEN',
    "materializedBlockerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Risk_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Risk_projectId_status_idx" ON "Risk"("projectId", "status");
CREATE UNIQUE INDEX "Risk_materializedBlockerId_key" ON "Risk"("materializedBlockerId");

ALTER TABLE "Risk" ADD CONSTRAINT "Risk_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_materializedBlockerId_fkey" FOREIGN KEY ("materializedBlockerId") REFERENCES "Blocker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Cross-project dependency DAG (cycle-checked in the application on write)
CREATE TABLE "ProjectDependency" (
    "id" TEXT NOT NULL,
    "predecessorProjectId" TEXT NOT NULL,
    "successorProjectId" TEXT NOT NULL,
    "dependencyType" "DependencyType" NOT NULL DEFAULT 'FINISH_TO_START',
    "lagDays" INTEGER NOT NULL DEFAULT 0,
    "isCrossSite" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectDependency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectDependency_predecessorProjectId_successorProjectId_key" ON "ProjectDependency"("predecessorProjectId", "successorProjectId");
CREATE INDEX "ProjectDependency_successorProjectId_idx" ON "ProjectDependency"("successorProjectId");

ALTER TABLE "ProjectDependency" ADD CONSTRAINT "ProjectDependency_predecessorProjectId_fkey" FOREIGN KEY ("predecessorProjectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectDependency" ADD CONSTRAINT "ProjectDependency_successorProjectId_fkey" FOREIGN KEY ("successorProjectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Postgres Row-Level Security: database-enforced tenant isolation.
--
-- The application sets two transaction-local GUCs on every request via
-- src/server/db.ts:
--   app.scope   = 'system' | 'group' | 'site'   (deny-by-default when unset)
--   app.site_id = <Site.id>                     (only meaningful for 'site')
--
-- FORCE ROW LEVEL SECURITY binds the table owner too, so the standard
-- docker-compose single-role setup is still protected. Queries that never set
-- the context (a forgotten scope fragment in new code) return ZERO rows
-- instead of leaking other tenants' data.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "Project" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Project" FORCE ROW LEVEL SECURITY;
CREATE POLICY "project_tenant_isolation" ON "Project"
  USING (
    current_setting('app.scope', true) IN ('system', 'group')
    OR (
      current_setting('app.scope', true) = 'site'
      AND (
        "scopeType" = 'GROUP'::"ScopeType"
        OR "siteId" = current_setting('app.site_id', true)
      )
    )
  )
  WITH CHECK (
    current_setting('app.scope', true) IN ('system', 'group')
    OR (
      current_setting('app.scope', true) = 'site'
      AND (
        "scopeType" = 'GROUP'::"ScopeType"
        OR "siteId" = current_setting('app.site_id', true)
      )
    )
  );

-- Child tables inherit visibility through their parent Project: the EXISTS
-- subquery is itself filtered by Project's RLS policy for the current context.
ALTER TABLE "ProjectFinancials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectFinancials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "financials_via_project" ON "ProjectFinancials"
  USING (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"));

ALTER TABLE "Milestone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Milestone" FORCE ROW LEVEL SECURITY;
CREATE POLICY "milestone_via_project" ON "Milestone"
  USING (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"));

ALTER TABLE "Blocker" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Blocker" FORCE ROW LEVEL SECURITY;
CREATE POLICY "blocker_via_project" ON "Blocker"
  USING (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"));

ALTER TABLE "Risk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Risk" FORCE ROW LEVEL SECURITY;
CREATE POLICY "risk_via_project" ON "Risk"
  USING (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"));

ALTER TABLE "ScopeChangeRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ScopeChangeRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "scopechange_via_project" ON "ScopeChangeRequest"
  USING (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"));

ALTER TABLE "MeetingDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MeetingDecision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "decision_via_project" ON "MeetingDecision"
  USING (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "projectId"));

-- Dependency edges are visible when EITHER endpoint is visible: a successor's
-- site lead must be able to see that an upstream (possibly other-site) project
-- gates their start. Predecessor details themselves remain governed by the
-- Project policy — an invisible predecessor resolves to null in joins.
ALTER TABLE "ProjectDependency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectDependency" FORCE ROW LEVEL SECURITY;
CREATE POLICY "dependency_via_either_project" ON "ProjectDependency"
  USING (
    EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "predecessorProjectId")
    OR EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "successorProjectId")
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "predecessorProjectId")
    AND EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "successorProjectId")
  );
