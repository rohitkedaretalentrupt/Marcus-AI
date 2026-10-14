import { LayoutTemplate } from "lucide-react";
import type { Metadata } from "next";

import { EmptyState } from "@/components/layout/empty-state";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { NewTemplateDialog } from "@/features/templates/components/new-template-dialog";
import { TemplateList } from "@/features/templates/components/template-list";
import { isAIEnabled } from "@/lib/ai/provider";
import { isStorageEnabled } from "@/lib/storage/provider";
import { requireUser } from "@/lib/auth/session";
import { listTemplates } from "@/server/templates/template-service";

export const metadata: Metadata = { title: "Client templates" };

export default async function TemplatesPage() {
  const user = await requireUser();
  const templates = await listTemplates(user.id);
  const aiEnabled = isAIEnabled();
  const storageEnabled = isStorageEnabled();

  return (
    <PageContainer width="narrow" className="flex flex-1 flex-col gap-6 py-6 sm:py-10">
      <PageHeader
        title="Client templates"
        actions={<NewTemplateDialog disabled={!storageEnabled} />}
      />
      {!storageEnabled ? (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          Template uploads need file storage to be configured.
        </p>
      ) : !aiEnabled ? (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          You can upload templates now. They will be analysed once the AI service is configured.
        </p>
      ) : null}
      {templates.length === 0 ? (
        <EmptyState
          icon={<LayoutTemplate className="size-6" />}
          title="No templates yet"
          description="Upload a PDF or DOCX template from a client to get started."
        />
      ) : (
        <TemplateList templates={templates} />
      )}
    </PageContainer>
  );
}
