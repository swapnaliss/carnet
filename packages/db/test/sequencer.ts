// The two concurrency files (concurrency-a/b.int.test.ts) only pass when two Vitest workers run them at
// the same time: each waits for the other. Vitest orders files by cached duration, so after a slow
// run the pair could land far apart (or on the same worker one after the other, which the test
// rightly reports as "not concurrent"). This sequencer starts the pair first, so both begin together
// on separate workers whatever the cache says. The test itself is unchanged: still 20 s rendezvous,
// still requires distinct worker databases.
import { BaseSequencer, type TestSpecification } from "vitest/node";

const isConcurrencyPair = (file: TestSpecification) =>
  /test\/concurrency-[ab]\.int\.test\.ts$/.test(file.moduleId);

export default class ConcurrencyFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    return [...sorted.filter(isConcurrencyPair), ...sorted.filter((f) => !isConcurrencyPair(f))];
  }
}
