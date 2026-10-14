import type { ChatMessage } from "@/lib/chat/types";

export type DeliveryStatus = "sent" | "sending" | "failed";

/** A message as rendered: persisted ones are "sent"; unsent ones carry a temporary client id. */
export interface DisplayMessage extends ChatMessage {
  status: DeliveryStatus;
  /** Present only for messages not yet confirmed by the server. */
  clientId?: string;
}
