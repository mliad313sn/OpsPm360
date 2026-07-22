import { oidcEnabled } from "@/lib/oidc";
import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

export default function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}): JSX.Element {
  return (
    <LoginForm
      ssoEnabled={oidcEnabled()}
      ssoError={searchParams.error?.startsWith("sso") ? searchParams.error : null}
    />
  );
}
