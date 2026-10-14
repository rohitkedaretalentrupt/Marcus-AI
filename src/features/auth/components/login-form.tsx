"use client";

import { Loader2 } from "lucide-react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { AUTH_ERROR_CODES, getAuthErrorMessage } from "@/lib/auth/errors";
import { REGISTER_PATH } from "@/lib/auth/routes";
import { loginSchema } from "@/lib/auth/validation";

import { focusFirstInvalid, zodFieldErrors, type FieldErrors } from "../lib/form-errors";
import { FormAlert } from "@/components/ui/form-alert";
import { FormField } from "./form-field";
import { PasswordInput } from "./password-input";

const FIELD_ORDER = ["email", "password"];

interface LoginFormProps {
  /** Already validated as a same-origin path by the page. */
  callbackPath: string;
  initialError?: string | null;
}

export function LoginForm({ callbackPath, initialError = null }: LoginFormProps) {
  const router = useRouter();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(initialError);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setFormError(null);

    const parsed = loginSchema.safeParse({
      email: data.get("email"),
      password: data.get("password"),
    });
    if (!parsed.success) {
      const errors = zodFieldErrors(parsed.error);
      setFieldErrors(errors);
      focusFirstInvalid(form, errors, FIELD_ORDER);
      return;
    }
    setFieldErrors({});
    setPending(true);

    try {
      const result = await signIn("credentials", { ...parsed.data, redirect: false });
      if (!result?.ok || result.error) {
        setFormError(getAuthErrorMessage(result?.error ?? AUTH_ERROR_CODES.UNAVAILABLE));
        setPending(false);
        return;
      }
      router.replace(callbackPath);
      router.refresh();
    } catch {
      setFormError(getAuthErrorMessage(AUTH_ERROR_CODES.UNAVAILABLE));
      setPending(false);
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-5" aria-busy={pending}>
      <FormAlert message={formError} />

      <FormField
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        inputMode="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        error={fieldErrors.email}
      />

      <FormField
        name="password"
        label="Password"
        autoComplete="current-password"
        required
        error={fieldErrors.password}
        renderInput={(props) => <PasswordInput {...props} />}
      />

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        {pending ? "Signing in…" : "Sign in"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        New here?{" "}
        <Link
          href={REGISTER_PATH}
          className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline md:min-h-0"
        >
          Create an account
        </Link>
      </p>
    </form>
  );
}
