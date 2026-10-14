import type { Metadata } from "next";

import { AuthPageHeader } from "@/features/auth/components/auth-page-header";
import { LoginForm } from "@/features/auth/components/login-form";
import { getAuthErrorMessage } from "@/lib/auth/errors";
import { CALLBACK_URL_PARAM, safeCallbackPath } from "@/lib/auth/routes";

export const metadata: Metadata = {
  title: "Sign in",
};

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const callbackPath = safeCallbackPath(firstValue(params[CALLBACK_URL_PARAM]));
  // Auth.js redirects here with `?error=<code>` for failures outside the form.
  const initialError = getAuthErrorMessage(firstValue(params.error));

  return (
    <>
      <AuthPageHeader title="Sign in" description="Welcome back. Sign in to your account." />
      <LoginForm callbackPath={callbackPath} initialError={initialError} />
    </>
  );
}
