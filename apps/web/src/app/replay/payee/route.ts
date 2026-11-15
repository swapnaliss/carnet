// The payee page as the payee sees it, for the recording (M4-05). Only a replay session may open it;
// it renders the same public payee view (server/payee-page.ts) for the recorded payment, with the
// recording notice above it. No token is minted and nothing is written (the public route counts views).
import { getPayment, listReplayRecordings, repoCtx } from "@carnet/db";
import { type PaymentId, payeeStatus } from "@carnet/domain";
import { getAuthRuntime } from "../../../lib/auth";
import { sessionCtx } from "../../../lib/authz";
import { withRequestContext } from "../../../lib/request-context";
import { appDb } from "../../../server/db";
import { renderStatusPage, renderUnavailable } from "../../../server/payee-page";
import { holdingRfi } from "../../../server/payee-status";
import { PAYEE_PAGE_HEADERS } from "../../../server/payee-status-handler";
import { bannerDate } from "../../../server/replay/view";
import { fill, t } from "../../../strings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const html = (body: string, status: number) =>
  new Response(body, { status, headers: PAYEE_PAGE_HEADERS });

export const GET = withRequestContext(async (req: Request) => {
  const ctx = await sessionCtx(getAuthRuntime(), req.headers);
  if (!ctx) return Response.redirect(new URL("/login", req.url), 303);
  if (ctx.mode !== "replay") return html(renderUnavailable(), 404);
  const db = appDb().db;
  const active = (await listReplayRecordings(db))
    .filter((r) => r.materialized && r.businessId === ctx.businessId)
    .at(-1);
  const paymentId = active?.refs.strong;
  const payment = paymentId
    ? await getPayment(repoCtx(db, ctx.businessId), paymentId as PaymentId)
    : null;
  if (!payment) return html(renderUnavailable(), 404);
  const held = await holdingRfi(db, ctx.businessId, payment.id);
  const date = await bannerDate(db);
  const status = payeeStatus(payment.transferStatus, held, "GENERIC");
  return html(
    renderStatusPage(status, payment.transferUpdatedAt ?? payment.createdAt, {
      text: date ? fill(t.replay.banner, { date }) : t.replay.bannerNoRecording,
      label: t.replay.bannerLabel,
      titleSuffix: t.replay.titleSuffix,
    }),
    200,
  );
});
