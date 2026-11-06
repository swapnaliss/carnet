// The only module that reads the model API key. The key goes into the SDK client (an HTTP header) and
// nowhere else: never into a prompt, a step, a log line or an error message.
import Anthropic from "@anthropic-ai/sdk";

/** SDK timeout per HTTP attempt (M2-00 scope: 60 s). */
export const SDK_TIMEOUT_MS = 60_000;
/** SDK retries on 408/409/429/5xx with jittered exponential backoff, honouring `retry-after`. */
export const SDK_MAX_RETRIES = 2;

export type Transport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
    this.name = "MissingApiKeyError";
  }
}

function readApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new MissingApiKeyError();
  return key;
}

export interface ClientOptions {
  /** The HTTP transport (defaults to global fetch). Tests pass a recorded-response transport. */
  transport?: Transport;
  maxRetries?: number;
}

export function createModelClient(options: ClientOptions = {}): Anthropic {
  return new Anthropic({
    apiKey: readApiKey(),
    maxRetries: options.maxRetries ?? SDK_MAX_RETRIES,
    timeout: SDK_TIMEOUT_MS,
    ...(options.transport ? { fetch: options.transport } : {}),
  });
}
