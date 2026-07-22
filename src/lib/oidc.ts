import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * OIDC authorization-code + PKCE integration for corporate IdPs
 * (Microsoft Entra ID, Okta, Keycloak — anything exposing standard discovery).
 *
 * Enabled when OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET are set.
 * Users are matched by verified email against pre-provisioned accounts —
 * NO just-in-time provisioning: an unknown email is rejected, so the IdP
 * cannot mint OpsPM360 authority that an admin never granted.
 */

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getOidcConfig(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const appUrl = process.env.APP_URL;
  if (!issuer || !clientId || !clientSecret || !appUrl) return null;
  return {
    issuer: issuer.replace(/\/$/, ""),
    clientId,
    clientSecret,
    redirectUri: `${appUrl.replace(/\/$/, "")}/api/auth/oidc/callback`,
  };
}

export function oidcEnabled(): boolean {
  return getOidcConfig() !== null;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

let discoveryCache: { value: Discovery; expiresAt: number } | null = null;

export async function discover(config: OidcConfig): Promise<Discovery> {
  if (discoveryCache && discoveryCache.expiresAt > Date.now()) return discoveryCache.value;
  const res = await fetch(`${config.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
  const value = (await res.json()) as Discovery;
  discoveryCache = { value, expiresAt: Date.now() + 60 * 60 * 1000 };
  return value;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

export async function buildAuthorizationUrl(
  config: OidcConfig,
  state: string,
  codeChallenge: string
): Promise<string> {
  const meta = await discover(config);
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Exchange the code, validate the ID token against the IdP's JWKS, return the verified email. */
export async function exchangeAndVerify(
  config: OidcConfig,
  code: string,
  codeVerifier: string
): Promise<{ email: string } | null> {
  const meta = await discover(config);

  const tokenRes = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenRes.ok) {
    console.error(`[oidc] token exchange failed: HTTP ${tokenRes.status}`);
    return null;
  }
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return null;

  if (!jwks) jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
  try {
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: meta.issuer,
      audience: config.clientId,
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
    // Entra ID sometimes carries the email in preferred_username.
    const fallback =
      typeof payload.preferred_username === "string" &&
      payload.preferred_username.includes("@")
        ? payload.preferred_username.toLowerCase()
        : null;
    const resolved = email ?? fallback;
    return resolved ? { email: resolved } : null;
  } catch (err) {
    console.error("[oidc] id_token validation failed", err);
    return null;
  }
}
