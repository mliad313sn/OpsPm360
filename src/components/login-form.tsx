"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Building2, Mountain } from "lucide-react";
import { loginAction, type AuthFormState } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function SubmitButton(): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </Button>
  );
}

const initialState: AuthFormState = { error: null };

export function LoginForm({
  ssoEnabled,
  ssoError,
}: {
  ssoEnabled: boolean;
  ssoError: string | null;
}): JSX.Element {
  const [state, formAction] = useFormState(loginAction, initialState);

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Mountain className="h-8 w-8 text-primary" aria-hidden />
          <CardTitle className="text-lg">OpsPM360</CardTitle>
          <p className="text-xs text-muted-foreground">
            Endeavour Mining Group — IT Project Portfolio
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {ssoEnabled ? (
            <>
              <a
                href="/api/auth/oidc/login"
                className="meta flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-card text-sm font-medium hover:bg-secondary"
              >
                <Building2 className="h-4 w-4" aria-hidden />
                Sign in with corporate SSO
              </a>
              {ssoError ? (
                <p role="alert" className="text-xs text-rag-red">
                  {ssoError === "sso-unknown-user"
                    ? "Your identity was verified, but no OpsPM360 account exists for it. Ask an administrator to provision you."
                    : "SSO sign-in failed. Try again or use credentials."}
                </p>
              ) : null}
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                <span className="h-px flex-1 bg-border" /> or{" "}
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          ) : null}
          <form action={formAction} className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Email</span>
              <Input
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@endeavourmining.com"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Password</span>
              <Input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
              />
            </label>
            {state.error ? (
              <p role="alert" className="text-xs text-rag-red">
                {state.error}
              </p>
            ) : null}
            <SubmitButton />
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
