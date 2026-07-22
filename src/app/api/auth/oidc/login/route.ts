import { NextResponse } from "next/server";
import {
  buildAuthorizationUrl,
  generatePkce,
  generateState,
  getOidcConfig,
} from "@/lib/oidc";

export const dynamic = "force-dynamic";

/** Kicks off the OIDC authorization-code + PKCE flow against the corporate IdP. */
export async function GET(): Promise<NextResponse> {
  const config = getOidcConfig();
  if (!config) {
    return NextResponse.json({ error: "SSO is not configured" }, { status: 404 });
  }

  try {
    const state = generateState();
    const pkce = generatePkce();
    const authUrl = await buildAuthorizationUrl(config, state, pkce.challenge);

    const res = NextResponse.redirect(authUrl);
    res.cookies.set("oidc_tx", JSON.stringify({ state, verifier: pkce.verifier }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/api/auth/oidc",
    });
    return res;
  } catch (err) {
    console.error("[oidc] login initiation failed", err);
    return NextResponse.redirect(new URL("/login?error=sso", process.env.APP_URL ?? "http://localhost:3000"));
  }
}
