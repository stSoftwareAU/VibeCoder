/**
 * Tests for the append-only lifecycle ledger (Issue #3718, part of #3644).
 *
 * Each test drives the real reader and writer against a temporary directory
 * the test creates and removes, so nothing touches a fixed path.
 *
 * Australian English spelling used throughout.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  appendLifecycleEvent,
  buildLifecycleEvent,
  LifecycleLedgerAppendError,
  type LifecycleEventInput,
  LifecycleLedgerReadError,
  lifecycleEventKey,
  lifecycleLedgerPath,
  readLifecycleLedger,
  serialiseLifecycleEvent,
} from "../lib/lifecycle_ledger.ts";

const ASSIGNMENT_ID = "3f2c9a1e-4b5d-4c6e-8f70-1a2b3c4d5e6f";
const RUN_ID = "vibe-lkz3p9x-1a2b3c";

/** The fields every event shares in these tests. */
const base = {
  assignmentId: ASSIGNMENT_ID,
  runId: RUN_ID,
  host: "worker-1",
  repo: "stSoftwareAU/VibeCoder",
  issueNumber: 3718,
  recordedAt: "2026-10-14T10:00:00Z",
};

/** One valid input of each of the five kinds. */
function oneOfEachKind(): LifecycleEventInput[] {
  return [
    {
      ...base,
      kind: "assignment",
      assignedAt: "2026-10-14T09:59:00Z",
      cohort: "exp-a",
      reused: false,
      treatment: {
        roles: [{
          role: "manager",
          provider: "claude",
          model: "opus",
          effort: "high",
        }],
        workerVersion: "v1.2.3",
        workerCommit: "abc1234",
        subscriptionAllocation: "acct-1",
      },
    },
    {
      ...base,
      kind: "invocation",
      role: "executor",
      agent: "executor",
      attempt: 1,
      provider: "claude",
      model: "sonnet",
      effort: "medium",
      servedModels: ["claude-sonnet-4-5"],
      result: "success",
      durationSeconds: 93.5,
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedApiCostUsd: 0.0123,
    },
    {
      ...base,
      kind: "follow_on",
      followOn: "ci_fix",
      attempt: 1,
      prNumber: 3800,
    },
    {
      ...base,
      kind: "gate",
      gate: "quality",
      result: "pass",
      attempt: 1,
      prNumber: 3800,
    },
    {
      ...base,
      kind: "outcome",
      outcome: "pr_opened",
      prNumber: 3800,
    },
  ];
}

/** Run `body` against a fresh temporary directory, removed afterwards. */
async function withTempDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "lifecycle_ledger_test_" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("lifecycle ledger - each of the five kinds round trips", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/ledger.jsonl`;
    const events = oneOfEachKind().map((input) => buildLifecycleEvent(input));
    for (const event of events) {
      await appendLifecycleEvent(path, event);
    }
    const read = await readLifecycleLedger(path);
    assertEquals(read, events);
    assertEquals(
      read.map((event) => event.kind),
      ["assignment", "invocation", "follow_on", "gate", "outcome"],
    );
  });
});

Deno.test("lifecycle ledger - a replayed event is read back once", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/ledger.jsonl`;
    const event = buildLifecycleEvent(oneOfEachKind()[1]!);
    // Simulates a replay after a restart: the same fact is appended twice.
    await appendLifecycleEvent(path, event);
    await appendLifecycleEvent(path, event);
    assertEquals(await readLifecycleLedger(path), [event]);
  });
});

Deno.test("lifecycle ledger - distinct events stay distinct", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/ledger.jsonl`;
    const first = buildLifecycleEvent(oneOfEachKind()[1]!);
    const second = buildLifecycleEvent({
      ...oneOfEachKind()[1]!,
      attempt: 2,
    } as LifecycleEventInput);
    await appendLifecycleEvent(path, first);
    await appendLifecycleEvent(path, second);
    assertEquals(await readLifecycleLedger(path), [first, second]);
  });
});

Deno.test("lifecycle ledger - eventKey is deterministic for each kind", () => {
  const [assignment, invocation, followOn, gate, outcome] = oneOfEachKind();
  assertEquals(
    lifecycleEventKey(assignment!),
    `assignment:${ASSIGNMENT_ID}:${RUN_ID}`,
  );
  assertEquals(
    lifecycleEventKey(invocation!),
    `invocation:${ASSIGNMENT_ID}:${RUN_ID}:executor:executor:1`,
  );
  assertEquals(
    lifecycleEventKey(followOn!),
    `follow_on:${ASSIGNMENT_ID}:${RUN_ID}:ci_fix:3800:1`,
  );
  assertEquals(
    lifecycleEventKey(gate!),
    `gate:${ASSIGNMENT_ID}:${RUN_ID}:quality:1`,
  );
  assertEquals(
    lifecycleEventKey(outcome!),
    `outcome:${ASSIGNMENT_ID}:pr_opened:pr-3800`,
  );
  // The same input always derives the same key.
  assertEquals(lifecycleEventKey(gate!), lifecycleEventKey({ ...gate! }));
  assertEquals(buildLifecycleEvent(gate!).eventKey, lifecycleEventKey(gate!));
});

Deno.test("lifecycle ledger - a PR outcome counts once across runs and hosts", () => {
  const prOutcome: LifecycleEventInput = {
    ...base,
    kind: "outcome",
    outcome: "merged",
    prNumber: 3800,
  };
  const otherRun = { ...prOutcome, runId: "vibe-other-run-000001" };
  assertEquals(
    lifecycleEventKey(prOutcome),
    lifecycleEventKey(otherRun),
  );

  const runOutcome: LifecycleEventInput = {
    ...base,
    kind: "outcome",
    outcome: "pending",
  };
  assertEquals(
    lifecycleEventKey(runOutcome),
    `outcome:${ASSIGNMENT_ID}:pending:run-${RUN_ID}`,
  );
  assert(
    lifecycleEventKey(runOutcome) !==
      lifecycleEventKey({ ...runOutcome, runId: "vibe-other-run-000001" }),
  );
});

Deno.test("lifecycle ledger - a corrupt line is refused with its line number", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/ledger.jsonl`;
    const event = buildLifecycleEvent(oneOfEachKind()[0]!);
    await appendLifecycleEvent(path, event);
    await Deno.writeTextFile(path, "{not json\n", { append: true });

    const error = await assertRejects(
      () => readLifecycleLedger(path),
      LifecycleLedgerReadError,
    );
    assertEquals(error.reason, "unparseable");
    assertEquals(error.line, 2);
    assertEquals(error.path, path);
    assertStringIncludes(error.message, path);
    assertStringIncludes(error.message, "line 2");
    // The detail never echoes the raw line.
    assertEquals(error.message.includes("{not json"), false);
  });
});

Deno.test("lifecycle ledger - an invalid but parseable line is refused", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/ledger.jsonl`;
    const event = buildLifecycleEvent(oneOfEachKind()[0]!);
    const badId = { ...JSON.parse(serialiseLifecycleEvent(event)), assignmentId: "not-a-uuid" };
    await Deno.writeTextFile(path, JSON.stringify(badId) + "\n");

    const error = await assertRejects(
      () => readLifecycleLedger(path),
      LifecycleLedgerReadError,
    );
    assertEquals(error.reason, "invalid");
    assertEquals(error.line, 1);
    assertStringIncludes(error.message, "assignmentId");
  });
});

Deno.test("lifecycle ledger - a newer schema is refused as future-schema", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/ledger.jsonl`;
    const event = buildLifecycleEvent(oneOfEachKind()[0]!);
    const future = { ...JSON.parse(serialiseLifecycleEvent(event)), schema: 2 };
    await Deno.writeTextFile(path, JSON.stringify(future) + "\n");

    const error = await assertRejects(
      () => readLifecycleLedger(path),
      LifecycleLedgerReadError,
    );
    assertEquals(error.reason, "future-schema");
    assertEquals(error.line, 1);
  });
});

Deno.test("lifecycle ledger - a tampered eventKey is refused", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/ledger.jsonl`;
    const event = buildLifecycleEvent(oneOfEachKind()[0]!);
    const tampered = {
      ...JSON.parse(serialiseLifecycleEvent(event)),
      eventKey: "assignment:forged",
    };
    await Deno.writeTextFile(path, JSON.stringify(tampered) + "\n");

    const error = await assertRejects(
      () => readLifecycleLedger(path),
      LifecycleLedgerReadError,
    );
    assertEquals(error.reason, "invalid");
    assertStringIncludes(error.message, "eventKey");
  });
});

Deno.test("lifecycle ledger - a missing ledger reads as empty", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await readLifecycleLedger(`${dir}/absent.jsonl`), []);
  });
});

Deno.test("lifecycle ledger - an unreadable ledger is refused as unreadable", async () => {
  await withTempDir(async (dir) => {
    // A directory is present but cannot be read as a file.
    const error = await assertRejects(
      () => readLifecycleLedger(dir),
      LifecycleLedgerReadError,
    );
    assertEquals(error.reason, "unreadable");
    assertEquals(error.line, 0);
    assertEquals(error.path, dir);
  });
});

Deno.test("lifecycle ledger - an append into a missing directory is refused", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/no-such-dir/ledger.jsonl`;
    const error = await assertRejects(
      () =>
        appendLifecycleEvent(path, buildLifecycleEvent(oneOfEachKind()[0]!)),
      LifecycleLedgerAppendError,
    );
    assertEquals(error.path, path);
    assertStringIncludes(error.message, path);
  });
});

Deno.test("lifecycle ledger - a hostname with a separator stays inside workDir", () => {
  const dir = "/work/dir";
  const path = lifecycleLedgerPath(dir, "evil/../host");
  assert(path.startsWith(`${dir}/`));
  assertEquals(path.slice(dir.length + 1).includes("/"), false);
  assertEquals(
    path,
    `${dir}/lifecycle_ledger_evil_.._host.jsonl`,
  );
});
