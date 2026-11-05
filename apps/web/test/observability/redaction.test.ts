// AC: logging an object with password, authorization and apiKey fields emits [Redacted] for each.
import { describe, expect, it } from "vitest";
import { capture, capturedLogger } from "./capture";

describe("log redaction", () => {
  it("replaces password, authorization and apiKey with [Redacted], top level and nested", () => {
    const c = capture();
    const log = capturedLogger(c);
    log.info(
      {
        password: "hunter2-not-real",
        authorization: "Bearer not-a-real-token",
        apiKey: "sk_not_real",
        headers: { authorization: "Bearer nested", cookie: "carnet.session_token=x" },
        config: { apiKey: "nested_key", password: "nested_pw" },
        email: "owner@carnet.example",
        transferId: "kept-visible",
      },
      "redaction check",
    );
    const [line] = c.lines();
    expect(line).toMatchObject({
      password: "[Redacted]",
      authorization: "[Redacted]",
      apiKey: "[Redacted]",
      headers: { authorization: "[Redacted]", cookie: "[Redacted]" },
      config: { apiKey: "[Redacted]", password: "[Redacted]" },
      email: "[Redacted]",
      transferId: "kept-visible",
    });
    const text = c.raw.join("");
    for (const secret of ["hunter2", "not-a-real-token", "sk_not_real", "nested_key", "owner@"]) {
      expect(text).not.toContain(secret);
    }
  });
});
