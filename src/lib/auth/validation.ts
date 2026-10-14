import { z } from "zod";

/**
 * Shared by the client forms (instant feedback) and the server (the only
 * validation that counts).
 *
 * Password policy follows NIST SP 800-63B: a length minimum and no
 * composition rules. A breached-password check is a later hardening step.
 */

export const PASSWORD_MIN_LENGTH = 10;
/** Upper bound protects the hasher from multi-megabyte "passwords". */
export const PASSWORD_MAX_LENGTH = 128;
export const NAME_MAX_LENGTH = 100;
const EMAIL_MAX_LENGTH = 254;

/** Emails are compared and stored trimmed + lower-cased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const emailSchema = z
  .string({ error: "Enter your email address." })
  .trim()
  .min(1, "Enter your email address.")
  .max(EMAIL_MAX_LENGTH, "Email address is too long.")
  .pipe(z.email("Enter a valid email address."))
  .transform(normalizeEmail);

export const newPasswordSchema = z
  .string({ error: "Enter a password." })
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);

export const registerSchema = z
  .object({
    name: z
      .string({ error: "Enter your name." })
      .trim()
      .min(1, "Enter your name.")
      .max(NAME_MAX_LENGTH, `Name must be at most ${NAME_MAX_LENGTH} characters.`),
    email: emailSchema,
    password: newPasswordSchema,
    confirmPassword: z.string({ error: "Confirm your password." }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match.",
  });

/**
 * Login deliberately does not enforce the current password policy: accounts
 * created under an older policy must still be able to sign in.
 */
export const loginSchema = z.object({
  email: emailSchema,
  password: z
    .string({ error: "Enter your password." })
    .min(1, "Enter your password.")
    .max(PASSWORD_MAX_LENGTH, "Invalid email or password."),
});

export type RegisterInput = z.input<typeof registerSchema>;
export type RegisterData = z.output<typeof registerSchema>;
export type LoginInput = z.input<typeof loginSchema>;
export type LoginData = z.output<typeof loginSchema>;
