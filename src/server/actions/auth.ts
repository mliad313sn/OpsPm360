"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession, verifyPassword } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { loginSchema } from "@/lib/validators";

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

  redirect("/");
}

export async function logoutAction(): Promise<void> {
  destroySession();
  redirect("/login");
}
