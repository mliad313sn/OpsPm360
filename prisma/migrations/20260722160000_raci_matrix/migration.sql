-- RACI accountability matrix (generic entity attachment; PROJECT first)
CREATE TYPE "RaciRole" AS ENUM ('R', 'A', 'C', 'I');

CREATE TABLE "RaciAssignment" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RaciRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RaciAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RaciAssignment_entityType_entityId_userId_role_key"
  ON "RaciAssignment"("entityType", "entityId", "userId", "role");
CREATE INDEX "RaciAssignment_entityType_entityId_idx"
  ON "RaciAssignment"("entityType", "entityId");

-- RACI integrity: exactly ONE Accountable (A) per entity, enforced by the DB.
CREATE UNIQUE INDEX "raci_single_accountable"
  ON "RaciAssignment"("entityType", "entityId")
  WHERE "role" = 'A';

ALTER TABLE "RaciAssignment" ADD CONSTRAINT "RaciAssignment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation: PROJECT-attached assignments follow the Project policy.
-- Unknown entity types are invisible until an explicit policy covers them.
ALTER TABLE "RaciAssignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RaciAssignment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "raci_via_project" ON "RaciAssignment"
  USING (
    "entityType" = 'PROJECT'
    AND EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "entityId")
  )
  WITH CHECK (
    "entityType" = 'PROJECT'
    AND EXISTS (SELECT 1 FROM "Project" p WHERE p."id" = "entityId")
  );
