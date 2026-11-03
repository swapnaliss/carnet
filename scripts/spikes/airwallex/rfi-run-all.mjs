// Runs the eight RFI checks in order against the sandbox. Re-runnable: new transfers and RFIs each run,
// the one-open rule is respected by closing before each check, and nothing is left open at the end.
import { requireEnv } from "./lib.mjs";
import * as c1 from "./rfi-check1.mjs";
import * as c2 from "./rfi-check2.mjs";
import * as c3 from "./rfi-check3.mjs";
import * as c4 from "./rfi-check4.mjs";
import * as c5 from "./rfi-check5.mjs";
import * as c6 from "./rfi-check6.mjs";
import * as c7 from "./rfi-check7.mjs";
import * as c8 from "./rfi-check8.mjs";
import { closeAllOpenRfis } from "./rfi-lib.mjs";

requireEnv();
try {
  for (const [n, mod] of [
    [1, c1],
    [2, c2],
    [3, c3],
    [4, c4],
    [5, c5],
    [6, c6],
    [7, c7],
    [8, c8],
  ]) {
    console.log(`--- check ${n}`);
    await mod.run();
  }
} finally {
  console.log(`closed ${await closeAllOpenRfis()} open RFI(s) at exit`);
}
console.log("done");
