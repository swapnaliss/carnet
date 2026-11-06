// Shared by the planner tests: the payroll-Friday fixture, the fee config, and edit helpers.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Currency, isCurrency, type PlanInputsInput, parseMajor } from "../src/index";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${ROOT}${relative}`, "utf8")) as Record<string, unknown>;
}

/** config/fees.json as the planner's config object (fees in minor units). */
export function feesConfig(overrides: { eurFee?: string } = {}): PlanInputsInput["config"] {
  const file = readJson("config/fees.json") as {
    heldFundsVisibleInBalances: boolean;
    swiftPayoutFee: Record<string, string>;
    fxSpreadBps: number;
    deferGraceDays: { "2": number; "3": number };
  };
  const fees = { ...file.swiftPayoutFee };
  if (overrides.eurFee !== undefined) fees.EUR = overrides.eurFee;
  return {
    ...file,
    swiftPayoutFee: Object.entries(fees).map(([code, major]) => {
      if (!isCurrency(code)) throw new Error(`bad currency ${code}`);
      return { currency: code as Currency, minor: parseMajor(major, code).minor };
    }),
  };
}

/** Inputs of the payroll-Friday scenario (held funds counted by the planner, i.e. flag false). */
export function payrollFriday(
  options: { flag?: boolean; eurFee?: string } = {},
): PlanInputsInput & { held: NonNullable<PlanInputsInput["held"]> } {
  const fixture = readJson("fixtures/planner/payroll-friday.json");
  delete fixture._comment;
  const config = feesConfig(options.eurFee === undefined ? {} : { eurFee: options.eurFee });
  return {
    ...(fixture as unknown as PlanInputsInput),
    config: { ...config, heldFundsVisibleInBalances: options.flag ?? false },
  };
}

export function withoutHold(inputs: PlanInputsInput): PlanInputsInput {
  return { ...inputs, held: [] };
}
