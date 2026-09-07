/**
 * Regression tests for the fail-open safety-flag defect (Issue #1266).
 *
 * `mod.ts::parseArgs` JSON-parses every flag value and treats a value that
 * begins with `--` as the next flag, so a safety flag can reach a command as
 * a number, a string or a bare `true` standing in for a swallowed value.
 * Commands used to map every shape they did not recognise to `undefined`,
 * and `undefined` fell through to the **more dangerous** default: the flag
 * was inert exactly when the operator most believed it was set.
 *
 * Every test here feeds the output of the **real** parser into the real
 * `execute()`, which is the gap the pre-existing command tests left — they
 * hand-built `{"dry-run": true}` and never touched the parser, so this whole
 * class was invisible to them.
 *
 * Fail direction, both ways, for each site:
 *   - a malformed flag now selects the SAFE branch, loudly (the command
 *     refuses rather than proceeding); and
 *   - a well-formed flag still selects exactly what it asks for, so the
 *     guard is not simply refusing everything.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { parseArgs } from "../mod.ts";
import {
  coerceBooleanFlag,
  coerceStringListFlag,
  findUnknownOptions,
} from "../lib/command_args.ts";
import { bulkTriageSecurityCommand } from "../commands/bulk_triage_security.ts";
import { raiseAllIdleTasksCommand } from "../commands/raise_all_idle_tasks.ts";
import { raiseBoyScoutIdleTasksCommand } from "../commands/raise_boy_scout_idle_tasks.ts";
import { prManagerCommand } from "../commands/pr_manager.ts";
import { qualityGatePhaseCommand } from "../commands/quality_gate_phase.ts";
import { qualityHelpersCommand } from "../commands/quality_helpers.ts";
import { exportBrandingCommand } from "../commands/export_branding.ts";
import { cleanDenoCacheCommand } from "../commands/clean_deno_cache.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Result, WorkerConfig } from "../types.ts";
import { REPO_ROOT } from "./support/repo_root.ts";

const config = buildDefaultWorkerConfig();
const EMPTY_CONFIG = {} as unknown as WorkerConfig;

/**
 * Real parser output for a command line, plus any injected test seams.
 * The seams cannot travel through argv, so they are merged in afterwards —
 * everything the fix is about still comes from `parseArgs`.
 */
function cli(
  argv: string[],
  seams: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...parseArgs(argv).args, ...seams };
}

// =============================================================================
// The shared coercion helpers
// =============================================================================

Deno.test("coerceBooleanFlag - accepts the shapes a boolean flag really takes", () => {
  assertEquals(coerceBooleanFlag(undefined, "dry-run", false), {
    ok: true,
    value: false,
  });
  assertEquals(coerceBooleanFlag(undefined, "dry-run", true), {
    ok: true,
    value: true,
  });
  assertEquals(coerceBooleanFlag(true, "dry-run", false), {
    ok: true,
    value: true,
  });
  assertEquals(coerceBooleanFlag(false, "dry-run", true), {
    ok: true,
    value: false,
  });
  assertEquals(coerceBooleanFlag("true", "dry-run", false), {
    ok: true,
    value: true,
  });
  assertEquals(coerceBooleanFlag("false", "dry-run", true), {
    ok: true,
    value: false,
  });
});

Deno.test("coerceBooleanFlag - refuses every unreadable shape", () => {
  for (const bad of [1, 0, "1", "0", "yes", "on", "", [], {}]) {
    const result = coerceBooleanFlag(bad, "dry-run", false);
    assertEquals(result.ok, false, `expected --dry-run ${String(bad)} refused`);
    if (!result.ok) assertStringIncludes(result.error.message, "--dry-run");
  }
});

Deno.test("coerceStringListFlag - accepts CSV, arrays and absence", () => {
  assertEquals(coerceStringListFlag(undefined, "repos"), {
    ok: true,
    value: [],
  });
  // The single-repo string that used to be iterated character by character.
  assertEquals(coerceStringListFlag("owner/repo", "repos"), {
    ok: true,
    value: ["owner/repo"],
  });
  assertEquals(coerceStringListFlag("org/a, org/b", "repos"), {
    ok: true,
    value: ["org/a", "org/b"],
  });
  assertEquals(coerceStringListFlag(["org/a", "org/b"], "repos"), {
    ok: true,
    value: ["org/a", "org/b"],
  });
});

Deno.test("coerceStringListFlag - refuses present-but-unusable values", () => {
  for (const bad of [true, false, 5, "", "  ,  ", [], [1], {}]) {
    const result = coerceStringListFlag(bad, "monitored-repos");
    assertEquals(
      result.ok,
      false,
      `expected --monitored-repos ${JSON.stringify(bad)} refused`,
    );
    if (!result.ok) {
      assertStringIncludes(result.error.message, "--monitored-repos");
    }
  }
});

Deno.test("findUnknownOptions - names what the command does not accept", () => {
  const known: ReadonlySet<string> = new Set(["tree", "check"]);
  assertEquals(findUnknownOptions({ tree: "x", check: true }, known), []);
  assertEquals(
    findUnknownOptions({ tree: "x", "dry-run": true, force: true }, known),
    ["dry-run", "force"],
  );
});

// =============================================================================
// bulk-triage-security — --dry-run and --severities
// =============================================================================

interface StubLabelCall {
  repo: string;
  number: number;
  label: string;
}

function bulkSeams(): {
  seams: Record<string, unknown>;
  calls: StubLabelCall[];
  lines: string[];
} {
  const calls: StubLabelCall[] = [];
  const lines: string[] = [];
  const rows = [
    {
      number: 1,
      title: "high finding",
      url: "u/1",
      createdAt: "2026-05-01T00:00:00Z",
      labels: [{ name: "security" }, { name: "severity:high" }],
    },
    {
      number: 2,
      title: "low finding",
      url: "u/2",
      createdAt: "2026-05-01T00:00:00Z",
      labels: [{ name: "security" }, { name: "severity:low" }],
    },
  ];
  return {
    calls,
    lines,
    seams: {
      __testDeps: {
        log: (l: string) => lines.push(l),
        ghCommandFn: (_args: string[]) => Promise.resolve(JSON.stringify(rows)),
        addLabelFn: (
          repo: string,
          n: number,
          label: string,
        ): Promise<Result<void>> => {
          calls.push({ repo, number: n, label });
          return Promise.resolve({ ok: true, value: undefined });
        },
      },
    },
  };
}

Deno.test("bulk-triage-security - an unreadable --dry-run refuses instead of writing labels", async () => {
  for (const value of ["1", "yes", "on", "0"]) {
    const { seams, calls } = bulkSeams();
    const result = await bulkTriageSecurityCommand.execute(
      cli([
        "bulk-triage-security",
        "--monitored-repos",
        "org/alpha",
        "--findings-labels",
        "security",
        "--dry-run",
        value,
      ], seams),
      config,
    );
    assertEquals(
      result.success,
      false,
      `--dry-run ${value} must not select the live branch`,
    );
    assertStringIncludes(result.message, "--dry-run");
    assertEquals(calls.length, 0, "no label may be written");
  }
});

Deno.test("bulk-triage-security - a well-formed --dry-run still dry-runs, and its absence still writes", async () => {
  const dry = bulkSeams();
  const dryResult = await bulkTriageSecurityCommand.execute(
    cli([
      "bulk-triage-security",
      "--monitored-repos",
      "org/alpha",
      "--findings-labels",
      "security",
      "--dry-run",
    ], dry.seams),
    config,
  );
  assertEquals(dryResult.success, true, dryResult.message);
  assertEquals(dry.calls.length, 0);
  assertStringIncludes(dryResult.message, "dry-run");

  const live = bulkSeams();
  const liveResult = await bulkTriageSecurityCommand.execute(
    cli([
      "bulk-triage-security",
      "--monitored-repos",
      "org/alpha",
      "--findings-labels",
      "security",
    ], live.seams),
    config,
  );
  assertEquals(liveResult.success, true, liveResult.message);
  assertEquals(live.calls.length, 2, "the live branch is still reachable");

  // `--dry-run true` and `--dry-run false` both say what they mean.
  const explicitTrue = bulkSeams();
  await bulkTriageSecurityCommand.execute(
    cli([
      "bulk-triage-security",
      "--monitored-repos",
      "org/alpha",
      "--findings-labels",
      "security",
      "--dry-run",
      "true",
    ], explicitTrue.seams),
    config,
  );
  assertEquals(explicitTrue.calls.length, 0);

  const explicitFalse = bulkSeams();
  await bulkTriageSecurityCommand.execute(
    cli([
      "bulk-triage-security",
      "--monitored-repos",
      "org/alpha",
      "--findings-labels",
      "security",
      "--dry-run",
      "false",
    ], explicitFalse.seams),
    config,
  );
  assertEquals(explicitFalse.calls.length, 2);
});

Deno.test("bulk-triage-security - a swallowed --severities value refuses instead of widening the sweep", async () => {
  const { seams, calls } = bulkSeams();
  // What an empty shell variable produces: the next flag is taken as the value.
  const result = await bulkTriageSecurityCommand.execute(
    cli([
      "bulk-triage-security",
      "--monitored-repos",
      "org/alpha",
      "--findings-labels",
      "security",
      "--severities",
      "--max",
      "20",
      "--dry-run",
    ], seams),
    config,
  );
  assertEquals(
    result.success,
    false,
    "an unreadable --severities must not mean 'no severity filter'",
  );
  assertStringIncludes(result.message, "--severities");
  assertEquals(calls.length, 0);
});

Deno.test("bulk-triage-security - a well-formed --severities still narrows the sweep", async () => {
  const { seams, calls } = bulkSeams();
  const result = await bulkTriageSecurityCommand.execute(
    cli([
      "bulk-triage-security",
      "--monitored-repos",
      "org/alpha",
      "--findings-labels",
      "security",
      "--severities",
      "severity:high",
    ], seams),
    config,
  );
  assertEquals(result.success, true, result.message);
  assertEquals(calls.length, 1, "only the severity:high finding is labelled");
  assertEquals(calls[0]?.number, 1);
});

Deno.test("bulk-triage-security - a mistyped flag is refused, not ignored", async () => {
  const { seams, calls } = bulkSeams();
  const result = await bulkTriageSecurityCommand.execute(
    cli([
      "bulk-triage-security",
      "--monitored-repos",
      "org/alpha",
      "--findings-labels",
      "security",
      "--dryrun",
    ], seams),
    config,
  );
  assertEquals(result.success, false, "a typo must not read as 'no dry run'");
  assertStringIncludes(result.message, "--dryrun");
  assertEquals(calls.length, 0);
});

// =============================================================================
// raise-all-idle-tasks / raise-boy-scout-idle-tasks — --monitored-repos
// =============================================================================

const labelOk = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

function idleSeams() {
  const created: { repo: string; title: string }[] = [];
  const fn = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "create") {
      const repoIdx = args.indexOf("--repo");
      const titleIdx = args.indexOf("--title");
      created.push({ repo: args[repoIdx + 1]!, title: args[titleIdx + 1]! });
      return Promise.resolve("https://github.com/org/repo/issues/1\n");
    }
    return Promise.resolve("[]");
  };
  return {
    created,
    seams: {
      __testDeps: {
        ghCommandFn: fn,
        ensureLabelFn: labelOk,
        findExistingWrapperTitlesFn: () => Promise.resolve(new Set<string>()),
        nowFn: () => new Date("2026-07-03T00:00:00.000Z"),
        rootDir: REPO_ROOT,
        log: () => {},
      },
    },
  };
}

const idleCommands = [
  ["raise-all-idle-tasks", raiseAllIdleTasksCommand] as const,
  ["raise-boy-scout-idle-tasks", raiseBoyScoutIdleTasksCommand] as const,
];

for (const [name, command] of idleCommands) {
  Deno.test(
    `${name} - a swallowed --monitored-repos refuses instead of sweeping every configured repo`,
    async () => {
      const { seams, created } = idleSeams();
      const configWithRepos = {
        repos: ["org/one", "org/two", "org/three"],
      } as unknown as WorkerConfig;
      const result = await command.execute(
        cli([name, "--monitored-repos", "--rootDir", "x"], seams),
        configWithRepos,
      );
      assertEquals(
        result.success,
        false,
        "an unreadable --monitored-repos must not fall back to every repo",
      );
      assertStringIncludes(result.message, "--monitored-repos");
      assertEquals(created.length, 0, "no issue may be filed");
    },
  );

  Deno.test(
    `${name} - a well-formed --monitored-repos still targets exactly those repos`,
    async () => {
      const { seams, created } = idleSeams();
      const result = await command.execute(
        cli([name, "--monitored-repos", "org/alpha,org/beta"], seams),
        { repos: ["org/other"] } as unknown as WorkerConfig,
      );
      assertEquals(result.success, true, result.message);
      assert(created.length > 0);
      assertEquals(
        created.every((c) => c.repo === "org/alpha" || c.repo === "org/beta"),
        true,
      );
    },
  );

  Deno.test(
    `${name} - an absent --monitored-repos still falls back to config.repos`,
    async () => {
      const { seams, created } = idleSeams();
      const result = await command.execute(
        cli([name], seams),
        { repos: ["org/gamma"] } as unknown as WorkerConfig,
      );
      assertEquals(result.success, true, result.message);
      assert(created.length > 0);
      assertEquals(created.every((c) => c.repo === "org/gamma"), true);
    },
  );
}

// =============================================================================
// pr-manager — --repos
// =============================================================================

Deno.test("pr-manager - a --repos value that is not a list is refused, not walked", async () => {
  // `--repos owner/repo` used to pass the `.length === 0` guard with the
  // string's character count and then iterate it character by character;
  // `--repos 5` passed it with `undefined` and threw further in. Both are
  // now named at the boundary. The positive direction — that a single-repo
  // string becomes a one-element list rather than ten characters — is pinned
  // by the `coerceStringListFlag` test above, because the live branch of this
  // operation reaches GitHub.
  for (
    const argv of [
      [
        "pr-manager",
        "--operation",
        "close-issues-for-merged-prs",
        "--github-user",
        "nleck",
        "--repos",
        "5",
      ],
      [
        "pr-manager",
        "--operation",
        "close-issues-for-merged-prs",
        "--github-user",
        "nleck",
        "--repos",
        "--dry-run",
      ],
    ]
  ) {
    const result = await prManagerCommand.execute(cli(argv), config);
    assertEquals(result.success, false, `expected ${argv.join(" ")} refused`);
    assertStringIncludes(result.message, "--repos");
  }
});

// =============================================================================
// quality-gate-phase / quality-helpers — the baseline flag
// =============================================================================

Deno.test("quality-helpers - --baseline-passed false is honoured, and an unreadable value is refused", async () => {
  const failing = await qualityHelpersCommand.execute(
    cli([
      "quality-helpers",
      "--operation",
      "format-failure-message",
      "--quality-output",
      "boom",
      "--baseline-passed",
      "false",
      "--baseline-output",
      "baseline boom",
    ]),
    config,
  );
  assertEquals(failing.success, true, failing.message);

  const passing = await qualityHelpersCommand.execute(
    cli([
      "quality-helpers",
      "--operation",
      "format-failure-message",
      "--quality-output",
      "boom",
      "--baseline-output",
      "baseline boom",
    ]),
    config,
  );
  assertEquals(passing.success, true, passing.message);

  // A pre-existing baseline failure must not read the same as a green
  // baseline: that is what made the failure look like the change's fault.
  assert(
    failing.message !== passing.message,
    "--baseline-passed false must change the reported attribution",
  );

  const unreadable = await qualityHelpersCommand.execute(
    cli([
      "quality-helpers",
      "--operation",
      "format-failure-message",
      "--quality-output",
      "boom",
      "--baseline-passed",
      "0",
    ]),
    config,
  );
  assertEquals(unreadable.success, false);
  assertStringIncludes(unreadable.message, "--baseline-passed");
});

Deno.test("quality-gate-phase - an unreadable --baseline-quality-passed is refused before the gate runs", async () => {
  const result = await qualityGatePhaseCommand.execute(
    cli([
      "quality-gate-phase",
      "--repo",
      "org/repo",
      "--baseline-quality-passed",
      "0",
    ]),
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--baseline-quality-passed");
});

// =============================================================================
// export-branding — --check
// =============================================================================

async function makeBrandingTree(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "sec1266-branding-" });
  await Deno.writeTextFile(`${root}/README.md`, "# Vibe" + "Coding\n");
  return root;
}

Deno.test("export-branding - a dry run that cannot be read leaves the tree alone", async () => {
  for (
    const argv of [
      ["export-branding", "--tree", "TREE", "--check", "1"],
      ["export-branding", "--tree", "TREE", "--dry-run"],
    ]
  ) {
    const root = await makeBrandingTree();
    const before = await Deno.readTextFile(`${root}/README.md`);
    try {
      const result = await exportBrandingCommand.execute(
        cli(argv.map((a) => (a === "TREE" ? root : a))),
        config,
      );
      assertEquals(
        result.success,
        false,
        `expected ${argv.join(" ")} refused`,
      );
      assertEquals(
        await Deno.readTextFile(`${root}/README.md`),
        before,
        "the tree must not be rewritten when a dry run was asked for",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("export-branding - --check still reports without writing, and its absence still writes", async () => {
  const checked = await makeBrandingTree();
  try {
    const before = await Deno.readTextFile(`${checked}/README.md`);
    const result = await exportBrandingCommand.execute(
      cli(["export-branding", "--tree", checked, "--check"]),
      config,
    );
    assertEquals(result.success, true, result.message);
    assertEquals(await Deno.readTextFile(`${checked}/README.md`), before);
  } finally {
    await Deno.remove(checked, { recursive: true });
  }

  const written = await makeBrandingTree();
  try {
    const result = await exportBrandingCommand.execute(
      cli(["export-branding", "--tree", written]),
      config,
    );
    assertEquals(result.success, true, result.message);
    assertEquals(
      await Deno.readTextFile(`${written}/README.md`),
      "# VibeCoder\n",
      "the write branch is still reachable",
    );
  } finally {
    await Deno.remove(written, { recursive: true });
  }
});

// =============================================================================
// clean-deno-cache — --dry-run
// =============================================================================

Deno.test("clean-deno-cache - an unreadable --dry-run is refused rather than cleaning", async () => {
  const result = await cleanDenoCacheCommand.execute(
    cli(["clean-deno-cache", "--dry-run", "1"]),
    EMPTY_CONFIG,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--dry-run");
});
