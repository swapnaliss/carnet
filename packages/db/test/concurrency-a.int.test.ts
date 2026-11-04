import { describe } from "vitest";
import { concurrencyTest } from "./concurrency";
import { useTestDatabase } from "./harness";

const db = useTestDatabase();
describe("worker isolation (a)", () => concurrencyTest("a", db));
