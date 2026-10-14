export const NEW_CHAT_PATH = "/chat";

export function conversationPath(conversationId: string): string {
  return `${NEW_CHAT_PATH}/${encodeURIComponent(conversationId)}`;
}

export const CONVERSATIONS_API = "/api/conversations";

export function conversationApi(conversationId: string): string {
  return `${CONVERSATIONS_API}/${encodeURIComponent(conversationId)}`;
}

export function conversationMessagesApi(conversationId: string): string {
  return `${conversationApi(conversationId)}/messages`;
}
