import "server-only";

import type { Prisma } from "@prisma/client";
import { AuthError, type SessionUser } from "@/lib/auth";

/**
 * Multi-tenant scoping rules (Gate 1 — tenant isolation):
 *
 *  - SYSTEM_ADMIN, GROUP_IT_MANAGER, EXEC_STAKEHOLDER: global visibility.
 *  - SITE_IT_LEAD: sees only (a) projects of their own site and (b) published
 *    GROUP-scope projects (read-only group standards). Writes are limited to
 *    their own site's projects.
 *
 * Every Prisma read on tenant-owned entities MUST compose one of these
 * where-fragments; every write MUST pass an assert*() guard first.
 */

export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
}

export function isGroupScoped(user: SessionUser): boolean {
  return (
    user.role === "SYSTEM_ADMIN" ||
    user.role === "GROUP_IT_MANAGER" ||
    user.role === "EXEC_STAKEHOLDER"
  );
}

export function canWrite(user: SessionUser): boolean {
  return user.role !== "EXEC_STAKEHOLDER";
}

/** Where-fragment restricting Project reads to the caller's tenant. */
export function projectReadScope(user: SessionUser): Prisma.ProjectWhereInput {
  if (isGroupScoped(user)) return {};
  if (!user.siteId) {
    // A site lead with no site assignment can see nothing site-scoped.
    return { scopeType: "GROUP" };
  }
  return {
    OR: [{ siteId: user.siteId }, { scopeType: "GROUP" }],
  };
}

/** Where-fragment for entities reached through their parent project. */
export function throughProjectScope(user: SessionUser): Prisma.ProjectWhereInput {
  return projectReadScope(user);
}

/** Assert the caller may WRITE to a project belonging to (scopeType, siteId). */
export function assertProjectWrite(
  user: SessionUser,
  project: { scopeType: "GROUP" | "SITE"; siteId: string | null }
): void {
  if (!canWrite(user)) {
    throw new ForbiddenError("Executive stakeholders have read-only access");
  }
  if (isGroupScoped(user)) return;
  // Site leads: only their own site's SITE projects.
  if (project.scopeType === "GROUP") {
    throw new ForbiddenError("Site IT Leads cannot modify Group-scope projects");
  }
  if (!user.siteId || project.siteId !== user.siteId) {
    throw new ForbiddenError("Cannot modify projects outside your assigned site");
  }
}

/** Assert the caller may create a project with the given scope. */
export function assertProjectCreate(
  user: SessionUser,
  scopeType: "GROUP" | "SITE",
  siteId: string | null
): void {
  if (!canWrite(user)) {
    throw new ForbiddenError("Executive stakeholders have read-only access");
  }
  if (scopeType === "GROUP") {
    if (!isGroupScoped(user)) {
      throw new ForbiddenError("Only Group IT can create Group-scope projects");
    }
    return;
  }
  if (!siteId) {
    throw new ForbiddenError("SITE-scope projects require a siteId");
  }
  if (!isGroupScoped(user) && user.siteId !== siteId) {
    throw new ForbiddenError("Site IT Leads can only create projects for their own site");
  }
}

/** Steering-committee actions (RAG override, scope approval, meeting decisions). */
export function assertSteeringAuthority(user: SessionUser): void {
  if (user.role !== "GROUP_IT_MANAGER" && user.role !== "SYSTEM_ADMIN") {
    throw new ForbiddenError("Only Group IT Managers can perform steering-committee actions");
  }
}

export function assertAdmin(user: SessionUser): void {
  if (user.role !== "SYSTEM_ADMIN") {
    throw new ForbiddenError("Administrator access required");
  }
}

/** Map RBAC/auth errors to a safe user-facing message; rethrow the rest. */
export function toActionError(err: unknown): { ok: false; error: string } {
  if (err instanceof ForbiddenError || err instanceof AuthError) {
    return { ok: false, error: err.message };
  }
  // Never leak internal error details (SQL, stack traces) to the client.
  console.error("[action-error]", err);
  return { ok: false, error: "An unexpected error occurred. Please retry." };
}
