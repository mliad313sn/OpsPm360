import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { exchangeAndVerify, getOidcConfig } from "@/lib/oidc";

export const dynamic = "force-dynamic";

function loginRedirect(reason: string): NextResponse {
  const base = process.env.APP_URL ?? "http://localhost:3000";
  const res = NextResponse.redirect(new URL(`/login?error=${reason}`, base));
  res.cookies.delete("oidc_tx");
  return res;
}

/** OIDC redirect target: validates state + PKCE, maps the verified email to a
 * pre-provisioned account, and opens a first-party session. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const config = getOidcConfig();
  if (!config) return loginRedirect("sso");

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const txCookie = req.cookies.get("oidc_tx")?.value;
  if (!code || !state || !txCookie) return loginRedirect("sso");

  let tx: { state?: string; verifier?: string };
  try {
    tx = JSON.parse(txCookie) as { state?: string; verifier?: string };
  } catch {
    return loginRedirect("sso");
  }
  if (!tx.state || !tx.verifier || tx.state !== state) return loginRedirect("sso");

  const identity = await exchangeAndVerify(config, code, tx.verifier);
  if (!identity) return loginRedirect("sso");

  const user = await prisma.user.findUnique({ where: { email: identity.email } });
  if (!user || !user.isActive) {
    // No JIT provisioning: the IdP authenticates, OpsPM360 authorizes.
    return loginRedirect("sso-unknown-user");
  }

  await createSession({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    siteId: user.siteId,
  });
  await writeAudit({
    userId: user.id,
    action: "LOGIN",
    entityType: "User",
    entityId: user.id,
    next: { method: "oidc-sso" },
  });

  const base = process.env.APP_URL ?? "http://localhost:3000";
  const res = NextResponse.redirect(new URL("/", base));
  res.cookies.delete("oidc_tx");
  return res;
}
