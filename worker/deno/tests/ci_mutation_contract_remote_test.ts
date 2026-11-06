/**
 * Tests for the parts of lib/ci_mutation_contract.ts that read beyond the local
 * files (Issue #4617): remote reusable workflows fetched through an injected
 * reader, the base branch's required checks, and the cargo-mutants `--timeout`,
 * `--cargo-arg` and `--test-tool` flags.
 *
 * Each fixture is a fresh temporary repository, removed in `finally`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  extractCargoMutantsArgs,
  findBlockingMutationJob,
  type RemoteWorkflowRef,
  remoteWorkflowRef,
} from "../lib/ci_mutation_contract.ts";

const REMOTE = "acme/ci/.github/workflows/mutants.yml@v1";

Deno.test("reusable mutation jobs match their own required checks and feeders", async () => {
  const pipeline =
    "on: workflow_call\njobs:\n  tests:\n    steps:\n      - run: cargo test\n  mutants:\n    steps:\n      - run: cargo mutants\n  gate:\n    needs: mutants\n    steps:\n      - run: echo ok\n";
  for (const remote of [false, true]) {
    const uses = remote ? REMOTE : "./.github/workflows/pipeline.yml";
    await withRepo({
      "ci.yml": `on: pull_request\njobs:\n  build:\n    uses: ${uses}\n`,
      ...(remote ? {} : { "pipeline.yml": pipeline }),
    }, async (repo) => {
      const { fetchRemoteWorkflow } = reader({ [REMOTE]: pipeline });
      for (
        const [check, expected] of [["build / tests", false], [
          "build / mutants",
          true,
        ], ["build / gate", true]] as const
      ) {
        const result = await findBlockingMutationJob(repo, {
          fetchRemoteWorkflow,
          requiredChecks: [check],
        });
        assertEquals(result.blocking !== null, expected, check);
      }
    });
  }
});

Deno.test("matrix reusable callers match the required child, not its sibling", async () => {
  const pipeline =
    "on: workflow_call\njobs:\n  tests:\n    steps:\n      - run: cargo test\n  mutants:\n    steps:\n      - run: cargo mutants\n";
  for (const remote of [false, true]) {
    const uses = remote ? REMOTE : "./.github/workflows/pipeline.yml";
    await withRepo({
      "ci.yml":
        `on: pull_request\njobs:\n  build:\n    strategy:\n      matrix:\n        os: [linux, mac]\n    uses: ${uses}\n`,
      ...(remote ? {} : { "pipeline.yml": pipeline }),
    }, async (repo) => {
      const { fetchRemoteWorkflow } = reader({ [REMOTE]: pipeline });
      for (
        const [check, expected] of [["build (linux) / tests", false], [
          "build (linux) / mutants",
          true,
        ]] as const
      ) {
        const result = await findBlockingMutationJob(repo, {
          fetchRemoteWorkflow,
          requiredChecks: [check],
        });
        assertEquals(result.blocking !== null, expected, check);
      }
    });
  }
});

Deno.test("later reusable callers retain their required mutation jobs", async () => {
  const pipeline =
    "on: workflow_call\njobs:\n  mutants:\n    steps:\n      - run: cargo mutants\n";
  for (const remote of [false, true]) {
    const uses = remote ? REMOTE : "./.github/workflows/pipeline.yml";
    await withRepo({
      "ci.yml":
        `on: pull_request\njobs:\n  advisory:\n    uses: ${uses}\n  release:\n    uses: ${uses}\n  gate:\n    needs: [release]\n    steps:\n      - run: echo ok\n`,
      ...(remote ? {} : { "pipeline.yml": pipeline }),
    }, async (repo) => {
      const { fetchRemoteWorkflow } = reader({ [REMOTE]: pipeline });
      for (const check of ["release / mutants", "gate"]) {
        const result = await findBlockingMutationJob(repo, {
          fetchRemoteWorkflow,
          requiredChecks: [check],
        });
        assertEquals(
          result.blocking?.job.includes("release"),
          true,
          `${uses}: ${check}`,
        );
      }
    });
  }
});

Deno.test("templated reusable caller names conservatively cover mutation children", async () => {
  const pipeline =
    "on: workflow_call\njobs:\n  mutants:\n    steps:\n      - run: cargo mutants\n";
  for (const remote of [false, true]) {
    const uses = remote ? REMOTE : "./.github/workflows/pipeline.yml";
    for (
      const [name, matrix, check] of [
        [
          "Build ${{ matrix.os }}",
          "    strategy:\n      matrix:\n        os: [linux]\n",
          "Build linux / mutants",
        ],
        ["Build ${{ github.event_name }}", "", "Build core / mutants"],
      ]
    ) {
      await withRepo({
        "ci.yml":
          `on: pull_request\njobs:\n  build:\n    name: ${name}\n${matrix}    uses: ${uses}\n`,
        ...(remote ? {} : { "pipeline.yml": pipeline }),
      }, async (repo) => {
        const { fetchRemoteWorkflow } = reader({ [REMOTE]: pipeline });
        const result = await findBlockingMutationJob(repo, {
          fetchRemoteWorkflow,
          requiredChecks: [check!],
        });
        assertEquals(result.blocking !== null, true, `${uses}: ${check}`);
      });
    }
  }
});

Deno.test("nested reusable checks match the complete child path", async () => {
  await withRepo({
    "ci.yml":
      "on: pull_request\njobs:\n  build:\n    uses: ./.github/workflows/mid.yml\n",
    "mid.yml":
      "on: workflow_call\njobs:\n  inner:\n    uses: ./.github/workflows/end.yml\n",
    "end.yml":
      "on: workflow_call\njobs:\n  tests:\n    steps:\n      - run: cargo test\n  mutants:\n    steps:\n      - run: cargo mutants\n",
  }, async (repo) => {
    for (
      const [check, expected] of [["build / inner / tests", false], [
        "build / inner / mutants",
        true,
      ]] as const
    ) {
      const result = await findBlockingMutationJob(repo, {
        requiredChecks: [check],
      });
      assertEquals(result.blocking !== null, expected, check);
    }
  });
});

async function withRepo(
  workflows: Record<string, string>,
  body: (repo: string) => Promise<void>,
): Promise<void> {
  const repo = await Deno.makeTempDir({ prefix: "ci_mutation_remote_" });
  try {
    const dir = `${repo}/.github/workflows`;
    await Deno.mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(workflows)) {
      await Deno.writeTextFile(`${dir}/${name}`, text);
    }
    await body(repo);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
}

function callerOf(uses: string): string {
  return [
    "on: pull_request",
    "jobs:",
    "  mutants:",
    `    uses: ${uses}`,
    "  gate:",
    "    needs: [mutants]",
    "    steps:",
    "      - run: echo ok",
    "",
  ].join("\n");
}

function remoteBody(script = "cargo mutants --package core"): string {
  return [
    "on: workflow_call",
    "jobs:",
    "  run:",
    "    steps:",
    `      - run: ${script}`,
    "",
  ].join("\n");
}

/** A reader that serves `files` by `owner/repo/path@ref` and records its calls. */
function reader(files: Record<string, string>) {
  const calls: string[] = [];
  const fetchRemoteWorkflow = (ref: RemoteWorkflowRef) => {
    const key = `${ref.repo}/${ref.path}@${ref.ref}`;
    calls.push(key);
    return Promise.resolve(files[key] ?? null);
  };
  return { calls, fetchRemoteWorkflow };
}

Deno.test("a remote PR workflow reached only from a non-PR path is not a local PR workflow", async () => {
  await withRepo({
    "push.yml":
      "on: push\njobs:\n  call:\n    uses: ./.github/workflows/local.yml\n",
    "local.yml": `on: workflow_call\njobs:\n  call:\n    uses: ${REMOTE}\n`,
  }, async (repo) => {
    const { calls, fetchRemoteWorkflow } = reader({
      [REMOTE]: remoteBody().replace(
        "on: workflow_call",
        "on: [workflow_call, pull_request]",
      ),
    });
    assertEquals(await findBlockingMutationJob(repo, { fetchRemoteWorkflow }), {
      blocking: null,
      unreadable: [],
    });
    assertEquals(calls, [REMOTE]);
  });
});

Deno.test("a remote PR workflow with a templated job name does not bypass the caller's required check", async () => {
  await withRepo({
    "ci.yml":
      `on: pull_request\njobs:\n  mutants:\n    uses: ${REMOTE}\n  tests:\n    steps:\n      - run: cargo test\n`,
  }, async (repo) => {
    const { calls, fetchRemoteWorkflow } = reader({
      [REMOTE]: remoteBody().replace(
        "on: workflow_call",
        "on: [workflow_call, pull_request]",
      )
        .replace("  run:", "  run:\n    name: Mutants ${{ inputs.crate }}"),
    });
    assertEquals(
      await findBlockingMutationJob(repo, {
        fetchRemoteWorkflow,
        requiredChecks: ["tests"],
      }),
      { blocking: null, unreadable: [] },
    );
    assertEquals(calls, [REMOTE]);
  });
});

Deno.test("a remote reusable workflow with a blocking mutants job is followed when fetched", async () => {
  await withRepo({ "ci.yml": callerOf(REMOTE) }, async (repo) => {
    const { calls, fetchRemoteWorkflow } = reader({ [REMOTE]: remoteBody() });
    assertEquals(await findBlockingMutationJob(repo, { fetchRemoteWorkflow }), {
      blocking: {
        tool: "cargo",
        workflow: "ci.yml",
        job: `mutants (reusable ${REMOTE}: run)`,
        aggregator: "gate",
        cargoArgs: ["--package", "core"],
      },
      unreadable: [],
    });
    assertEquals(calls, [REMOTE]);
    // Control: without a reader the call is not followed, as before.
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("a remote workflow that cannot fail, or has no mutants job, is not blocking", async () => {
  for (
    const body of [
      remoteBody("cargo mutants || true"),
      remoteBody("cargo test"),
    ]
  ) {
    await withRepo({ "ci.yml": callerOf(REMOTE) }, async (repo) => {
      const { fetchRemoteWorkflow } = reader({ [REMOTE]: body });
      assertEquals(
        await findBlockingMutationJob(repo, { fetchRemoteWorkflow }),
        { blocking: null, unreadable: [] },
      );
    });
  }
});

Deno.test("a remote workflow that cannot be fetched or parsed is reported unreadable", async () => {
  for (
    const files of [
      {} as Record<string, string>,
      { [REMOTE]: "on: [unterminated\n  jobs: {" },
      { [REMOTE]: "on: push\njobs: {}\n" },
    ]
  ) {
    await withRepo({ "ci.yml": callerOf(REMOTE) }, async (repo) => {
      const { fetchRemoteWorkflow } = reader(files);
      assertEquals(
        await findBlockingMutationJob(repo, { fetchRemoteWorkflow }),
        { blocking: null, unreadable: [REMOTE] },
      );
    });
  }
  await withRepo({ "ci.yml": callerOf(REMOTE) }, async (repo) => {
    assertEquals(
      await findBlockingMutationJob(repo, {
        fetchRemoteWorkflow: () => Promise.reject(new Error("offline")),
      }),
      { blocking: null, unreadable: [REMOTE] },
    );
  });
});

Deno.test("remote workflows follow explicit and relative calls at the calling ref", async () => {
  const inner = "acme/ci/.github/workflows/inner.yml@v2";
  const mid = [
    "on: workflow_call",
    "jobs:",
    "  mid:",
    `    uses: ${inner}`,
    "",
  ].join("\n");
  await withRepo({ "ci.yml": callerOf(REMOTE) }, async (repo) => {
    const { fetchRemoteWorkflow } = reader({
      [REMOTE]: mid,
      [inner]: remoteBody(),
    });
    assertEquals(
      (await findBlockingMutationJob(repo, { fetchRemoteWorkflow }))
        .blocking?.job,
      `mutants (reusable ${REMOTE}: mid (reusable ${inner}: run))`,
    );
  });
  // The local path names the remote repository at the calling ref.
  const localInside = [
    "on: workflow_call",
    "jobs:",
    "  mid:",
    "    uses: ./.github/workflows/inner.yml",
    "",
  ].join("\n");
  await withRepo({
    "ci.yml": callerOf(REMOTE),
    "mutants.yml": remoteBody(),
  }, async (repo) => {
    const nested = "acme/ci/.github/workflows/inner.yml@v1";
    const { fetchRemoteWorkflow } = reader({
      [REMOTE]: localInside,
      [nested]: remoteBody(),
    });
    const result = await findBlockingMutationJob(repo, { fetchRemoteWorkflow });
    assertEquals(
      result.blocking?.job,
      `mutants (reusable ${REMOTE}: mid (reusable ${nested}: run))`,
    );
    assertEquals(result.unreadable, []);
    const missing = reader({ [REMOTE]: localInside });
    assertEquals((await findBlockingMutationJob(repo, missing)).unreadable, [
      nested,
    ]);
  });
});

Deno.test("a remote workflow that calls itself ends and fetching is bounded", async () => {
  const self = [
    "on: workflow_call",
    "jobs:",
    "  again:",
    `    uses: ${REMOTE}`,
    "",
  ].join("\n");
  await withRepo({ "ci.yml": callerOf(REMOTE) }, async (repo) => {
    const { calls, fetchRemoteWorkflow } = reader({ [REMOTE]: self });
    assertEquals(
      await findBlockingMutationJob(repo, { fetchRemoteWorkflow }),
      { blocking: null, unreadable: [] },
    );
    assertEquals(calls, [REMOTE]);
  });
  const many = Array.from(
    { length: 12 },
    (_, i) => `  j${i}:\n    uses: acme/ci/.github/workflows/w${i}.yml@v1`,
  );
  await withRepo({
    "ci.yml": ["on: pull_request", "jobs:", ...many, ""].join("\n"),
  }, async (repo) => {
    const { calls, fetchRemoteWorkflow } = reader({});
    const result = await findBlockingMutationJob(repo, { fetchRemoteWorkflow });
    assertEquals(calls.length, 8);
    assertEquals(result.unreadable.length, 12);
  });
});

Deno.test("only owner/repo/.github/workflows/<file>@ref is a remote reusable call", () => {
  assertEquals(remoteWorkflowRef(REMOTE), {
    repo: "acme/ci",
    path: ".github/workflows/mutants.yml",
    ref: "v1",
  });
  for (
    const uses of [
      "acme/ci/.github/workflows/mutants.yml",
      "acme/ci/.github/workflows/sub/mutants.yml@v1",
      "acme/ci/.github/workflows/../x.yml@v1",
      "../../.github/workflows/x.yml@v1",
      "./x/.github/workflows/x.yml@v1",
      "acme/../.github/workflows/x.yml@v1",
      "acme/ci/.github/workflows/mutants.yml@${{ github.sha }}",
      "./.github/workflows/mutants.yml@v1",
      "actions/checkout@v4",
    ]
  ) assertEquals(remoteWorkflowRef(uses), null, uses);
  assertEquals(remoteWorkflowRef(undefined), null);
  // A repository may be named `.github`.
  assertEquals(
    remoteWorkflowRef("acme/.github/.github/workflows/x.yml@main")?.repo,
    "acme/.github",
  );
});

const AGGREGATED = [
  "on: pull_request",
  "jobs:",
  "  mutants:",
  "    steps:",
  "      - run: cargo mutants",
  "  tests:",
  "    steps:",
  "      - run: cargo test",
  "  gate:",
  "    needs: [tests, mutants]",
  "    steps:",
  "      - run: echo ok",
  "",
].join("\n");

Deno.test("a mutants job counts when its own check, or an aggregator needing it, is required", async () => {
  await withRepo({ "ci.yml": AGGREGATED }, async (repo) => {
    for (const requiredChecks of [["mutants"], ["gate"], ["tests", "gate"]]) {
      const blocking = (await findBlockingMutationJob(repo, { requiredChecks }))
        .blocking;
      assertEquals(blocking?.job, "mutants", requiredChecks.join());
      assertEquals(blocking?.aggregator, "gate", requiredChecks.join());
    }
  });
});

Deno.test("a mutants job that no required check covers is not blocking", async () => {
  await withRepo({ "ci.yml": AGGREGATED }, async (repo) => {
    assertEquals(
      await findBlockingMutationJob(repo, { requiredChecks: ["tests"] }),
      { blocking: null, unreadable: [] },
    );
    // Unknown or empty required checks keep any PR-triggered job counting.
    for (const requiredChecks of [undefined, []]) {
      assertEquals(
        (await findBlockingMutationJob(repo, { requiredChecks })).blocking?.job,
        "mutants",
      );
    }
  });
});

Deno.test("the scan continues past a job that is not required", async () => {
  await withRepo({
    "ci.yml": [
      "on: pull_request",
      "jobs:",
      "  advisory:",
      "    steps:",
      "      - run: cargo mutants",
      "  deno_mutation:",
      "    name: Mutation (deno)",
      "    steps:",
      "      - run: deno task mutation-check",
      "",
    ].join("\n"),
  }, async (repo) => {
    const blocking = (await findBlockingMutationJob(repo, {
      requiredChecks: ["Mutation (deno)"],
    })).blocking;
    assertEquals(blocking?.job, "deno_mutation");
    assertEquals(blocking?.tool, "deno_task");
  });
});

Deno.test("required checks match matrix and reusable children, and a templated name counts", async () => {
  await withRepo({
    "ci.yml": [
      "on: pull_request",
      "jobs:",
      "  mutants:",
      "    strategy:",
      "      matrix:",
      "        shard: [1, 2]",
      "    steps:",
      "      - run: cargo mutants",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(
      (await findBlockingMutationJob(repo, {
        requiredChecks: ["mutants (1)"],
      })).blocking?.job,
      "mutants",
    );
  });
  await withRepo({
    "ci.yml": callerOf("./.github/workflows/m.yml"),
    "m.yml": remoteBody(),
  }, async (repo) => {
    assertEquals(
      (await findBlockingMutationJob(repo, {
        requiredChecks: ["mutants / run"],
      })).blocking?.job,
      "mutants (reusable m.yml: run)",
    );
  });
  await withRepo({
    "ci.yml": [
      "on: pull_request",
      "jobs:",
      "  mutants:",
      "    name: mutants ${{ matrix.os }}",
      "    steps:",
      "      - run: cargo mutants",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(
      (await findBlockingMutationJob(repo, {
        requiredChecks: ["something-else"],
      })).blocking?.job,
      "mutants",
    );
  });
});

Deno.test("a required check reached through a chain of needs covers the mutants job", async () => {
  await withRepo({
    "ci.yml": [
      "on: pull_request",
      "jobs:",
      "  mutants:",
      "    steps:",
      "      - run: cargo mutants",
      "  mid:",
      "    needs: mutants",
      "    steps:",
      "      - run: echo mid",
      "  gate:",
      "    needs: [mid]",
      "    steps:",
      "      - run: echo ok",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(
      (await findBlockingMutationJob(repo, { requiredChecks: ["gate"] }))
        .blocking?.aggregator,
      "gate",
    );
  });
});

Deno.test("extractCargoMutantsArgs carries --timeout, --cargo-arg and --test-tool", () => {
  assertEquals(
    extractCargoMutantsArgs(
      "cargo mutants --timeout 60 --cargo-arg --release --cargo-arg=--locked --test-tool nextest",
    ),
    [
      "--timeout",
      "60",
      "--cargo-arg",
      "--release",
      "--cargo-arg",
      "--locked",
      "--test-tool",
      "nextest",
    ],
  );
  assertEquals(extractCargoMutantsArgs("cargo mutants --timeout=2.5"), [
    "--timeout",
    "2.5",
  ]);
});

Deno.test("extractCargoMutantsArgs drops a malformed timeout, test tool or cargo arg", () => {
  for (
    const line of [
      "cargo mutants --timeout soon",
      "cargo mutants --timeout -5",
      "cargo mutants --test-tool make",
      "cargo mutants --cargo-arg $(evil)",
      "cargo mutants --cargo-arg ;rm",
      "cargo mutants --cargo-arg 'a b'",
      `cargo mutants --cargo-arg ${"-".repeat(501)}`,
      "cargo mutants --timeout",
    ]
  ) assertEquals(extractCargoMutantsArgs(line), [], line);
});
