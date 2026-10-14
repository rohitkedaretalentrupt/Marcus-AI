import "server-only";

import { z } from "zod";

import { NotImplementedError } from "@/lib/errors/app-error";

import { aiFillPlanSchema } from "@/lib/formatting/fill-plan";
import { aiFormattingPlanSchema } from "@/lib/formatting/plan";
import { clientTemplateStructureSchema } from "@/lib/templates/structure";

import { AIProviderError, parseModelJson } from "../../errors";
import { buildFillMessages } from "../../prompts/fill-prompt";
import { buildFormattingMessages } from "../../prompts/formatting-prompt";
import { buildResumeTaskMessages, type PromptMessage } from "../../prompts/resume-task-prompt";
import { buildTemplateAnalysisMessages } from "../../prompts/template-analysis-prompt";
import { resumeTaskOutputSchema } from "../../schemas";
import type { AIProvider, AIRequestOptions } from "../../types";

/** Documented defaults: https://mimo.mi.com/docs (OpenAI-compatible API). */
export const MIMO_DEFAULTS = {
  baseUrl: "https://api.xiaomimimo.com/v1",
  model: "mimo-v2.6-pro",
} as const;

/**
 * MiMo through OpenRouter (AI_BASE_URL=https://openrouter.ai/api/v1): same
 * OpenAI-compatible API, but OpenRouter names the model differently and uses
 * `max_tokens` / `reasoning` instead of `max_completion_tokens` / `thinking`.
 */
export const OPENROUTER_DEFAULTS = { model: "xiaomi/mimo-v2.6-pro" } as const;

export function isOpenRouter(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith("openrouter.ai");
  } catch {
    return false;
  }
}

export interface MimoConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs: number;
  maxOutputTokens: number;
  thinking: "enabled" | "disabled";
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Only the fields we use; everything else in the response is ignored. */
const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

/** One Server-Sent Event of a streamed completion (only the fields we use). */
const streamEventSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().nullable().optional() }).nullish(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  /** OpenRouter reports mid-stream failures this way. */
  error: z.object({ code: z.union([z.number(), z.string()]).nullish() }).nullish(),
});

function parseStreamEvent(data: string): z.infer<typeof streamEventSchema> {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw new AIProviderError("invalid_response", "MiMo stream event was not JSON");
  }
  const parsed = streamEventSchema.safeParse(json);
  if (!parsed.success)
    throw new AIProviderError("invalid_response", "Unexpected MiMo stream event");
  return parsed.data;
}

const TEMPERATURE = 0.3;
/** Longest streamed reply kept; the stream is stopped there. */
const STREAM_MAX_CHARS = 20_000;
/** Hard cap on one streamed reply (the idle timeout is AI_TIMEOUT_MS). */
const STREAM_MAX_MS = 300_000;
const MAX_CORRECTION_ISSUES = 15;
const MAX_ECHOED_REPLY_CHARS = 20_000;

function errorForStatus(status: number): AIProviderError {
  if (status === 401 || status === 403)
    return new AIProviderError("auth", `MiMo rejected credentials (${status})`, status);
  if (status === 429) return new AIProviderError("rate_limited", "MiMo rate limit reached", status);
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new AIProviderError("bad_request", `MiMo rejected the request (${status})`, status);
  }
  return new AIProviderError("unavailable", `MiMo returned ${status}`, status);
}

/**
 * MiMo through its OpenAI-compatible Chat Completions API. Structured output
 * is requested in the prompt (the API documents no JSON mode) and every reply
 * is parsed and validated with Zod; one retry is made on invalid output.
 * Errors never include the API key, the prompt or the model output.
 */
export function createMimoProvider(config: MimoConfig): AIProvider {
  const baseUrl = (config.baseUrl ?? MIMO_DEFAULTS.baseUrl).replace(/\/+$/, "");
  const viaOpenRouter = isOpenRouter(baseUrl);
  const model = config.model ?? (viaOpenRouter ? OPENROUTER_DEFAULTS.model : MIMO_DEFAULTS.model);
  const doFetch = config.fetch ?? fetch;

  function requestBody(messages: PromptMessage[], stream: boolean): string {
    return JSON.stringify({
      model,
      messages,
      temperature: TEMPERATURE,
      stream,
      ...(viaOpenRouter
        ? {
            max_tokens: config.maxOutputTokens,
            // Reasoning text is never used; exclude it from the response either way.
            reasoning: { enabled: config.thinking === "enabled", exclude: true },
          }
        : {
            max_completion_tokens: config.maxOutputTokens,
            thinking: { type: config.thinking },
          }),
    });
  }

  async function complete(messages: PromptMessage[], options?: AIRequestOptions): Promise<string> {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: requestBody(messages, false),
        signal,
      });
    } catch (error) {
      if (timeout.aborted)
        throw new AIProviderError("timeout", `MiMo did not respond within ${config.timeoutMs} ms`);
      if (options?.signal?.aborted) throw error;
      throw new AIProviderError("unavailable", "MiMo request failed (network)");
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw errorForStatus(response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AIProviderError("invalid_response", "MiMo response was not JSON");
    }
    const parsed = completionSchema.safeParse(body);
    if (!parsed.success)
      throw new AIProviderError("invalid_response", "Unexpected MiMo response shape");

    const choice = parsed.data.choices[0]!;
    if (choice.finish_reason === "content_filter") {
      throw new AIProviderError("content_filter", "MiMo filtered the response");
    }
    if (choice.finish_reason === "length") {
      throw new AIProviderError("invalid_response", "MiMo response was truncated (length)");
    }
    const content = choice.message.content?.trim();
    if (!content) throw new AIProviderError("invalid_response", "MiMo returned empty content");
    // reasoning_content (thinking) is deliberately ignored: never shown or stored.
    return content;
  }

  /**
   * Streams a completion (Server-Sent Events, OpenAI format) and yields the
   * answer text as it arrives. `timeoutMs` is an idle limit — it restarts
   * whenever bytes arrive (OpenRouter sends keep-alive comments while the
   * model thinks) — and the whole stream is capped at STREAM_MAX_MS.
   * Reasoning deltas are ignored. Stopping early (consumer `return()` or the
   * caller's signal) cancels the upstream request.
   */
  async function* streamCompletion(
    messages: PromptMessage[],
    options?: AIRequestOptions,
  ): AsyncGenerator<string> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<string> | undefined;
    // Aborting also ends a pending read, whatever the fetch implementation does.
    const cancel = (reason?: unknown) => {
      controller.abort(reason);
      void reader?.cancel().catch(() => {});
    };
    let timedOut = false;
    const expire = () => {
      timedOut = true;
      cancel();
    };
    let idle = setTimeout(expire, config.timeoutMs);
    const total = setTimeout(expire, Math.max(config.timeoutMs * 5, STREAM_MAX_MS));
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(expire, config.timeoutMs);
    };
    const callerSignal = options?.signal;
    const onAbort = () => cancel(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    if (callerSignal?.aborted) onAbort();

    const failure = (error: unknown): unknown => {
      if (timedOut) return new AIProviderError("timeout", "MiMo stream went idle or ran too long");
      if (callerSignal?.aborted) return callerSignal.reason ?? error;
      return new AIProviderError("unavailable", "MiMo stream failed (network)");
    };

    try {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: requestBody(messages, true),
          signal: controller.signal,
        });
      } catch (error) {
        throw failure(error);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw errorForStatus(response.status);
      }
      if (!response.body) throw new AIProviderError("invalid_response", "MiMo sent no stream");
      reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

      let buffer = "";
      let produced = 0;
      let finished = false; // the model said it is done ([DONE] or a finish_reason)
      while (!finished) {
        let chunk: ReadableStreamReadResult<string>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw failure(error);
        }
        if (chunk.done) break;
        touch();
        buffer += chunk.value;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue; // blank lines, ": keep-alive" comments
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            finished = true;
            break;
          }
          const event = parseStreamEvent(data);
          if (event.error) {
            const status = Number(event.error.code);
            throw Number.isInteger(status) && status >= 400
              ? errorForStatus(status)
              : new AIProviderError("unavailable", "MiMo reported a stream error");
          }
          const choice = event.choices?.[0];
          const text = choice?.delta?.content;
          if (text) {
            const room = STREAM_MAX_CHARS - produced;
            yield text.slice(0, room);
            if (timedOut || callerSignal?.aborted) throw failure(undefined);
            produced += text.length;
            if (produced >= STREAM_MAX_CHARS) finished = true;
          }
          const reason = choice?.finish_reason;
          if (reason === "content_filter") {
            throw new AIProviderError("content_filter", "MiMo filtered the response");
          }
          if (reason === "error") {
            throw new AIProviderError("unavailable", "MiMo stopped with an error");
          }
          // "stop" or "length" (output-token limit): the answer is as complete as it gets.
          if (reason) finished = true;
          if (finished) break;
        }
      }
      if (!finished) {
        if (timedOut || callerSignal?.aborted) throw failure(undefined);
        throw new AIProviderError("unavailable", "MiMo stream ended before the reply finished");
      }
      if (produced === 0)
        throw new AIProviderError("invalid_response", "MiMo returned empty content");
    } finally {
      clearTimeout(idle);
      clearTimeout(total);
      callerSignal?.removeEventListener("abort", onAbort);
      await reader?.cancel().catch(() => {});
      controller.abort();
    }
  }

  /**
   * Completes and validates JSON output with Zod. On invalid output, one
   * correction request is made (the previous reply plus the validation
   * problems — field paths and rules, never resume content); then it fails.
   */
  async function completeValidated<T extends z.ZodType>(
    messages: PromptMessage[],
    schema: T,
    options?: AIRequestOptions,
  ): Promise<z.output<T>> {
    let conversation = messages;
    for (let attempt = 1; ; attempt++) {
      const text = await complete(conversation, options);
      let problems: string[];
      try {
        const result = schema.safeParse(parseModelJson(text));
        if (result.success) return result.data;
        problems = result.error.issues
          .slice(0, MAX_CORRECTION_ISSUES)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      } catch {
        problems = ["The reply was not a JSON object."];
      }
      if (attempt >= 2) {
        throw new AIProviderError("invalid_response", "MiMo output failed validation twice");
      }
      conversation = [
        ...messages,
        { role: "assistant", content: text.slice(0, MAX_ECHOED_REPLY_CHARS) },
        {
          role: "user",
          content: [
            "Your reply did not match the required JSON shape:",
            ...problems.map((problem) => `- ${problem}`),
            "Reply with ONLY the corrected JSON object.",
          ].join("\n"),
        },
      ];
    }
  }

  return {
    id: "mimo",
    modelName: model,

    executeResumeTask(input, options) {
      return completeValidated(buildResumeTaskMessages(input), resumeTaskOutputSchema, options);
    },

    streamResumeTask(input, options) {
      return streamCompletion(buildResumeTaskMessages(input, "markdown"), options);
    },

    analyzeTemplate(input, options) {
      return completeValidated(
        buildTemplateAnalysisMessages(input),
        clientTemplateStructureSchema,
        options,
      );
    },

    formatResume(input, options) {
      return completeValidated(buildFormattingMessages(input), aiFormattingPlanSchema, options);
    },

    fillTemplate(input, options) {
      return completeValidated(buildFillMessages(input), aiFillPlanSchema, options);
    },

    // Not used: resume structuring is deterministic (Phase 5).
    async analyzeResume() {
      throw new NotImplementedError("AI resume analysis");
    },
  };
}
