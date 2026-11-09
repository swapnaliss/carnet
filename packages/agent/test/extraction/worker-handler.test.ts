// M2-02 AC8: a crash between the model reply and the facts write replays the stored output.
import { describe, expect, it } from "vitest";
import { type ExtractionResult, type ExtractionStore, runExtraction } from "../../src/index";
import { caseById, documentOf, replayOf, rig } from "./support";

function fakeStore(documentId: string, failFirstSave: boolean) {
  const saved = new Map<string, ExtractionResult>();
  let saves = 0;
  const store: ExtractionStore = {
    async loadDocument(id) {
      return id === documentId ? documentOf(caseById(documentId)) : null;
    },
    async saveExtraction(input) {
      saves += 1;
      if (failFirstSave && saves === 1) throw new Error("crash before the facts write");
      const had = saved.has(input.extractionKey);
      if (!had) saved.set(input.extractionKey, input.result);
      return { version: saved.size, inserted: !had };
    },
  };
  return { store, saved, saves: () => saves };
}

describe("runExtraction", () => {
  it("AC8: a crash after the model reply replays the stored output, with no second model call", async () => {
    const id = "inv-harbor-001";
    const r = rig(replayOf(id));
    const fake = fakeStore(id, true);
    const params = {
      harness: r.harness,
      store: fake.store,
      documentId: id,
      extractionKey: "job-1",
    };

    await expect(runExtraction(params)).rejects.toThrow("crash");
    expect(r.requests).toHaveLength(1);
    expect(r.store.steps).toHaveLength(1);

    const second = await runExtraction(params);
    expect(second).toEqual({ status: "EXTRACTED", version: 1, inserted: true });
    expect(r.requests).toHaveLength(1); // replayed from the stored step
    expect(r.store.steps).toHaveLength(1);
    expect([...r.store.runs.values()].map((x) => x.status)).toEqual(["DONE", "DONE"]);

    // A third run of the same job (the job was re-delivered) inserts nothing new.
    const third = await runExtraction(params);
    expect(third.inserted).toBe(false);
    expect(r.requests).toHaveLength(1);
  });

  it("a failed extraction is saved as EXTRACTION_FAILED and the run is FAILED", async () => {
    const id = "inv-harbor-001";
    const r = rig(replayOf(id), { agentsEnabled: false });
    const fake = fakeStore(id, false);
    const out = await runExtraction({
      harness: r.harness,
      store: fake.store,
      documentId: id,
      extractionKey: "k",
    });
    expect(out.status).toBe("EXTRACTION_FAILED");
    const saved = fake.saved.get("k");
    expect(saved?.status === "EXTRACTION_FAILED" && saved.failure).toBe("AGENTS_DISABLED");
    expect([...r.store.runs.values()].map((x) => x.status)).toEqual(["FAILED"]);
    expect(r.requests).toHaveLength(0);
  });

  it("a missing document throws (the job fails and retries) and calls no model", async () => {
    const r = rig(replayOf("inv-harbor-001"));
    const fake = fakeStore("inv-harbor-001", false);
    await expect(
      runExtraction({
        harness: r.harness,
        store: fake.store,
        documentId: "nope",
        extractionKey: "k",
      }),
    ).rejects.toThrow("not found");
    expect(r.requests).toHaveLength(0);
  });
});
