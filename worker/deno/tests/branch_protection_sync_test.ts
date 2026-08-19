/**
 * Tests for setup/branch_protection_sync.ts — setup-time default-branch
 * enforcement sync across all monitored repos (Issue #2588; converted from
 * classic protection to rulesets by Issue #4163).
 *
 * The sync resolves visibility + default branch per repo, then calls the
 * idempotent ruleset configurator. Per-repo failures are non-fatal: the
 * summary records them and the walk continues.
 */

import { assertEquals } from "@std/assert";
import {
  type CommandOutput,
  planBranchProtectionForRepo,
  syncBranchProtectionForAllRepos,
  syncBranchProtectionForRepo,
} from "../setup/branch_protection_sync.ts";
import type { GhExec } from "../lib/repo_rulesets.ts";
import { VIBE_RULESET_NAME } from "../lib/default_branch_ruleset.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Per-repo scripted metadata: visibility + default branch. */
interface RepoMeta {
  visibility?: string; // omit to simulate a failed visibility read
  defaultBranch?: string; // omit to simulate a failed default-branch read
}

/**
 * Build a `runCommand` mock that replays per-repo `gh api repos/<repo>`
 * metadata reads. Records every call for assertions.
 */
function makeRunCommand(
  metas: Record<string, RepoMeta>,
): {
  runCommand: (cmd: string[]) => Promise<CommandOutput>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runCommand = (cmd: string[]): Promise<CommandOutput> => {
    calls.push(cmd);
    // cmd: ["gh", "api", "repos/<repo>", "--jq", "<field>"]
    const repo = (cmd[2] ?? "").replace(/^repos\//, "");
    const jq = cmd[cmd.length - 1] ?? "";
    const meta = metas[repo];
    if (!meta) {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "Not Found (HTTP 404)",
      });
    }
    if (jq === ".visibility") {
      if (meta.visibility === undefined) {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "boom",
        });
      }
      return Promise.resolve({
        success: true,
        stdout: meta.visibility,
        stderr: "",
      });
    }
    if (jq === ".default_branch") {
      if (meta.defaultBranch === undefined) {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "boom",
        });
      }
      return Promise.resolve({
        success: true,
        stdout: meta.defaultBranch,
        stderr: "",
      });
    }
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: "unexpected",
    });
  };
  return { runCommand, calls };
}

interface GhCall {
  args: string[];
  stdin?: string;
}

/** Names every mocked repo reports, so a satisfiable context set exists. */
const REPORTED_CHECKS = [
  "gitleaks",
  "semgrep",
  "markdownlint",
  "dependency-review",
];

/**
 * Build a ruleset `GhExec` mock.
 *
 * The repo starts with no rulesets and no classic protection. A `POST` to the
 * rulesets endpoint stores the body, and subsequent reads replay it through
 * both `/rulesets` and `/rules/branches/<branch>`, so a second sync run is a
 * genuine no-op. A `DELETE` removes it again. Classic protection always reads
 * as a 404 — and the mock never accepts a classic write, so any attempt shows
 * up in `calls` for assertion. Every repo's default branch reads as PR-only
 * unless listed in `directPushRepos` (Issue #4356).
 */
function makeGhExec(
  options: { directPushRepos?: string[]; seeded?: string[] } = {},
): { gh: GhExec; calls: GhCall[] } {
  const calls: GhCall[] = [];
  // repo -> stored ruleset body
  const rulesets = new Map<string, Record<string, never> | unknown>();
  for (const repo of options.seeded ?? []) {
    rulesets.set(repo, {
      name: VIBE_RULESET_NAME,
      rules: [{
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "gitleaks" }] },
      }],
    });
  }
  const gh: GhExec = (args, stdin) => {
    calls.push({ args, stdin });
    const isVerb = args[1] === "-X";
    const method = isVerb ? String(args[2]) : "GET";
    const endpoint = String(isVerb ? args[3] : args[1]);
    const repo = endpoint.replace(/^repos\//, "").split("/").slice(0, 2)
      .join("/");

    if (method === "POST" && /\/rulesets$/.test(endpoint)) {
      rulesets.set(repo, JSON.parse(stdin ?? "{}"));
      return Promise.resolve("");
    }
    if (method === "PUT" && /\/rulesets\//.test(endpoint)) {
      rulesets.set(repo, JSON.parse(stdin ?? "{}"));
      return Promise.resolve("");
    }
    if (method === "DELETE" && /\/rulesets\/\d+$/.test(endpoint)) {
      rulesets.delete(repo);
      return Promise.resolve("");
    }
    if (method !== "GET") {
      return Promise.reject(new Error(`unexpected write: ${endpoint}`));
    }

    // Direct-push guard reads (Issue #4356).
    if (/\/topics$/.test(endpoint)) return Promise.resolve('{"names":[]}');
    if (endpoint.includes("/contents/")) {
      return Promise.reject(new Error("gh failed: Not Found (HTTP 404)"));
    }
    if (/\/commits\?sha=/.test(endpoint)) {
      const direct = (options.directPushRepos ?? []).includes(repo);
      return Promise.resolve(
        JSON.stringify([{
          sha: "abc1234",
          commit: {
            message: direct ? "Refresh of history" : "feat: change (#1)",
          },
        }]),
      );
    }
    if (/\/commits\/[^/]+\/pulls$/.test(endpoint)) {
      return Promise.resolve("[]");
    }

    if (/\/rulesets$/.test(endpoint)) {
      const stored = rulesets.get(repo);
      return Promise.resolve(
        JSON.stringify(stored ? [{ id: 1, name: VIBE_RULESET_NAME }] : []),
      );
    }
    if (/\/rules\/branches\//.test(endpoint)) {
      const stored = rulesets.get(repo) as
        | { rules?: Array<Record<string, unknown>> }
        | undefined;
      if (!stored) return Promise.resolve("[]");
      return Promise.resolve(
        JSON.stringify(
          (stored.rules ?? []).map((r) => ({ ...r, ruleset_id: 1 })),
        ),
      );
    }
    if (/\/protection$/.test(endpoint)) {
      return Promise.reject(
        new Error("gh command failed: Branch not protected (HTTP 404)"),
      );
    }
    if (/\/pulls\?/.test(endpoint)) return Promise.resolve("[]");
    if (/check-runs/.test(endpoint)) {
      return Promise.resolve(
        JSON.stringify({
          check_runs: REPORTED_CHECKS.map((name) => ({ name })),
        }),
      );
    }
    if (/\/status$/.test(endpoint)) {
      return Promise.resolve(JSON.stringify({ statuses: [] }));
    }
    return Promise.reject(new Error(`unexpected endpoint: ${endpoint}`));
  };
  return { gh, calls };
}

/** Required contexts from a recorded ruleset write body. */
function writtenContexts(call: GhCall): string[] {
  const body = JSON.parse(call.stdin!);
  return body.rules[0].parameters.required_status_checks.map(
    (c: { context: string }) => c.context,
  );
}

/** Ruleset creates/updates recorded this run. */
function rulesetWrites(calls: GhCall[]): GhCall[] {
  return calls.filter((c) =>
    c.args[1] === "-X" && String(c.args[3]).includes("/rulesets")
  );
}

// ---------------------------------------------------------------------------
// Acceptance: visibility-aware contexts (public vs private)
// ---------------------------------------------------------------------------

Deno.test("sync - public repo requires the public-only context, private does not", async () => {
  const { runCommand } = makeRunCommand({
    "org/pub": { visibility: "public", defaultBranch: "main" },
    "org/priv": { visibility: "private", defaultBranch: "trunk" },
  });
  const { gh, calls } = makeGhExec();

  const summary = await syncBranchProtectionForAllRepos({
    repos: ["org/pub", "org/priv"],
    runCommand,
    ghFn: gh,
  });

  assertEquals(summary.total, 2);
  assertEquals(summary.configured, 2);
  assertEquals(summary.changed, 2);
  assertEquals(summary.failed, 0);

  // The public repo's ruleset must include the public-only
  // "dependency-review" context; the private one must not.
  const writes = rulesetWrites(calls);
  const pubWrite = writes.find((c) =>
    c.args.some((a) => a.includes("org/pub"))
  );
  const privWrite = writes.find((c) =>
    c.args.some((a) => a.includes("org/priv"))
  );
  const pubContexts = writtenContexts(pubWrite!);
  const privContexts = writtenContexts(privWrite!);

  assertEquals(pubContexts.includes("dependency-review"), true);
  assertEquals(privContexts.includes("dependency-review"), false);
  // Universal checks always present.
  assertEquals(pubContexts.includes("gitleaks"), true);
  assertEquals(privContexts.includes("gitleaks"), true);
  // strict / up-to-date always required.
  assertEquals(
    JSON.parse(pubWrite!.stdin!).rules[0].parameters
      .strict_required_status_checks_policy,
    true,
  );
});

Deno.test("sync - classic branch protection is never written (Issue #4163)", async () => {
  const { runCommand } = makeRunCommand({
    "org/repo": { visibility: "public", defaultBranch: "main" },
  });
  const { gh, calls } = makeGhExec();

  await syncBranchProtectionForAllRepos({
    repos: ["org/repo"],
    runCommand,
    ghFn: gh,
  });

  const classicWrites = calls.filter((c) =>
    c.args[1] === "-X" &&
    /\/branches\/[^/]+\/protection$/.test(String(c.args[3]))
  );
  assertEquals(classicWrites.length, 0);
});

// ---------------------------------------------------------------------------
// Acceptance: the default branch from metadata is the one configured
// ---------------------------------------------------------------------------

Deno.test("sync - configures the repo's actual default branch", async () => {
  const { runCommand } = makeRunCommand({
    "org/repo": { visibility: "private", defaultBranch: "trunk" },
  });
  const { gh, calls } = makeGhExec();

  const summary = await syncBranchProtectionForAllRepos({
    repos: ["org/repo"],
    runCommand,
    ghFn: gh,
  });

  assertEquals(summary.results[0]!.branch, "trunk");
  // Coverage is evaluated against the real default branch...
  assertEquals(
    calls.some((c) => c.args[1] === "repos/org/repo/rules/branches/trunk"),
    true,
  );
  // ...and the ruleset tracks it via GitHub's built-in default-branch alias.
  const write = rulesetWrites(calls)[0]!;
  assertEquals(
    JSON.parse(write.stdin!).conditions.ref_name.include,
    ["~DEFAULT_BRANCH"],
  );
});

// ---------------------------------------------------------------------------
// Acceptance: idempotent second run is a no-op
// ---------------------------------------------------------------------------

Deno.test("sync - second run with no drift makes no ruleset write", async () => {
  const metas = {
    "org/repo": { visibility: "public", defaultBranch: "main" },
  };
  const { gh, calls } = makeGhExec();

  const first = await syncBranchProtectionForAllRepos({
    repos: ["org/repo"],
    runCommand: makeRunCommand(metas).runCommand,
    ghFn: gh,
  });
  assertEquals(first.changed, 1);

  const writesAfterFirst = rulesetWrites(calls).length;

  const second = await syncBranchProtectionForAllRepos({
    repos: ["org/repo"],
    runCommand: makeRunCommand(metas).runCommand,
    ghFn: gh,
  });
  assertEquals(second.configured, 1);
  assertEquals(second.changed, 0);
  assertEquals(second.results[0]!.changed, false);

  const writesAfterSecond = rulesetWrites(calls).length;
  // No new ruleset write was issued on the second run.
  assertEquals(writesAfterSecond, writesAfterFirst);
});

// ---------------------------------------------------------------------------
// Non-fatal: a single-repo failure does not abort the walk
// ---------------------------------------------------------------------------

Deno.test("sync - a failed visibility read is recorded but does not abort", async () => {
  const { runCommand } = makeRunCommand({
    "org/bad": {}, // visibility read fails
    "org/good": { visibility: "private", defaultBranch: "main" },
  });
  const { gh } = makeGhExec();

  const summary = await syncBranchProtectionForAllRepos({
    repos: ["org/bad", "org/good"],
    runCommand,
    ghFn: gh,
  });

  assertEquals(summary.total, 2);
  assertEquals(summary.failed, 1);
  assertEquals(summary.configured, 1);
  const bad = summary.results.find((r) => r.repo === "org/bad")!;
  assertEquals(bad.ok, false);
  assertEquals(typeof bad.error, "string");
  const good = summary.results.find((r) => r.repo === "org/good")!;
  assertEquals(good.ok, true);
});

Deno.test("sync - a missing default branch is recorded but does not abort", async () => {
  const { runCommand } = makeRunCommand({
    "org/nobranch": { visibility: "private" }, // default branch read fails
    "org/good": { visibility: "private", defaultBranch: "main" },
  });
  const { gh } = makeGhExec();

  const summary = await syncBranchProtectionForAllRepos({
    repos: ["org/nobranch", "org/good"],
    runCommand,
    ghFn: gh,
  });

  assertEquals(summary.failed, 1);
  assertEquals(summary.configured, 1);
  const bad = summary.results.find((r) => r.repo === "org/nobranch")!;
  assertEquals(bad.ok, false);
});

// ---------------------------------------------------------------------------
// Input validation: an invalid slug is skipped (no gh calls)
// ---------------------------------------------------------------------------

Deno.test("sync - invalid repo slug is rejected without any gh call", async () => {
  const { runCommand, calls } = makeRunCommand({});
  const { gh } = makeGhExec();

  const summary = await syncBranchProtectionForAllRepos({
    repos: ["not-a-valid-slug ; rm -rf /"],
    runCommand,
    ghFn: gh,
  });

  assertEquals(summary.total, 1);
  assertEquals(summary.failed, 1);
  assertEquals(calls.length, 0); // never reached gh
  assertEquals(summary.results[0]!.ok, false);
});

// ---------------------------------------------------------------------------
// Empty repo list
// ---------------------------------------------------------------------------

Deno.test("sync - empty repo list yields an empty summary", async () => {
  const { runCommand } = makeRunCommand({});
  const { gh } = makeGhExec();
  const summary = await syncBranchProtectionForAllRepos({
    repos: [],
    runCommand,
    ghFn: gh,
  });
  assertEquals(summary.total, 0);
  assertEquals(summary.configured, 0);
  assertEquals(summary.failed, 0);
  assertEquals(summary.results.length, 0);
});

// ---------------------------------------------------------------------------
// Single-repo entry point (Issue #2589 — add-repo onboarding path)
// ---------------------------------------------------------------------------

Deno.test("syncBranchProtectionForRepo - pre-resolved visibility skips the visibility read", async () => {
  const { runCommand, calls } = makeRunCommand({
    "org/onboard": { visibility: "public", defaultBranch: "main" },
  });
  const { gh } = makeGhExec();

  // Pass visibility "private" explicitly: it must be honoured even though the
  // metadata would report "public". This proves the read is skipped.
  const result = await syncBranchProtectionForRepo("org/onboard", {
    visibility: "private",
    runCommand,
    ghFn: gh,
  });

  assertEquals(result.ok, true);
  assertEquals(result.changed, true);
  assertEquals(result.visibility, "private");
  assertEquals(result.branch, "main");
  // No `.visibility` metadata read was performed — only the default-branch read.
  const visibilityReads = calls.filter(
    (c) => c[c.length - 1] === ".visibility",
  );
  assertEquals(visibilityReads.length, 0);
});

Deno.test("syncBranchProtectionForRepo - resolves visibility when not supplied", async () => {
  const { runCommand, calls } = makeRunCommand({
    "org/onboard": { visibility: "public", defaultBranch: "main" },
  });
  const { gh } = makeGhExec();

  const result = await syncBranchProtectionForRepo("org/onboard", {
    runCommand,
    ghFn: gh,
  });

  assertEquals(result.ok, true);
  assertEquals(result.visibility, "public");
  const visibilityReads = calls.filter(
    (c) => c[c.length - 1] === ".visibility",
  );
  assertEquals(visibilityReads.length, 1);
});

Deno.test("syncBranchProtectionForRepo - invalid slug is rejected without any gh call", async () => {
  const { runCommand, calls } = makeRunCommand({});
  const { gh } = makeGhExec();

  const result = await syncBranchProtectionForRepo("bad ; rm -rf /", {
    visibility: "public",
    runCommand,
    ghFn: gh,
  });

  assertEquals(result.ok, false);
  assertEquals(calls.length, 0);
});

Deno.test("syncBranchProtectionForRepo - a missing default branch is recorded as a failure", async () => {
  const { runCommand } = makeRunCommand({
    "org/nobranch": { visibility: "private" }, // default-branch read fails
  });
  const { gh } = makeGhExec();

  const result = await syncBranchProtectionForRepo("org/nobranch", {
    visibility: "private",
    runCommand,
    ghFn: gh,
  });

  assertEquals(result.ok, false);
  assertEquals(result.visibility, "private");
  assertEquals(typeof result.error, "string");
});

// ---------------------------------------------------------------------------
// Direct-push branches (Issue #4356)
// ---------------------------------------------------------------------------

Deno.test("sync - a direct-push data repo gets no ruleset and its stale one is deleted", async () => {
  const { runCommand } = makeRunCommand({
    "example-org/private-repo-16": {
      visibility: "private",
      defaultBranch: "Develop",
    },
    "example-org/private-repo-14": {
      visibility: "private",
      defaultBranch: "Develop",
    },
    "stSoftwareAU/VibeCoder": {
      visibility: "public",
      defaultBranch: "Develop",
    },
  });
  const { gh, calls } = makeGhExec({
    directPushRepos: [
      "example-org/private-repo-16",
      "example-org/private-repo-14",
    ],
    // FLEET-actual still carries the ruleset created on 2026-08-16.
    seeded: ["example-org/private-repo-14"],
  });

  const summary = await syncBranchProtectionForAllRepos({
    repos: [
      "example-org/private-repo-16",
      "example-org/private-repo-14",
      "stSoftwareAU/VibeCoder",
    ],
    runCommand,
    ghFn: gh,
  });

  assertEquals(summary.failed, 0);
  assertEquals(summary.changed, 1, "only the code repo is written");
  const byRepo = Object.fromEntries(summary.results.map((r) => [r.repo, r]));
  assertEquals(
    byRepo["example-org/private-repo-16"]?.skipped,
    "direct-push-branch",
  );
  assertEquals(byRepo["example-org/private-repo-16"]?.deleted, false);
  assertEquals(
    byRepo["example-org/private-repo-14"]?.skipped,
    "direct-push-branch",
  );
  assertEquals(byRepo["example-org/private-repo-14"]?.deleted, true);
  assertEquals(
    typeof byRepo["example-org/private-repo-14"]?.detail,
    "string",
    "the offending commit is reported",
  );
  assertEquals(byRepo["stSoftwareAU/VibeCoder"]?.changed, true);

  const deletes = calls.filter((c) =>
    c.args[1] === "-X" && c.args[2] === "DELETE"
  );
  assertEquals(deletes.length, 1);
  assertEquals(
    deletes[0]?.args[3],
    "repos/example-org/private-repo-14/rulesets/1",
  );
  // No create/update ever targeted a direct-push repo.
  const dataWrites = rulesetWrites(calls).filter((c) =>
    String(c.args[3]).includes("FLEET-") && c.args[2] !== "DELETE"
  );
  assertEquals(dataWrites.length, 0);
});

Deno.test("planBranchProtectionForRepo - reports the decision without writing", async () => {
  const { runCommand } = makeRunCommand({
    "org/data": { visibility: "private", defaultBranch: "main" },
    "org/code": { visibility: "public", defaultBranch: "main" },
  });
  const { gh, calls } = makeGhExec({ directPushRepos: ["org/data"] });

  const data = await planBranchProtectionForRepo("org/data", {
    runCommand,
    ghFn: gh,
  });
  assertEquals(data.ok, true);
  assertEquals(data.branch, "main");
  assertEquals(data.plan?.action, "none");
  assertEquals(data.plan?.skipped, "direct-push-branch");

  const code = await planBranchProtectionForRepo("org/code", {
    runCommand,
    ghFn: gh,
  });
  assertEquals(code.ok, true);
  assertEquals(code.plan?.action, "create");
  assertEquals(code.plan?.added.includes("gitleaks"), true);

  assertEquals(rulesetWrites(calls).length, 0, "planning never writes");
});

Deno.test("planBranchProtectionForRepo - resolution failures are recorded, not thrown", async () => {
  const { runCommand } = makeRunCommand({
    "org/no-branch": { visibility: "private" },
  });
  const { gh } = makeGhExec();

  const missing = await planBranchProtectionForRepo("org/no-branch", {
    runCommand,
    ghFn: gh,
  });
  assertEquals(missing.ok, false);
  assertEquals(missing.visibility, "private");
  assertEquals(
    missing.error,
    "Could not resolve default branch for org/no-branch",
  );

  const invalid = await planBranchProtectionForRepo("bad slug", {
    runCommand,
    ghFn: gh,
  });
  assertEquals(invalid.ok, false);
  assertEquals(invalid.error, "Invalid repo slug: bad slug");
});
