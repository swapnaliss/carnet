// Test support: replays the recorded Anthropic responses in fixtures/anthropic/ (M0-06) through the
// SDK's HTTP transport, and captures every request the SDK sends. No test reaches the network: the
// transport below is the only fetch the harness gets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ANTHROPIC_FIXTURES = fileURLToPath(
  new URL("../../../fixtures/anthropic/", import.meta.url),
);

export interface RecordedCall {
  kind: string;
  request: Record<string, unknown>;
  response: {
    id: string;
    model: string;
    stop_reason: string;
    usage: Record<string, unknown>;
    content: unknown[];
    parsed_output: unknown;
  };
  headers: Record<string, string>;
  cost_usd: number;
  latency_ms: number;
}

export interface RecordedStop {
  kind: "stop";
  request: { model: string; max_tokens: number };
  create: { stop_reason: string; usage: Record<string, unknown>; text: string };
  parse: { returned: boolean; error: string };
}

export function loadFixture<T = RecordedCall>(name: string): T {
  return JSON.parse(readFileSync(`${ANTHROPIC_FIXTURES}${name}.json`, "utf8")) as T;
}

/** A Messages API response body, as the API sends it. */
export interface MessageBody {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: unknown[];
  stop_reason: string;
  stop_sequence: null;
  usage: Record<string, unknown>;
}

export interface CannedResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A recorded successful call (draft-*, extract-*) as the HTTP response the API returned. */
export function recordedResponse(name: string): CannedResponse {
  const f = loadFixture(name);
  return {
    status: 200,
    headers: f.headers,
    body: {
      id: f.response.id,
      type: "message",
      role: "assistant",
      model: f.response.model,
      content: f.response.content,
      stop_reason: f.response.stop_reason,
      stop_sequence: null,
      usage: f.response.usage,
    } satisfies MessageBody,
  };
}

/** The recorded `max_tokens` call (stop-max-tokens.json): truncated JSON text, 60 output tokens. */
export function recordedMaxTokens(): CannedResponse {
  const f = loadFixture<RecordedStop>("stop-max-tokens");
  return {
    status: 200,
    headers: { "request-id": "req_recorded_max_tokens" },
    body: {
      id: "msg_recorded_max_tokens",
      type: "message",
      role: "assistant",
      model: f.request.model,
      content: [{ type: "text", text: f.create.text }],
      stop_reason: f.create.stop_reason,
      stop_sequence: null,
      usage: f.create.usage,
    } satisfies MessageBody,
  };
}

/**
 * A CONSTRUCTED response (not recorded): M0-06 could not reproduce `stop_reason: "refusal"` or a 429
 * against the real API (BL-01 6624408823). Shape follows the recorded responses.
 */
export function constructedResponse(
  stopReason: string,
  text: string,
  usage = { input_tokens: 1200, output_tokens: 15 },
): CannedResponse {
  return {
    status: 200,
    headers: { "request-id": `req_constructed_${stopReason}` },
    body: {
      id: `msg_constructed_${stopReason}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    } satisfies MessageBody,
  };
}

export interface CapturedRequest {
  url: string;
  method: string;
  /** The raw body string the SDK sent. */
  rawBody: string;
  body: Record<string, unknown>;
}

export interface RecordingTransport {
  transport: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  requests: CapturedRequest[];
}

/**
 * A transport that answers with `responses` in order (the last one repeats) and records each
 * request. `hang: true` never answers until the request's signal aborts.
 */
export function recordingTransport(
  responses: CannedResponse[],
  options: { hang?: boolean } = {},
): RecordingTransport {
  const requests: CapturedRequest[] = [];
  let i = 0;
  const transport = async (input: string | URL | Request, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? init.body : "";
    requests.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      rawBody,
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
    });
    if (options.hang) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
      });
    }
    const canned = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!canned) throw new Error("recordingTransport: no response configured");
    return new Response(JSON.stringify(canned.body), {
      status: canned.status,
      headers: { "content-type": "application/json", ...canned.headers },
    });
  };
  return { transport, requests };
}
