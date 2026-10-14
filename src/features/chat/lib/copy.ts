/** Status line under the composer. */
export const COMPOSER_FOOTNOTE_AI_OFF =
  "Your messages are saved. AI responses aren't connected yet.";
export const COMPOSER_FOOTNOTE_AI_ON = "AI replies can contain mistakes. Check important details.";

export function composerFootnote(aiEnabled: boolean): string {
  return aiEnabled ? COMPOSER_FOOTNOTE_AI_ON : COMPOSER_FOOTNOTE_AI_OFF;
}

export const SEND_FAILED_MESSAGE = "Message couldn't be sent. Try again.";
export const REPLY_FAILED_MESSAGE = "The assistant is unavailable right now. Please try again.";
