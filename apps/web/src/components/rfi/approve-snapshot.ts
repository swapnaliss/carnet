import type { HoldView } from "@/server/hold";
import { type ApproveBody, buildApproveBody } from "./view";

// The approval snapshot lives apart from the dialog component so the hold screen can take a snapshot
// without importing approve-dialog.tsx: the dialog then really loads only when an approval starts
// (next/dynamic in hold-screen.tsx), keeping it out of the hydration bundle (INP, M4-07).

export interface ApproveSnapshot {
  /** Taken when the dialog opened: what the owner reads is what is sent. */
  readonly view: HoldView;
  readonly body: ApproveBody;
  readonly key: string;
}

export function makeSnapshot(view: HoldView): ApproveSnapshot | null {
  const body = buildApproveBody(view);
  return body ? { view, body, key: crypto.randomUUID() } : null;
}
