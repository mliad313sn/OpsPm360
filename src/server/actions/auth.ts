"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession, verifyPassword } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { loginSchema } from "@/lib/validators";
import { hit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/request-ip";

export interface AuthFormState {
  error: string | null;
}

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "Enter a valid email and password (min 8 characters)." };
  }

  // Brute-force protection: 5 attempts / 15 min per IP+account pair, plus a
  // wider per-IP ceiling across accounts.
  const ip = getClientIp() ?? "unknown";
  const perAccount = hit(`login:${ip}:${parsed.data.email}`, 5, 15 * 60_000);
  const perIp = hit(`login-ip:${ip}`, 30, 15 * 60_000);
  if (!perAccount.allowed || !perIp.allowed) {
    const wait = Math.max(perAccount.retryAfterSeconds, perIp.retryAfterSeconds);
    return { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` };
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  // Uniform failure message — no account-existence oracle.
  const failure = { error: "Invalid credentials." };
  if (!user || !user.isActive) return failure;

  const valid = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!valid) return failure;

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
  });

  // Deep-link continuation: only same-origin app paths are honored.
  const next = formData.get("next");
  const target =
    typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  redirect(target);
}

export async function logoutAction(): Promise<void> {
  destroySession();
  redirect("/login");
}
