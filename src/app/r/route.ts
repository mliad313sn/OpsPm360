import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { deepLinkTargetPath, verifyDeepLink } from "@/lib/deeplink";

export const dynamic = "force-dynamic";

/**
 * Deep-link resolver. The token routes; the session authorizes. An
 * unauthenticated visitor is bounced to login with the deep link preserved,
 * so after signing in they land exactly on the record the email referenced.
 * RLS still governs what the resolved page actually shows.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const base = process.env.APP_URL ?? req.nextUrl.origin;
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.redirect(new URL("/", base));

  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return NextResponse.redirect(new URL("/", base));

  const payload = await verifyDeepLink(token, secret);
  if (!payload) return NextResponse.redirect(new URL("/?link=expired", base));

  const target = deepLinkTargetPath(payload);

  const session = await getSession();
  if (!session) {
    const login = new URL("/login", base);
    login.searchParams.set("next", target);
    return NextResponse.redirect(login);
  }

  return NextResponse.redirect(new URL(target, base));
}
