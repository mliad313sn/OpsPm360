import { SignJWT, jwtVerify } from "jose";

/**
 * Cryptographically signed deep links for notifications (SRS: deep-linked
 * dispatch). A link like  APP_URL/r?token=<JWT>  routes an authenticated user
 * straight to the exact record — the token only carries ROUTING data, never
 * authority: the resolver still runs the normal session + RLS checks, so a
 * leaked link is useless without a valid login.
 */

export type DeepLinkEntity = "PROJECT" | "BLOCKER" | "RISK" | "SCOPE_CHANGE" | "WAR_ROOM";

export interface DeepLinkPayload {
  entityType: DeepLinkEntity;
  entityId: string;
  /** Owning project id for child entities (anchors the target page). */
  projectId?: string;
}

const DEFAULT_TTL_SECONDS = 14 * 24 * 60 * 60; // links in email stay valid 14d

function encode(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signDeepLink(
  payload: DeepLinkPayload,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience("opspm360-deeplink")
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(encode(secret));
}

export async function verifyDeepLink(
  token: string,
  secret: string
): Promise<DeepLinkPayload | null> {
  try {
    const { payload } = await jwtVerify(token, encode(secret), {
      algorithms: ["HS256"],
      audience: "opspm360-deeplink",
    });
    const entityType = payload.entityType as DeepLinkEntity | undefined;
    const entityId = typeof payload.entityId === "string" ? payload.entityId : null;
    if (!entityType || !entityId) return null;
    return {
      entityType,
      entityId,
      projectId: typeof payload.projectId === "string" ? payload.projectId : undefined,
    };
  } catch {
    return null;
  }
}

/** In-app path a resolved deep link lands on (anchors highlight the record). */
export function deepLinkTargetPath(p: DeepLinkPayload): string {
  switch (p.entityType) {
    case "WAR_ROOM":
      return "/meeting";
    case "PROJECT":
      return `/projects/${p.entityId}`;
    case "BLOCKER":
      return p.projectId ? `/projects/${p.projectId}#blocker-${p.entityId}` : "/meeting";
    case "RISK":
      return p.projectId ? `/projects/${p.projectId}#risk-${p.entityId}` : "/";
    case "SCOPE_CHANGE":
      return p.projectId ? `/projects/${p.projectId}#scope-${p.entityId}` : "/";
  }
}

/** Full absolute URL for use in emails/webhooks. */
export async function buildDeepLinkUrl(
  payload: DeepLinkPayload,
  secret: string,
  appUrl: string
): Promise<string> {
  const token = await signDeepLink(payload, secret);
  return `${appUrl.replace(/\/$/, "")}/r?token=${encodeURIComponent(token)}`;
}
