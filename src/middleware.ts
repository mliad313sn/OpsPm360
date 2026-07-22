import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

/**
 * Edge middleware: coarse route protection. Verifies the session JWT signature
 * and expiry (no DB access at the edge — full user re-validation happens in
 * getSession() on the server). Unauthenticated traffic is redirected to /login.
 */

const PUBLIC_PATHS = ["/login", "/api/escalations"];

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/sw.js" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/icon.svg"
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get("opspm_session")?.value;
  if (token) {
    const secret = process.env.SESSION_SECRET;
    if (secret && secret.length >= 32) {
      try {
        await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
        return NextResponse.next();
      } catch {
        // fall through to redirect/401
      }
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
