import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify, SignJWT } from "jose";

/**
 * Edge middleware: route protection + silent access-token rotation.
 *
 * Access tokens live 15 minutes. When one expires but its `refreshUntil`
 * claim (7-day window, fixed at login) is still open, the middleware mints a
 * fresh 15-minute token, forwards it on the request, and sets it on the
 * response — no user-visible interruption. Revocation stays effective because
 * getSession() re-validates the user (isActive) against the DB per request.
 */

const SESSION_COOKIE = "opspm_session";
const ACCESS_TTL_SECONDS = 15 * 60;

const PUBLIC_PATHS = ["/login", "/api/escalations", "/api/audit-retention", "/api/auth/oidc"];
const PUBLIC_FILES = ["/favicon.ico", "/sw.js", "/manifest.webmanifest", "/icon.svg"];

function getSecret(): Uint8Array | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return new TextEncoder().encode(secret);
}

interface TokenState {
  ok: boolean;
  refreshedToken?: string;
}

async function checkToken(token: string, secret: Uint8Array): Promise<TokenState> {
  try {
    await jwtVerify(token, secret, { algorithms: ["HS256"] });
    return { ok: true };
  } catch {
    // Possibly just expired — verify signature with tolerance, then check the
    // refresh window before minting a replacement.
    try {
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ["HS256"],
        clockTolerance: 60 * 60 * 24 * 8, // signature check only; window enforced below
      });
      const nowSec = Math.floor(Date.now() / 1000);
      const refreshUntil = typeof payload.refreshUntil === "number" ? payload.refreshUntil : 0;
      if (!payload.sub || refreshUntil <= nowSec) return { ok: false };

      const refreshed = await new SignJWT({
        email: payload.email,
        name: payload.name,
        role: payload.role,
        siteId: payload.siteId,
        refreshUntil,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(payload.sub)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
        .sign(secret);
      return { ok: true, refreshedToken: refreshed };
    } catch {
      return { ok: false };
    }
  }
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    PUBLIC_FILES.includes(pathname) ||
    pathname.startsWith("/_next")
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const secret = getSecret();

  if (token && secret) {
    const state = await checkToken(token, secret);
    if (state.ok) {
      if (!state.refreshedToken) return NextResponse.next();

      // Forward the rotated token to this request AND persist it client-side.
      const cookieHeader = req.cookies
        .getAll()
        .map((c) => `${c.name}=${c.name === SESSION_COOKIE ? state.refreshedToken : c.value}`)
        .join("; ");
      const headers = new Headers(req.headers);
      headers.set("cookie", cookieHeader);

      const res = NextResponse.next({ request: { headers } });
      res.cookies.set(SESSION_COOKIE, state.refreshedToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60,
        path: "/",
      });
      return res;
    }
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
