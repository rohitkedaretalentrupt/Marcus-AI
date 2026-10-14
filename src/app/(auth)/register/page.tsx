import type { Metadata } from "next";

import { AuthPageHeader } from "@/features/auth/components/auth-page-header";
import { RegisterForm } from "@/features/auth/components/register-form";

export const metadata: Metadata = {
  title: "Create account",
};

export default function RegisterPage() {
  return (
    <>
      <AuthPageHeader
        title="Create your account"
        description="Format resumes to your clients' templates from any device."
      />
      <RegisterForm />
    </>
  );
}
