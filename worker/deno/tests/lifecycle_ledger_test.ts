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
  assertThrows,
} from "@std/assert";
import {
  appendLifecycleEvent,
  buildLifecycleEvent,
  type LifecycleEvent,
  type LifecycleEventInput,
  lifecycleEventKey,
  LifecycleEventSchemaError,
  LifecycleLedgerAppendError,
  lifecycleLedgerPath,
  LifecycleLedgerReadError,
  readLifecycleLedger,
  serialiseLifecycleEvent,
  validateLifecycleEvent,
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
    const badId = {
      ...JSON.parse(serialiseLifecycleEvent(event)),
      assignmentId: "not-a-uuid",
    };
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

/**
 * Build the input for one fixture from `oneOfEachKind()`, with fields replaced
 * or dropped. The result is deliberately not checked, so a probe can carry a
 * value the validator must refuse.
 */
function probeInput(
  index: number,
  fields: Record<string, unknown> = {},
  drop: string[] = [],
): LifecycleEventInput {
  const merged: Record<string, unknown> = { ...oneOfEachKind()[index] };
  Object.assign(merged, fields);
  for (const key of drop) delete merged[key];
  return merged as unknown as LifecycleEventInput;
}

/** The unvalidated object a caller might hand the validator, keyed as the builder would. */
function rawEvent(input: LifecycleEventInput): unknown {
  return { schema: 1, ...input, eventKey: lifecycleEventKey(input) };
}

/** Each refusal, the field the validator must name, and the fixture it is cut from. */
const REFUSED: { name: string; input: LifecycleEventInput; field: string }[] = [
  {
    name: "invocation role outside the enum",
    input: probeInput(1, { role: "boss" }),
    field: "role",
  },
  {
    name: "treatment role outside the enum",
    input: probeInput(0, {
      treatment: { roles: [{ role: "boss", provider: "claude" }] },
    }),
    field: "treatment.roles[0].role",
  },
  {
    name: "invocation result outside the enum",
    input: probeInput(1, { result: "bogus" }),
    field: "result",
  },
  {
    name: "gate result outside the enum",
    input: probeInput(3, { result: "maybe" }),
    field: "result",
  },
  {
    name: "follow_on outside the enum",
    input: probeInput(2, { followOn: "nope" }),
    field: "followOn",
  },
  {
    name: "outcome outside the enum",
    input: probeInput(4, { outcome: "maybe" }),
    field: "outcome",
  },
  {
    name: "attempt zero",
    input: probeInput(1, { attempt: 0 }),
    field: "attempt",
  },
  {
    name: "issueNumber fractional",
    input: probeInput(0, { issueNumber: 1.5 }),
    field: "issueNumber",
  },
  {
    name: "prNumber negative",
    input: probeInput(2, { prNumber: -1 }),
    field: "prNumber",
  },
  {
    name: "inputTokens negative",
    input: probeInput(1, { inputTokens: -1 }),
    field: "inputTokens",
  },
  {
    name: "inputTokens fractional",
    input: probeInput(1, { inputTokens: 1.5 }),
    field: "inputTokens",
  },
  {
    name: "durationSeconds negative",
    input: probeInput(1, { durationSeconds: -1 }),
    field: "durationSeconds",
  },
  {
    name: "estimatedApiCostUsd NaN",
    input: probeInput(1, { estimatedApiCostUsd: Number.NaN }),
    field: "estimatedApiCostUsd",
  },
  {
    name: "estimatedApiCostUsd Infinity",
    input: probeInput(1, { estimatedApiCostUsd: Number.POSITIVE_INFINITY }),
    field: "estimatedApiCostUsd",
  },
  {
    name: "reused not a boolean",
    input: probeInput(0, { reused: "yes" }),
    field: "reused",
  },
  {
    name: "recordedAt not a timestamp",
    input: probeInput(0, { recordedAt: "yesterday" }),
    field: "recordedAt",
  },
  {
    name: "assignedAt an impossible date",
    input: probeInput(0, { assignedAt: "2026-13-45T00:00:00Z" }),
    field: "assignedAt",
  },
  {
    name: "servedModels not an array",
    input: probeInput(1, { servedModels: "opus" }),
    field: "servedModels",
  },
  {
    name: "role item not an object",
    input: probeInput(0, { treatment: { roles: ["manager"] } }),
    field: "treatment.roles[0]",
  },
  {
    name: "treatment not an object",
    input: probeInput(0, { treatment: "manager" }),
    field: "treatment",
  },
  {
    name: "empty roles",
    input: probeInput(0, { treatment: { roles: [] } }),
    field: "treatment.roles",
  },
  {
    name: "roles not an array",
    input: probeInput(0, { treatment: { roles: "manager" } }),
    field: "treatment.roles",
  },
];

Deno.test("lifecycle ledger - each refusal names the field it broke", () => {
  for (const entry of REFUSED) {
    const error = assertThrows(
      () => validateLifecycleEvent(rawEvent(entry.input)),
      LifecycleEventSchemaError,
    );
    assertEquals(error.field, entry.field, entry.name);
  }
});

Deno.test("lifecycle ledger - a root value that is not an object is refused", () => {
  for (const value of [null, [], "x", 42]) {
    const error = assertThrows(
      () => validateLifecycleEvent(value),
      LifecycleEventSchemaError,
    );
    assertEquals(error.field, "(root)");
  }
});

Deno.test("lifecycle ledger - a wrong schema or unknown kind is refused by name", () => {
  const good = rawEvent(probeInput(0)) as Record<string, unknown>;
  const cases: [string, unknown, string][] = [
    ["schema 2", { ...good, schema: 2 }, "schema"],
    ["schema as a string", { ...good, schema: "1" }, "schema"],
    ["unknown kind", { ...good, kind: "mystery" }, "kind"],
  ];
  for (const [name, value, field] of cases) {
    const error = assertThrows(
      () => validateLifecycleEvent(value),
      LifecycleEventSchemaError,
    );
    assertEquals(error.field, field, name);
  }
});

Deno.test("lifecycle ledger - the base events the refusals are cut from validate", () => {
  for (let index = 0; index < 5; index++) {
    const input = probeInput(index);
    assertEquals(
      validateLifecycleEvent(rawEvent(input)),
      buildLifecycleEvent(input),
    );
  }
  // A null-prototype object is still a plain object, so it validates.
  const nullProto = Object.assign(
    Object.create(null),
    rawEvent(probeInput(0)) as Record<string, unknown>,
  );
  assertEquals(validateLifecycleEvent(nullProto).kind, "assignment");
});

Deno.test("lifecycle ledger - a role carrying an agent is accepted and round-trips", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/ledger.jsonl`;
    const event = buildLifecycleEvent(probeInput(0, {
      treatment: {
        roles: [{
          role: "executor",
          agent: "executor",
          provider: "claude",
          model: "sonnet",
          effort: "medium",
        }],
      },
    }));
    await appendLifecycleEvent(path, event);
    assertEquals(await readLifecycleLedger(path), [event]);
  });
});

Deno.test("lifecycle ledger - events without prNumber or agent are accepted and keyed", async () => {
  const cases: [LifecycleEventInput, string][] = [
    [
      probeInput(1, {}, ["agent"]),
      `invocation:${ASSIGNMENT_ID}:${RUN_ID}:executor:-:1`,
    ],
    [
      probeInput(2, {}, ["prNumber"]),
      `follow_on:${ASSIGNMENT_ID}:${RUN_ID}:ci_fix:-:1`,
    ],
    [
      probeInput(3, {}, ["prNumber"]),
      `gate:${ASSIGNMENT_ID}:${RUN_ID}:quality:1`,
    ],
    [
      probeInput(4, {}, ["prNumber"]),
      `outcome:${ASSIGNMENT_ID}:pr_opened:run-${RUN_ID}`,
    ],
  ];
  await withTempDir(async (dir) => {
    const path = `${dir}/ledger.jsonl`;
    const events: LifecycleEvent[] = [];
    for (const [input, key] of cases) {
      const event = buildLifecycleEvent(input);
      assertEquals(event.eventKey, key);
      await appendLifecycleEvent(path, event);
      events.push(event);
    }
    assertEquals(await readLifecycleLedger(path), events);
  });
});

Deno.test("lifecycle ledger - a valid JSON line that is not an object is refused as invalid", async () => {
  for (const literal of ["42", "[]", "null", '"text"']) {
    await withTempDir(async (dir) => {
      const path = `${dir}/ledger.jsonl`;
      await appendLifecycleEvent(path, buildLifecycleEvent(probeInput(0)));
      await Deno.writeTextFile(path, literal + "\n", { append: true });
      const error = await assertRejects(
        () => readLifecycleLedger(path),
        LifecycleLedgerReadError,
      );
      assertEquals(error.reason, "invalid", literal);
      assertEquals(error.line, 2, literal);
    });
  }
});

Deno.test("lifecycle ledger - a whitespace-only line between events is skipped", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/ledger.jsonl`;
    const first = buildLifecycleEvent(probeInput(1));
    const second = buildLifecycleEvent(probeInput(2));
    await appendLifecycleEvent(path, first);
    await Deno.writeTextFile(path, " \t \n", { append: true });
    await appendLifecycleEvent(path, second);
    assertEquals(await readLifecycleLedger(path), [first, second]);
  });
});
