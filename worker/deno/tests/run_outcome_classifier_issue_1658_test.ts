import { assertEquals, assertNotEquals } from "@std/assert";
import {
  classifyRunFailure,
  RUN_FAILURE_CLASSES,
} from "../lib/run_outcome_classifier.ts";

const STALE_LINEAGE_MESSAGE =
  "Refusing to push `issue-4694-sampler-disk-pre-flight-3-the-measured-corpus-60-g`: " +
  "merged PR #4700 squashed this branch's work into the base as a027482, and the branch tip does not contain it — " +
  "its commits would replay content the base already has; rebasing it onto " +
  "'origin/milestone/4690-bug-sampler-enospc-on-228-gb-hosts-60-gb-disk' was refused: " +
  "replaying 464a274 onto 'origin/milestone/4690-bug-sampler-enospc-on-228-gb-hosts-60-gb-disk' conflicted, " +
  "so the branch was restored unchanged (Issue #534)";

Deno.test("#1658 squash-lineage refusal is not misclassified as disk-full", () => {
  const got = classifyRunFailure("unknown", STALE_LINEAGE_MESSAGE);
  assertEquals(got.failureClass, "stale-lineage");
  assertEquals(got.fixability, "not_code_fixable");
  assertEquals(
    (RUN_FAILURE_CLASSES as readonly string[]).includes("stale-lineage"),
    true,
  );
});

Deno.test("#1658 lowercase enospc inside branch/path text is not disk-full", () => {
  const message =
    "rebasing onto 'origin/milestone/4690-bug-sampler-enospc-on-228-gb-hosts-60-gb-disk' conflicted";
  assertNotEquals(
    classifyRunFailure("unknown", message).failureClass,
    "disk-full",
  );
});

Deno.test("#1658 genuine ENOSPC and human disk-full phrases still classify", () => {
  for (const message of [
    "Error: ENOSPC: no space left on device, write",
    "No Space Left On Device",
    "Disk Full while writing checkpoint",
    "<details>\n<summary>Last output from Claude</summary>\nError: ENOSPC: write failed\n</details>",
  ]) {
    assertEquals(
      classifyRunFailure("unknown", message).failureClass,
      "disk-full",
      message,
    );
  }
});

Deno.test("#1658 out-of-credit token inside a branch slug is not out-of-credit", () => {
  const got = classifyRunFailure(
    "unknown",
    "push failed for origin/bug-out-of-credit-retry",
  );
  assertNotEquals(got.failureClass, "out-of-credit");
});

Deno.test("#1658 OOM token inside a branch slug is not OOM evidence", () => {
  const got = classifyRunFailure(
    "killed",
    "branch origin/bug-out-of-memory-retry was active when the process was killed",
  );
  assertNotEquals(got.failureClass, "oom");
  assertEquals(got.failureClass, "killed-unknown");
});

Deno.test("#1658 crash prose token inside a branch slug is not a worker crash", () => {
  const got = classifyRunFailure(
    "unknown",
    "push failed for origin/bug-unhandled-exception-recovery",
  );
  assertNotEquals(got.failureClass, "worker-crash");
});
