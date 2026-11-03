/**
 * Tests for lib/ci_mutation_contract.ts — whether the repository's CI blocks
 * on a mutation-testing job (Issue #4617).
 *
 * Covers: the cargo-mutants and `deno task *mutat*` invocations (including a
 * `+toolchain` word and line continuations), the continue-on-error exemptions
 * at job and step level, the no-op tail exemptions (`|| true`, `|| :`,
 * `|| exit 0`, `|| /bin/true`), trigger shapes (string, array, object,
 * `pull_request_target`), a missing workflows directory, unreadable workflow
 * files, mentions that are not in a `run`, multi-line `run` blocks, and
 * pathological lines that must not stall.
 *
 * Each fixture is a fresh temporary repository, removed in `finally`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  blockingMutationLine,
  findBlockingMutationJob,
} from "../lib/ci_mutation_contract.ts";
import { assertLinearGrowth } from "./support/growth.ts";

Deno.test("symlinked workflows outside the checkout are unreadable", async () => {
  await withRepo({
    "outside.yml":
      "on: pull_request\njobs:\n  outside_job:\n    steps:\n      - run: cargo mutants\n",
  }, async (outside) => {
    await withRepo({}, async (repo) => {
      await Deno.symlink(
        `${outside}/.github/workflows/outside.yml`,
        `${repo}/.github/workflows/link.yml`,
      );
      assertEquals(await findBlockingMutationJob(repo), {
        blocking: null,
        unreadable: ["link.yml"],
      });
    });
  });
});

Deno.test("symlinked workflow directories are unreadable", async () => {
  await withRepo(
    { "outside.yml": prWorkflow("cargo mutants") },
    async (outside) => {
      for (const component of [".github", ".github/workflows"]) {
        await withRepo(undefined, async (repo) => {
          if (component.endsWith("workflows")) {
            await Deno.mkdir(`${repo}/.github`);
          }
          const target = component.endsWith("workflows")
            ? `${outside}/.github/workflows`
            : `${outside}/.github`;
          await Deno.symlink(target, `${repo}/${component}`);
          assertEquals(await findBlockingMutationJob(repo), {
            blocking: null,
            unreadable: [component],
          });
        });
      }
    },
  );
});

Deno.test("aliased run strings exceeding the scan budget are unreadable", async () => {
  const workflow =
    "on: pull_request\njobs:\n  check:\n    steps:\n      - run: &r |\n" +
    "          echo x\n".repeat(5000) + "      - run: *r\n".repeat(100);
  await withRepo({ "aliases.yml": workflow }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: ["aliases.yml"],
    });
  });
});

Deno.test("scan budget counts run characters across jobs", () => {
  const budget = { remaining: 10 };
  const seen = new WeakSet<object>();
  assertEquals(
    blockingMutationLine({ steps: [{ run: "echo x" }] }, seen, budget),
    null,
  );
  assertEquals(budget.remaining, 4);
  assertThrows(() =>
    blockingMutationLine({ steps: [{ run: "echo x" }] }, seen, budget)
  );
});

Deno.test("oversized workflows are unreadable before parsing", async () => {
  await withRepo({
    "large.yml":
      "on: pull_request\njobs:\n  mutants:\n    steps:\n      - run: cargo mutants\n#" +
      "x".repeat(1024 * 1024),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: ["large.yml"],
    });
  });
});

Deno.test("continued workflow lines have linear growth", () => {
  assertEquals(
    assertLinearGrowth(
      "continued workflow lines",
      (n) => "a \\\n".repeat(n),
      (run) => blockingMutationLine({ steps: [{ run }] }),
      { baseChars: 20000 },
    ),
    null,
  );
});

Deno.test("repeated aliased steps are scanned once across jobs", () => {
  let scans = 0;
  const step = {
    get run() {
      scans++;
      if (scans > 2) throw new Error("aliased run scanned again");
      return "a \\\n".repeat(80000);
    },
  };
  const seen = new WeakSet<object>();
  for (let i = 0; i < 100; i++) {
    assertEquals(
      blockingMutationLine({ steps: Array(100).fill(step) }, seen),
      null,
    );
  }
  assertEquals(scans, 2);
});

Deno.test("many continued lines and YAML step aliases remain non-blocking", async () => {
  const workflow =
    "on: pull_request\njobs:\n  check:\n    steps:\n      - &s\n        run: |\n" +
    "          a \\\n".repeat(40000) + "      - *s\n".repeat(100);
  await withRepo({ "aliases.yml": workflow }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

/**
 * Creates a temporary repository holding the given workflow files under
 * `.github/workflows/`, or no `.github` directory at all when `workflows` is
 * `undefined`. The directory is removed after `body` finishes.
 */
async function withRepo(
  workflows: Record<string, string> | undefined,
  body: (repo: string) => Promise<void>,
): Promise<void> {
  const repo = await Deno.makeTempDir({ prefix: "ci_mutation_contract_" });
  try {
    if (workflows !== undefined) {
      const dir = `${repo}/.github/workflows`;
      await Deno.mkdir(dir, { recursive: true });
      for (const [name, text] of Object.entries(workflows)) {
        await Deno.writeTextFile(`${dir}/${name}`, text);
      }
    }
    await body(repo);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
}

Deno.test("cargo mutants on a pull_request job is blocking", async () => {
  await withRepo({
    "mutants.yml": [
      "name: mutants",
      "on:",
      "  pull_request:",
      "jobs:",
      "  mutants:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: cargo mutants --in-place",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "mutants.yml",
        job: "mutants",
        cargoArgs: [],
      },
      unreadable: [],
    });
  });
});

Deno.test("cargo-mutants (hyphen form) is blocking", async () => {
  await withRepo({
    "mutation.yaml": [
      "on: pull_request",
      "jobs:",
      "  mutation:",
      "    steps:",
      "      - run: cargo-mutants --workspace",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "mutation.yaml",
        job: "mutation",
        cargoArgs: ["--workspace"],
      },
      unreadable: [],
    });
  });
});

Deno.test("deno task mutation-check is blocking", async () => {
  await withRepo({
    "check.yml": [
      "on: pull_request",
      "jobs:",
      "  check:",
      "    steps:",
      "      - run: deno task mutation-check",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "deno_task",
        workflow: "check.yml",
        job: "check",
        cargoArgs: [],
      },
      unreadable: [],
    });
  });
});

Deno.test("job-level continue-on-error: true is not blocking", async () => {
  await withRepo({
    "mutants.yml": [
      "on: pull_request",
      "jobs:",
      "  mutants:",
      "    continue-on-error: true",
      "    steps:",
      "      - run: cargo mutants",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("step-level continue-on-error: true is not blocking", async () => {
  await withRepo({
    "mutants.yml": [
      "on:",
      "  pull_request:",
      "jobs:",
      "  mutants:",
      "    steps:",
      "      - run: cargo mutants",
      "        continue-on-error: true",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("cargo mutants followed by || true is not blocking", async () => {
  await withRepo({
    "mutants.yml": [
      "on: pull_request",
      "jobs:",
      "  mutants:",
      "    steps:",
      "      - run: cargo mutants --in-place || true",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("trigger shapes: push, pull_request_target, array and object", async () => {
  const job = [
    "jobs:",
    "  mutants:",
    "    steps:",
    "      - run: cargo mutants",
    "",
  ];

  await withRepo({
    "mutants.yml": ["on: push", ...job].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });

  await withRepo({
    "mutants.yml": ["on: pull_request_target", ...job].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });

  await withRepo({
    "mutants.yml": ["on: [push, pull_request]", ...job].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "mutants.yml",
        job: "mutants",
        cargoArgs: [],
      },
      unreadable: [],
    });
  });

  await withRepo({
    "mutants.yml": ["on:", "  push:", "  pull_request:", ...job].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "mutants.yml",
        job: "mutants",
        cargoArgs: [],
      },
      unreadable: [],
    });
  });

  // YAML 1.1 reads a bare `on` key as boolean true; the parser may yield
  // either key, and the trigger must still be recognised.
  await withRepo({
    "mutants.yml": ["true:", "  pull_request:", ...job].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "mutants.yml",
        job: "mutants",
        cargoArgs: [],
      },
      unreadable: [],
    });
  });
});

Deno.test("missing .github/workflows directory returns no blocking job", async () => {
  await withRepo(undefined, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("malformed workflow is reported unreadable; valid sibling still found", async () => {
  await withRepo({
    "z_broken.yml": "on: [pull_request\njobs: : :\n",
    "a_mutants.yml": [
      "on: pull_request",
      "jobs:",
      "  mutants:",
      "    steps:",
      "      - run: cargo mutants",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "a_mutants.yml",
        job: "mutants",
        cargoArgs: [],
      },
      unreadable: ["z_broken.yml"],
    });
  });
});

Deno.test("cargo mutants only in name or comment is not blocking", async () => {
  await withRepo({
    "mutants.yml": [
      "name: cargo mutants nightly",
      "# cargo mutants is slow, so it is not run here",
      "on: pull_request",
      "jobs:",
      "  mutants:",
      "    steps:",
      "      - run: echo done",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("cargo mutants on the second line of a run block is blocking", async () => {
  await withRepo({
    "mutants.yml": [
      "on: pull_request",
      "jobs:",
      "  mutants:",
      "    steps:",
      "      - run: |",
      "          echo preparing",
      "          cargo mutants --in-place",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "mutants.yml",
        job: "mutants",
        cargoArgs: [],
      },
      unreadable: [],
    });
  });
});

Deno.test("a 200000-space run line returns promptly without a match", async () => {
  const hostile = " ".repeat(200000) + "x";
  await withRepo({
    "mutants.yml": [
      "on: pull_request",
      "jobs:",
      "  mutants:",
      "    steps:",
      "      - run: |",
      `          ${hostile}`,
      "",
    ].join("\n"),
  }, async (repo) => {
    const result = await findBlockingMutationJob(repo);
    assertEquals(result.blocking, null);
  });
});

/**
 * A pull_request workflow whose single step runs `script` as a block scalar, so
 * shell punctuation such as `:` needs no YAML quoting.
 */
function prWorkflow(script: string): string {
  const body = script.split("\n").map((line) => `          ${line}`).join("\n");
  return [
    "on: pull_request",
    "jobs:",
    "  mutants:",
    "    steps:",
    "      - run: |",
    body,
    "",
  ].join("\n");
}

Deno.test("each no-op tail on a cargo mutants line is not blocking", async () => {
  const tails = [
    "|| true",
    "||true",
    "|| :",
    "|| exit 0",
    "|| /bin/true",
    "|| true;",
    "|| true ;",
  ];
  for (const tail of tails) {
    await withRepo(
      { "mutants.yml": prWorkflow(`cargo mutants ${tail}`) },
      async (repo) => {
        assertEquals(
          await findBlockingMutationJob(repo),
          { blocking: null, unreadable: [] },
          `tail: ${tail}`,
        );
      },
    );
  }
});

Deno.test("a no-op tail after a comment marker does not exempt cargo mutants", async () => {
  // In shell the `|| true` sits inside the comment, so the step still fails.
  await withRepo(
    { "mutants.yml": prWorkflow("cargo mutants # || true") },
    async (repo) => {
      assertEquals(await findBlockingMutationJob(repo), {
        blocking: {
          tool: "cargo",
          workflow: "mutants.yml",
          job: "mutants",
          cargoArgs: [],
        },
        unreadable: [],
      });
    },
  );
});

Deno.test("a trailing || true after an && chain is non-failing", async () => {
  // `(cargo mutants && echo done) || true` exits 0 whether or not mutants fails.
  await withRepo({
    "mutants.yml": prWorkflow("cargo mutants && echo done || true"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("a no-op tail on a different command does not exempt cargo mutants", async () => {
  await withRepo({
    "mutants.yml": prWorkflow('echo "|| true" ; cargo mutants'),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "mutants.yml",
        job: "mutants",
        cargoArgs: [],
      },
      unreadable: [],
    });
  });
});

Deno.test("cargo +toolchain mutants is blocking", async () => {
  await withRepo({
    "mutants.yml": prWorkflow("cargo +nightly mutants --in-place"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "mutants.yml",
        job: "mutants",
        cargoArgs: [],
      },
      unreadable: [],
    });
  });
});

Deno.test("a line continuation joins cargo and mutants", async () => {
  await withRepo({
    "mutants.yml": prWorkflow(["cargo \\", "  mutants --in-place"].join("\n")),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "mutants.yml",
        job: "mutants",
        cargoArgs: [],
      },
      unreadable: [],
    });
  });
});

Deno.test("a line continuation into a no-op tail is not blocking", async () => {
  await withRepo({
    "mutants.yml": prWorkflow(["cargo mutants \\", "  || true"].join("\n")),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("hostile: cargo then a 200000-char run returns promptly without a match", async () => {
  await withRepo({
    "mutants.yml": prWorkflow("cargo" + " ".repeat(200000) + "x"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("hostile: deno task with a 200000-char name and no mutat returns promptly", async () => {
  await withRepo({
    "check.yml": prWorkflow("deno task " + "a".repeat(200000)),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("hostile: cargo + with a 200000-char toolchain and no mutants returns promptly", async () => {
  await withRepo({
    "mutants.yml": prWorkflow("cargo +" + "x".repeat(200000)),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("hostile: a 200000-space run before a non-no-op tail returns promptly", async () => {
  // The line does not end in a no-op tail, so cargo mutants still counts.
  await withRepo({
    "mutants.yml": prWorkflow("cargo mutants" + " ".repeat(200000) + "|| x"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "mutants.yml",
        job: "mutants",
        cargoArgs: [],
      },
      unreadable: [],
    });
  });
});

import { extractCargoMutantsArgs } from "../lib/ci_mutation_contract.ts";

Deno.test("installation does not count as a mutation run", async () => {
  for (
    const install of [
      "cargo install --locked cargo-mutants",
      "cargo binstall cargo-mutants",
    ]
  ) {
    await withRepo({
      "mutants.yml": prWorkflow(`${install}\n        cargo mutants || true`),
    }, async (repo) => {
      assertEquals((await findBlockingMutationJob(repo)).blocking, null);
    });
    await withRepo({
      "mutants.yml": prWorkflow(
        `${install}\n        cargo mutants --file 'src/core/**'`,
      ),
    }, async (repo) => {
      assertEquals((await findBlockingMutationJob(repo)).blocking?.cargoArgs, [
        "--file",
        "src/core/**",
      ]);
    });
  }
});

Deno.test("cargo mutant filter aliases are carried", () => {
  for (
    const flag of [
      "-e",
      "--re",
      "--regex",
      "--examine-regex",
      "--exclude-regex",
      "-f",
      "--file",
    ]
  ) {
    assertEquals(extractCargoMutantsArgs(`cargo mutants ${flag} pattern`), [
      flag,
      "pattern",
    ]);
  }
  assertEquals(
    extractCargoMutantsArgs("cargo mutants --exclude-file pattern"),
    [],
  );
});

Deno.test("a workflow entry that is a directory named like a workflow is skipped", async () => {
  await withRepo(undefined, async (repo) => {
    await Deno.mkdir(`${repo}/.github/workflows/mutants.yml`, {
      recursive: true,
    });
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("only .yml and .yaml files are workflows", async () => {
  await withRepo({
    "mutants.txt": prWorkflow("cargo mutants"),
    "mutants.yml.bak": prWorkflow("cargo mutants"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("a document that is a list, null or a scalar is unreadable, not blocking", async () => {
  await withRepo({
    "a.yml": "- on: pull_request\n",
    "b.yml": "null\n",
    "c.yml": "just text\n",
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: ["a.yml", "b.yml", "c.yml"],
    });
  });
});

Deno.test("jobs that are not a mapping are ignored", async () => {
  await withRepo({
    "a.yml": "on: pull_request\njobs:\n  - cargo mutants\n",
    "b.yml": "on: pull_request\njobs:\n  m: cargo mutants\n",
    "c.yml":
      "on: pull_request\njobs:\n  m:\n    steps:\n      - cargo mutants\n",
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test('continue-on-error: "true" (a string) is also not blocking, at job and step level', async () => {
  const job = (flagAt: "job" | "step") =>
    [
      "on: pull_request",
      "jobs:",
      "  m:",
      ...(flagAt === "job" ? ['    continue-on-error: "true"'] : []),
      "    steps:",
      "      - run: cargo mutants",
      ...(flagAt === "step" ? ['        continue-on-error: "true"'] : []),
      "",
    ].join("\n");
  await withRepo(
    { "a.yml": job("job"), "b.yml": job("step") },
    async (repo) => {
      assertEquals(await findBlockingMutationJob(repo), {
        blocking: null,
        unreadable: [],
      });
    },
  );
});

Deno.test("a trigger that is neither string, array nor mapping does not count", async () => {
  await withRepo({
    "a.yml": "on: 5\njobs:\n  m:\n    steps:\n      - run: cargo mutants\n",
    "b.yml": "on:\njobs:\n  m:\n    steps:\n      - run: cargo mutants\n",
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: null,
      unreadable: [],
    });
  });
});

Deno.test("a job another job needs is reported with its aggregator", async () => {
  await withRepo({
    "ci.yml": [
      "on: pull_request",
      "jobs:",
      "  mutants:",
      "    steps:",
      "      - run: cargo mutants --exclude-re 'impl Drop' --package core",
      "  gate:",
      "    needs: [lint, mutants]",
      "    steps:",
      "      - run: echo ok",
      "",
    ].join("\n"),
  }, async (repo) => {
    assertEquals(await findBlockingMutationJob(repo), {
      blocking: {
        tool: "cargo",
        workflow: "ci.yml",
        job: "mutants",
        aggregator: "gate",
        cargoArgs: ["--exclude-re", "impl Drop", "--package", "core"],
      },
      unreadable: [],
    });
  });
});

Deno.test("a string needs also names the aggregator; an unrelated needs does not", async () => {
  const wf = (needs: string) =>
    [
      "on: pull_request",
      "jobs:",
      "  mutants:",
      "    steps:",
      "      - run: cargo mutants",
      "  gate:",
      `    needs: ${needs}`,
      "    steps:",
      "      - run: echo ok",
      "",
    ].join("\n");
  await withRepo({ "ci.yml": wf("mutants") }, async (repo) => {
    assertEquals(
      (await findBlockingMutationJob(repo)).blocking?.aggregator,
      "gate",
    );
  });
  await withRepo({ "ci.yml": wf("lint") }, async (repo) => {
    assertEquals(
      (await findBlockingMutationJob(repo)).blocking?.aggregator,
      undefined,
    );
  });
});

Deno.test("extractCargoMutantsArgs keeps scope flags and drops the rest", () => {
  assertEquals(
    extractCargoMutantsArgs(
      "cargo mutants --in-diff pr.diff --jobs 4 --workspace --all-features --no-default-features -F serde -E=skip_me --features=a,b --output out",
    ),
    [
      "--workspace",
      "--all-features",
      "--no-default-features",
      "-F",
      "serde",
      "-E",
      "skip_me",
      "--features",
      "a,b",
    ],
  );
});

Deno.test("extractCargoMutantsArgs unquotes values and refuses unsafe ones", () => {
  assertEquals(
    extractCargoMutantsArgs(`cargo mutants --exclude-re "tracing"`),
    ["--exclude-re", "tracing"],
  );
  assertEquals(extractCargoMutantsArgs("cargo mutants -p $(evil)"), []);
  assertEquals(extractCargoMutantsArgs("cargo mutants -p --workspace"), [
    "--workspace",
  ]);
  assertEquals(extractCargoMutantsArgs("cargo mutants -p a;b"), []);
  assertEquals(
    extractCargoMutantsArgs(`cargo mutants -p ${"x".repeat(501)}`),
    [],
  );
  assertEquals(extractCargoMutantsArgs("cargo mutants -p "), []);
});

Deno.test("extractCargoMutantsArgs stops at a command separator and ignores other tools", () => {
  assertEquals(
    extractCargoMutantsArgs("cargo mutants && cargo build --features x"),
    [],
  );
  assertEquals(
    extractCargoMutantsArgs("cargo mutants ; cargo test -p x"),
    [],
  );
  assertEquals(extractCargoMutantsArgs("deno task mutation -p x"), []);
  assertEquals(extractCargoMutantsArgs("echo hi && cargo mutants -p core"), [
    "-p",
    "core",
  ]);
});

Deno.test("cargo scope flags survive command separators", () => {
  for (
    const command of [
      "cd x; cargo mutants -p core",
      "cargo install cargo-mutants; cargo mutants -p core",
      "a || cargo mutants -p core",
    ]
  ) assertEquals(extractCargoMutantsArgs(command), ["-p", "core"]);
});
Deno.test("hostile: separator then 200000 spaces and no cargo is not blocking", async () => {
  await withRepo({
    "mutants.yml": prWorkflow("echo ok;" + " ".repeat(200000) + "x"),
  }, async (repo) => {
    assertEquals((await findBlockingMutationJob(repo)).blocking, null);
  });
});
