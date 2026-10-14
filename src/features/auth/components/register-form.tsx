"use client";

import { Check, Loader2 } from "lucide-react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { apiFetch, ApiRequestError } from "@/lib/api/client";
import { DEFAULT_AUTHENTICATED_PATH, LOGIN_PATH } from "@/lib/auth/routes";
import { PASSWORD_MIN_LENGTH, registerSchema } from "@/lib/auth/validation";
import { cn } from "@/lib/utils/cn";

import {
  apiFieldErrors,
  focusFirstInvalid,
  zodFieldErrors,
  type FieldErrors,
} from "../lib/form-errors";
import { FormField } from "./form-field";
import { PasswordInput } from "./password-input";

const FIELD_ORDER = ["name", "email", "password", "confirmPassword"];
const REGISTER_ENDPOINT = "/api/register";
const GENERIC_ERROR = "Unable to create account. Please try again.";

export function RegisterForm() {
  const router = useRouter();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [passwordLength, setPasswordLength] = useState(0);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setFormError(null);

    const input = {
      name: data.get("name"),
      email: data.get("email"),
      password: data.get("password"),
      confirmPassword: data.get("confirmPassword"),
    };
    const parsed = registerSchema.safeParse(input);
    if (!parsed.success) {
      const errors = zodFieldErrors(parsed.error);
      setFieldErrors(errors);
      focusFirstInvalid(form, errors, FIELD_ORDER);
      return;
    }
    setFieldErrors({});
    setPending(true);

    try {
      await apiFetch(REGISTER_ENDPOINT, { method: "POST", body: input });

      const result = await signIn("credentials", {
        email: parsed.data.email,
        password: parsed.data.password,
        redirect: false,
      });
      if (!result?.ok || result.error) {
        // Account exists but automatic sign-in failed; let the user sign in manually.
        router.replace(LOGIN_PATH);
        return;
      }
      router.replace(DEFAULT_AUTHENTICATED_PATH);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code !== "NETWORK") {
        const errors = apiFieldErrors(caught.issues);
        setFieldErrors(errors);
        setFormError(Object.keys(errors).length > 0 ? null : caught.message);
        focusFirstInvalid(form, errors, FIELD_ORDER);
      } else {
        setFormError(GENERIC_ERROR);
      }
      setPending(false);
    }
  }

  const meetsMinLength = passwordLength >= PASSWORD_MIN_LENGTH;

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-5" aria-busy={pending}>
      <FormAlert message={formError} />

      <FormField
        name="name"
        label="Name"
        type="text"
        autoComplete="name"
        autoCapitalize="words"
        required
        error={fieldErrors.name}
      />

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
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        error={fieldErrors.password}
        onChange={(event) => setPasswordLength(event.currentTarget.value.length)}
        hint={
          <p className={cn("flex items-center gap-1.5", meetsMinLength && "text-foreground")}>
            <Check
              className={cn("size-3.5", meetsMinLength ? "opacity-100" : "opacity-30")}
              aria-hidden="true"
            />
            At least {PASSWORD_MIN_LENGTH} characters. A passphrase of several words works well.
          </p>
        }
        renderInput={(props) => <PasswordInput {...props} />}
      />

      <FormField
        name="confirmPassword"
        label="Confirm password"
        autoComplete="new-password"
        required
        error={fieldErrors.confirmPassword}
        renderInput={(props) => <PasswordInput {...props} />}
      />

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        {pending ? "Creating account…" : "Create account"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href={LOGIN_PATH}
          className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline md:min-h-0"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
