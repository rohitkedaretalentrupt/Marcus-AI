import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { TemplateDetailView } from "@/features/templates/components/template-detail-view";
import { requireUser } from "@/lib/auth/session";
import { TEMPLATES_PATH } from "@/lib/templates/routes";
import { getTemplate } from "@/server/templates/template-service";

interface TemplatePageProps {
  params: Promise<{ templateId: string }>;
}

/** Owner-scoped: another user's template is indistinguishable from a missing one. */
const loadTemplate = cache(async (templateId: string) => {
  const user = await requireUser();
  return getTemplate(user.id, templateId);
});

export async function generateMetadata({ params }: TemplatePageProps): Promise<Metadata> {
  const template = await loadTemplate((await params).templateId);
  return { title: template?.name ?? "Template not found" };
}

export default async function TemplatePage({ params }: TemplatePageProps) {
  const template = await loadTemplate((await params).templateId);
  if (!template) notFound();

  return (
    <PageContainer width="narrow" className="flex flex-1 flex-col gap-6 py-6 sm:py-10">
      <Link
        href={TEMPLATES_PATH}
        className="-ml-1 inline-flex min-h-11 w-fit items-center gap-1 rounded-md px-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        All templates
      </Link>
      <PageHeader title={template.name} />
      <TemplateDetailView template={template} />
    </PageContainer>
  );
}
