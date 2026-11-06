// One network call: `messages.parse` with `zodOutputFormat`, then the stop_reason rule from the M0-06
// spike (docs/evidence/anthropic-spike.md): output is accepted only when stop_reason is `end_turn` AND
// the parsed object passes the zod schema again in code. `refusal` and `max_tokens` are typed failures
// and never yield an object, even when the text happens to parse.
//
// `messages.parse()` returns a plain Promise (no `.withResponse()`) and throws when the text is not
// valid JSON, which would lose the usage block of a call that was billed. A per-call transport wrapper
// therefore keeps the last successful HTTP response: headers (request id) and, on a parse failure, the
// raw message (stop_reason and usage). It buffers a 2xx body and hands the SDK a fresh Response with
// the same bytes (not `clone()`: the SDK cancels the body of a response it retries, and cancelling a
// tee'd body waits for the other branch, which hangs the retry).
import {
  AnthropicError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { z } from "zod";
import { createModelClient, type Transport } from "./client";
import type { ModelId, TokenUsage } from "./pricing";
import { usageOf } from "./pricing";

/** What a prompt may send: text (wrap untrusted text with `wrapUntrusted`), PDFs and images. */
export type ModelBlock = TextBlockParam | DocumentBlockParam | ImageBlockParam;

export interface SendInput<S extends z.ZodType> {
  readonly model: ModelId;
  /** The exact system text (already composed with the untrusted-data rule). */
  readonly system: string;
  readonly blocks: readonly ModelBlock[];
  readonly schema: S;
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  readonly transport: Transport;
  readonly maxRetries?: number;
}

interface Billed {
  readonly stopReason: string | null;
  readonly usage: TokenUsage;
  readonly requestId: string | null;
}

export type SendResult<T> =
  | ({ readonly kind: "ok"; readonly output: T } & Billed)
  | ({ readonly kind: "refused" } & Billed)
  | ({ readonly kind: "truncated" } & Billed)
  | ({ readonly kind: "invalid_output"; readonly message: string } & Billed)
  | ({ readonly kind: "unexpected_stop_reason" } & Billed)
  | { readonly kind: "aborted" }
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "http_error"; readonly status: number | null; readonly message: string }
  | { readonly kind: "network_error"; readonly message: string };

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0 };

/** Builds the request body; exported so tests can assert exactly what is sent. */
export function buildParams<S extends z.ZodType>(
  input: Omit<SendInput<S>, "signal" | "transport">,
) {
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: [{ role: "user" as const, content: [...input.blocks] }],
    output_config: { format: zodOutputFormat(input.schema) },
  };
}

function classify<T>(
  stopReason: string | null,
  billed: Billed,
  parsed: () => { ok: true; value: T } | { ok: false; message: string },
): SendResult<T> {
  if (stopReason === "refusal") return { kind: "refused", ...billed };
  if (stopReason === "max_tokens") return { kind: "truncated", ...billed };
  if (stopReason !== "end_turn") return { kind: "unexpected_stop_reason", ...billed };
  const p = parsed();
  return p.ok
    ? { kind: "ok", output: p.value, ...billed }
    : { kind: "invalid_output", message: p.message, ...billed };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeMessage(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 500);
}

export async function sendStructured<S extends z.ZodType>(
  input: SendInput<S>,
): Promise<SendResult<z.infer<S>>> {
  let last: { headers: Headers; body: string } | null = null;
  const capture: Transport = async (url, init) => {
    const response = await input.transport(url, init);
    if (!response.ok) return response;
    const body = await response.text();
    last = { headers: response.headers, body };
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  const lastSeen = () => last as { headers: Headers; body: string } | null;
  const requestId = () => lastSeen()?.headers.get("request-id") ?? null;
  const validate = (value: unknown) => {
    const r = input.schema.safeParse(value);
    return r.success
      ? { ok: true as const, value: r.data as z.infer<S> }
      : { ok: false as const, message: r.error.message.slice(0, 500) };
  };

  const client = createModelClient({
    transport: capture,
    ...(input.maxRetries === undefined ? {} : { maxRetries: input.maxRetries }),
  });
  try {
    const message = await client.messages.parse(buildParams(input), { signal: input.signal });
    const billed: Billed = {
      stopReason: message.stop_reason ?? null,
      usage: usageOf(message.usage),
      requestId: requestId(),
    };
    return classify(billed.stopReason, billed, () => validate(message.parsed_output));
  } catch (error) {
    if (error instanceof APIUserAbortError || input.signal.aborted) return { kind: "aborted" };
    if (error instanceof APIConnectionTimeoutError) {
      return { kind: "timeout", message: safeMessage(error) };
    }
    if (error instanceof APIError) {
      const status = typeof error.status === "number" ? error.status : null;
      return status === null
        ? { kind: "network_error", message: safeMessage(error) }
        : { kind: "http_error", status, message: safeMessage(error) };
    }
    // The SDK throws AnthropicError when the text is not valid JSON (truncated or refused output).
    // The HTTP call succeeded and was billed: read stop_reason and usage from the raw message.
    const raw = lastSeen();
    if (error instanceof AnthropicError && raw) {
      const body = parseJson(raw.body) as { stop_reason?: string | null; usage?: unknown } | null;
      const billed: Billed = {
        stopReason: body?.stop_reason ?? null,
        usage: body ? usageOf(body.usage) : ZERO,
        requestId: requestId(),
      };
      return classify(billed.stopReason, billed, () => ({
        ok: false,
        message: safeMessage(error),
      }));
    }
    return { kind: "network_error", message: safeMessage(error) };
  }
}
