import { oidcEnabled } from "@/lib/oidc";
import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string };
}): JSX.Element {
  // Only same-origin app paths are honored (never protocol-relative //host).
  const next =
    searchParams.next && searchParams.next.startsWith("/") && !searchParams.next.startsWith("//")
      ? searchParams.next
      : null;
  return (
    <LoginForm
      ssoEnabled={oidcEnabled()}
      ssoError={searchParams.error?.startsWith("sso") ? searchParams.error : null}
      next={next}
    />
  );
}
