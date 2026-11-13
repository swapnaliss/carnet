// Shared body of concurrency-a/b.int.test.ts: two files, run by two Vitest workers at the same time,
// each write the SAME unique key into their own database. They meet in a run-scoped directory so the
// test only passes when both are alive concurrently.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, inject, it } from "vitest";
import { DuplicateWebhookEventError } from "../src/errors";
import { insertWebhookEvent } from "../src/repos/system";
import { type TestDatabase, workerKey } from "./harness";

export const SHARED_KEY = "evt_concurrency_same_key";

async function waitFor(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() > deadline) throw new Error(`peer never reached ${path}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export function concurrencyTest(self: "a" | "b", db: () => TestDatabase): void {
  const peer = self === "a" ? "b" : "a";
  it("writes the same unique key as the other worker, at the same time, without interference", async () => {
    const dir = inject("rendezvousDir");
    const { app, name } = db();
    expect(name).toBe(`carnet_test_${workerKey()}`);

    await insertWebhookEvent(app.db, {
      providerEventId: SHARED_KEY,
      name: `written by ${self}`,
      rawBody: "{}",
      signatureOk: true,
    });
    await writeFile(join(dir, `${self}.written`), name);
    const peerDb = await waitFor(join(dir, `${peer}.written`), 20_000);

    // Both workers are running now and both inserted the same key: separate databases.
    expect(peerDb).not.toBe(name);
    // The key is unique within this database: a second insert here is a duplicate.
    await expect(
      insertWebhookEvent(app.db, {
        providerEventId: SHARED_KEY,
        name: "again",
        rawBody: "{}",
        signatureOk: true,
      }),
    ).rejects.toBeInstanceOf(DuplicateWebhookEventError);

    // Wait until the peer has finished its own duplicate check before reading back.
    await writeFile(join(dir, `${self}.checked`), name);
    await waitFor(join(dir, `${peer}.checked`), 20_000);
    const rows = await app.pool.query<{ name: string }>(
      "SELECT name FROM webhook_events WHERE provider_event_id = $1",
      [SHARED_KEY],
    );
    expect(rows.rows).toEqual([{ name: `written by ${self}` }]);
  });
}
