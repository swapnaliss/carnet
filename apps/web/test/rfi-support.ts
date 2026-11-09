// Test support for the M2-04 RFI tests: recorded RFI wire bodies (M0-04 fixtures) re-keyed to a test's
// RFI id, transfer ids and account, and a worker wired to a stubbed Airwallex that serves them.
import { createBusiness, type Db } from "@carnet/db";
import type { BusinessId } from "@carnet/domain";
import { memoryLogger } from "../src/server/log";
import { createWorker } from "../src/worker/loop";
import { RFI_DRAFT_JOB_KIND } from "../src/worker/handlers/draft";
import { defaultRegistry } from "../src/worker/run";
import { FetchStub, loadFixture, makeClient, query, recordedDeliveries } from "./support";

export interface QuestionWire {
  id: string;
  answer: Record<string, unknown>;
  sources?: { id: string; type: string }[];
  [k: string]: unknown;
}
export interface RequestWire {
  questions: QuestionWire[];
  expires_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}
export interface RfiWire {
  id: string;
  account_id?: string;
  status: string;
  updated_at: string;
  active_request?: RequestWire | null;
  answered_requests?: RequestWire[];
  [k: string]: unknown;
}

export function fixtureRfi(name: string): RfiWire {
  return structuredClone(loadFixture(name).response.body) as RfiWire;
}

/** Re-keys a recorded RFI: new id, account, and (optionally) every question's single source. */
export function retarget(
  wire: RfiWire,
  to: {
    id?: string;
    accountId?: string;
    transferId?: string;
    sources?: { id: string; type: string }[];
  },
): RfiWire {
  const w = structuredClone(wire);
  if (to.id) w.id = to.id;
  if (to.accountId) w.account_id = to.accountId;
  const sources = to.sources ?? (to.transferId ? [{ id: to.transferId, type: "TRANSFER" }] : null);
  if (sources) {
    for (const req of [w.active_request, ...(w.answered_requests ?? [])]) {
      for (const q of req?.questions ?? []) q.sources = sources.map((s) => ({ ...s }));
    }
  }
  return w;
}

export function withoutSources(wire: RfiWire): RfiWire {
  return retarget(wire, { sources: [] });
}

/** The first round as it looked before it was answered (answers stripped, `rfi-check2-fetch-after-full`). */
export function firstRoundOpen(): RfiWire {
  const after = fixtureRfi("rfi-check2-fetch-after-full");
  const round1 = structuredClone(after.answered_requests?.[0]);
  if (!round1) throw new Error("fixture has no answered request");
  for (const q of round1.questions) q.answer = { type: q.answer.type };
  return {
    ...after,
    status: "ACTION_REQUIRED",
    updated_at: "2026-11-03T09:57:41+0000",
    active_request: round1,
    answered_requests: [],
  };
}

/** The real follow-up sequence for RFI 6ac53a86, oldest first (M0-04). */
export function followUpSequence(): RfiWire[] {
  return [
    firstRoundOpen(), // ACTION_REQUIRED, round 1
    fixtureRfi("rfi-check2-fetch-after-full"), // ANSWERED, 1 answered request
    fixtureRfi("rfi-followup-fetch"), // ACTION_REQUIRED, round 2 (same RFI, newer updated_at)
    fixtureRfi("rfi-followup-fetch-after-respond"), // ANSWERED, 2 answered requests
  ];
}

/** CLOSED with nothing answered in the last request (`rfi-check5-fetch-after-close`). */
export function closedUnanswered(): RfiWire {
  return fixtureRfi("rfi-check5-fetch-after-close");
}

let counter = 0;
export const uid = (prefix = "00000000"): string =>
  `${prefix}-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

/** A fresh business with its own Airwallex account id (attribution by account). */
export async function newBusiness(db: Db): Promise<{ businessId: BusinessId; accountId: string }> {
  const accountId = `acct_${crypto.randomUUID()}`;
  const businessId = await createBusiness(db, { name: "Rfi Co", airwallexAccountId: accountId });
  return { businessId, accountId };
}

/**
 * The registry without the `rfi.draft` consumer (M2-05): the M2-04 ingest tests assert what ingest
 * enqueues and the state it leaves, so the draft job must stay queued (drafting has its own tests).
 */
function ingestOnlyRegistry() {
  const registry = defaultRegistry();
  registry.delete(RFI_DRAFT_JOB_KIND);
  return registry;
}

export async function resetRfiTables(appUrl: string): Promise<void> {
  await query(appUrl, "DELETE FROM outbox_jobs");
  await query(appUrl, "DELETE FROM webhook_events");
  await query(appUrl, "DELETE FROM rfi_questions");
  await query(appUrl, "DELETE FROM rfis");
}

/** A rfi.* webhook body for `rfiId` with a fresh event id (the recorded envelope). */
export function rfiEventBody(rfiId: string, name = "rfi.action_required"): string {
  const base = recordedDeliveries().find((d) => d.event.name === name);
  if (!base) throw new Error(`no recorded ${name}`);
  return JSON.stringify({
    ...base.event,
    id: crypto.randomUUID(),
    data: { ...base.event.data, id: rfiId },
  });
}

export function rfiHarness(db: Db, options: { workers?: number } = {}) {
  const stub = new FetchStub();
  const current = new Map<string, RfiWire>();
  stub.on("GET", /^\/api\/v1\/rfis\/[^/]+$/, (call) => {
    const body = current.get(call.path.split("/").pop() ?? "");
    return body
      ? Response.json(body)
      : Response.json({ code: "resource_not_found", message: "not found" }, { status: 404 });
  });
  stub.on("GET", "/api/v1/rfis", () =>
    Response.json({ items: [...current.values()], has_more: false }),
  );
  const logger = memoryLogger();
  const airwallex = makeClient(stub);
  const workers = Array.from({ length: options.workers ?? 1 }, () =>
    createWorker({ db, registry: ingestOnlyRegistry(), airwallex, logger, reconcileEveryMs: null }),
  );
  const drainOne = async (w: (typeof workers)[number]) => {
    while (await w.tick()) {
      /* run every due job */
    }
  };
  const drain = async () => {
    await Promise.all(workers.map(drainOne));
  };
  return { stub, current, logger, airwallex, drain, workers };
}
