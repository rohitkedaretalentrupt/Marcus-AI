"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormAlert } from "@/components/ui/form-alert";
import { ApiRequestError } from "@/lib/api/client";
import { TEMPLATES_PATH } from "@/lib/templates/routes";
import type { TemplateSummary } from "@/lib/templates/types";

import { listTemplates, selectConversationTemplate } from "../lib/template-api";

interface SelectTemplateDialogProps {
  conversationId: string;
  currentTemplateId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

/** Choose which analysed client template this conversation should use for formatting later. */
export function SelectTemplateDialog(props: SelectTemplateDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent onCloseAutoFocus={props.onCloseAutoFocus}>
        {props.open ? <SelectTemplateForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function SelectTemplateForm({
  conversationId,
  currentTemplateId,
  onOpenChange,
}: SelectTemplateDialogProps) {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [selected, setSelected] = useState<string>(currentTemplateId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listTemplates()
      .then(
        (all) => !cancelled && setTemplates(all.filter((template) => template.status === "READY")),
      )
      .catch(() => !cancelled && setError("Couldn't load your templates."));
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await selectConversationTemplate(conversationId, selected || null);
      router.refresh();
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.displayMessage : "Couldn't save. Try again.",
      );
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Client template</DialogTitle>
        <DialogDescription>
          Choose the template for this conversation. To produce the Word document, use ⋮ → Format
          resume…
        </DialogDescription>
      </DialogHeader>
      <FormAlert message={error} />

      {templates === null && !error ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading templates…
        </p>
      ) : null}

      {templates ? (
        <fieldset className="grid gap-1">
          <legend className="sr-only">Templates</legend>
          {[{ id: "", name: "No template" }, ...templates].map((template) => (
            <label
              key={template.id || "none"}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-accent"
            >
              <input
                type="radio"
                name="template"
                value={template.id}
                checked={selected === template.id}
                onChange={() => setSelected(template.id)}
                className="size-4 accent-primary"
              />
              <span className="truncate text-sm">{template.name}</span>
            </label>
          ))}
          {templates.length === 0 ? (
            <p className="px-2 text-sm text-muted-foreground">
              No analysed templates yet.{" "}
              <Link
                href={TEMPLATES_PATH}
                className="text-primary underline-offset-4 hover:underline"
              >
                Add one
              </Link>
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={saving}>
            Cancel
          </Button>
        </DialogClose>
        <Button onClick={save} disabled={saving || templates === null}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </div>
  );
}
