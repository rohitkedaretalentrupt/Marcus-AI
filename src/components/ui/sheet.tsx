"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils/cn";

/**
 * Side drawer built on the Radix Dialog primitive: focus trap, Escape to
 * close, scroll lock, `aria-modal` and focus restoration come for free.
 */
function Sheet(props: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/75" />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "pl-safe fixed inset-y-0 left-0 z-50 flex h-full w-[85vw] max-w-80 flex-col border-r bg-background pt-safe pb-safe shadow-lg outline-none",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close conversations"
          className="absolute top-[calc(var(--safe-top)+0.375rem)] right-1.5 inline-flex size-11 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <X className="size-5" aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

const SheetTitle = DialogPrimitive.Title;
const SheetDescription = DialogPrimitive.Description;

export { Sheet, SheetContent, SheetDescription, SheetTitle };
