import { requireEnv } from "./lib.mjs";
import { listOpenRfis } from "./rfi-lib.mjs";

requireEnv();
const open = await listOpenRfis();
if (open.length) {
  console.error(
    `${open.length} RFI(s) still open: ${open.map((r) => `${r.id}:${r.status}`).join(", ")}`,
  );
  process.exit(1);
}
console.log("no open RFI on the account");
