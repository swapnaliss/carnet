// Shared, run-scoped values for the test workers (one per `vitest run`).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Directory the two concurrency tests use to meet while both are running. */
    rendezvousDir: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "carnet-db-test-"));
  project.provide("rendezvousDir", dir);
  return () => rm(dir, { recursive: true, force: true });
}
