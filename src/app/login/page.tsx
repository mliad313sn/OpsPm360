"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Mountain } from "lucide-react";
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

export default function LoginPage(): JSX.Element {
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
        <CardContent>
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
