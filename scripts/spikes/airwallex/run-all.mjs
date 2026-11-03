// Re-runnable end to end: every run mints new request_ids and new beneficiaries/transfers.
import * as auth from "./01-auth.mjs";
import * as fund from "./02-funding-beneficiaries.mjs";
import * as fx from "./03-fx-transfers.mjs";
import * as tr from "./04-transitions.mjs";
import * as cc from "./05-cross-cutting.mjs";
import { requireEnv } from "./lib.mjs";

requireEnv();
console.log("step 1: auth");
await auth.run();
console.log("step 2-3: funding, beneficiaries, balances");
const ids = await fund.run();
console.log("step 4-6: fx, transfers, request_id");
await fx.run(ids);
console.log("step 7: simulation transitions");
await tr.run(ids);
console.log("step 8: cross-cutting (rate limit, errors)");
console.log(await cc.run());
console.log("done");
