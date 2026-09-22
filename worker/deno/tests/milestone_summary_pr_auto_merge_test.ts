/**
 * Arming auto-merge on the milestone summary PR at creation (Issue #2458).
 *
 * The summary PR was the only fleet PR kind raised with no arming attempt at
 * all — it waited for the next Auto-Merge sweep. These tests drive
 * `checkAndHandleMilestoneCompletions` with a scripted fake `gh` and assert on
 * the calls it makes: the `gh pr merge --auto` that follows a successful
 * `gh pr create`, and the number of comments each outcome leaves on the PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkAndHandleMilestoneCompletions,
  type MilestoneCompletionDeps,
} from "../lib/milestone_completion.ts";
import { _resetBaseProtectionMemo } from "../lib/pr_auto_merge.ts";

const REPO = "owner/repo";
const MILESTONE = "v1.0";
const MILESTONE_BRANCH = "milestone/v1-0";
const PR_NUMBER = 301;

/** A recorded `gh` invocation, joined for readable assertions. */
type GhCall = { args: string[]; key: string };

interface ScriptOptions {
  /**
   * Open PRs targeting the milestone branch — the children the #3909 gate
   * sees at creation time. An open *issue* on the milestone would stop the
   * completion scan before the summary PR is raised at all; an in-flight
   * child PR is exactly the case the gate exists for.
   */
  openChildPrs?: { number: number; title: string }[];
  /** Existing comments on the summary PR (the #3909 de-duplication read). */
  prComments?: { body: string; author: { login: string } }[];
  /** Error thrown by `gh pr merge --auto`, when the arming call must fail. */
  mergeError?: string;
  /** Whether the default branch enforces required checks (Issue #4375). */
  baseProtected?: boolean;
  /** Output of `gh pr create` — a URL unless the test overrides it. */
  prCreateOutput?: string;
}

/**
 * Build a fake `gh` runner for a repository with one complete milestone whose
 * summary PR does not yet exist, recording every call it is asked to make.
 */
function scriptGh(
  options: ScriptOptions = {},
): { gh: (args: string[]) => Promise<string>; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const openChildPrs = options.openChildPrs ?? [];
  const baseProtected = options.baseProtected ?? true;

  const gh = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    calls.push({ args, key });

    // --- milestone completion scan -----------------------------------
    if (key.includes("api repos/") && key.includes(".default_branch")) {
      return Promise.resolve("main");
    }
    // The open-children gate's authoritative reads (Issue #3908/#3909).
    if (key.includes("/issues?milestone=")) return Promise.resolve("[]");
    if (/api repos\/[^ ]+\/milestones\/\d+$/.test(key)) {
      return Promise.resolve(JSON.stringify({ open_issues: 0 }));
    }
    if (key.includes("api") && key.includes("/milestones")) {
      return Promise.resolve(
        JSON.stringify([{ title: MILESTONE, number: 1 }]),
      );
    }
    if (key.includes("issue list") && key.includes("--state closed")) {
      return Promise.resolve(
        JSON.stringify([
          { number: 10, title: "Add login", milestone: { title: MILESTONE } },
        ]),
      );
    }
    if (key.includes("issue list")) return Promise.resolve("[]");
    if (key.includes("api") && key.includes("/branches/milestone")) {
      return Promise.resolve(JSON.stringify({ name: MILESTONE_BRANCH }));
    }
    if (key.includes("issue create")) {
      return Promise.resolve(`https://github.com/${REPO}/issues/300`);
    }
    if (key.includes("issue close")) return Promise.resolve("");

    // --- arming path ---------------------------------------------------
    if (key.includes("/rules/branches/")) {
      return Promise.resolve(baseProtected ? "required_status_checks" : "");
    }
    if (key.includes("pr create")) {
      return Promise.resolve(
        options.prCreateOutput ??
          `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      );
    }
    if (key.includes("pr merge")) {
      if (options.mergeError) {
        return Promise.reject(new Error(options.mergeError));
      }
      return Promise.resolve("");
    }
    if (key.includes("pr comment")) return Promise.resolve("");
    // The #3909 de-duplication read of existing PR comments.
    if (key.includes("/comments")) {
      return Promise.resolve(JSON.stringify(options.prComments ?? []));
    }
    // The gated direct merge asks what the summary PR targets (Issue #2416).
    if (key.includes("pr view") && key.includes("baseRefName")) {
      return Promise.resolve("main");
    }
    // Open PRs targeting the milestone branch (the gate's second read).
    if (key.includes("pr list") && key.includes("--base")) {
      return Promise.resolve(JSON.stringify(openChildPrs));
    }
    return Promise.resolve("[]");
  };

  return { gh, calls };
}

function deps(
  gh: (args: string[]) => Promise<string>,
  logs: string[],
  overrides: Partial<MilestoneCompletionDeps> = {},
): MilestoneCompletionDeps {
  return {
    repos: [REPO],
    ghCommandFn: gh,
    log: (msg: string) => logs.push(msg),
    authorOptions: { fleetAuthors: ["bot"] },
    ...overrides,
  };
}

/** Calls that armed GitHub auto-merge. */
function armingCalls(calls: GhCall[]): GhCall[] {
  return calls.filter((c) =>
    c.args[0] === "pr" && c.args[1] === "merge" && c.args.includes("--auto")
  );
}

/** Comments posted on a PR. */
function commentCalls(calls: GhCall[]): GhCall[] {
  return calls.filter((c) => c.args[0] === "pr" && c.args[1] === "comment");
}

Deno.test("summary PR arming - a created summary PR is armed before the function returns", async () => {
  _resetBaseProtectionMemo();
  const { gh, calls } = scriptGh();
  const logs: string[] = [];

  const result = await checkAndHandleMilestoneCompletions(deps(gh, logs));
  assertEquals(result.ok, true);

  const createIndex = calls.findIndex((c) => c.key.includes("pr create"));
  const armed = armingCalls(calls);
  assertEquals(armed.length, 1);
  assertEquals(armed[0]!.args.includes(String(PR_NUMBER)), true);
  assertEquals(armed[0]!.args.includes("--repo"), true);
  // Arming follows creation — it is not a separate sweep's business.
  assertEquals(calls.indexOf(armed[0]!) > createIndex, true);
  // A successful arming leaves no comment behind.
  assertEquals(commentCalls(calls).length, 0);
});

Deno.test("summary PR arming - open children withhold arming with no second comment", async () => {
  _resetBaseProtectionMemo();
  const { gh, calls } = scriptGh({
    openChildPrs: [{ number: 42, title: "Still open" }],
  });
  const logs: string[] = [];

  const result = await checkAndHandleMilestoneCompletions(deps(gh, logs));
  assertEquals(result.ok, true);

  // The #3909 gate refuses, so `--auto` is never issued …
  assertEquals(armingCalls(calls).length, 0);
  // … and the gate's own reason comment is the only one posted.
  const comments = commentCalls(calls);
  assertEquals(comments.length, 1);
  const body = comments[0]!.args[comments[0]!.args.indexOf("--body") + 1]!;
  assertStringIncludes(body, "#42");
});

Deno.test("summary PR arming - a refused --auto call yields exactly one reason comment", async () => {
  _resetBaseProtectionMemo();
  const { gh, calls } = scriptGh({
    mergeError: "GraphQL: Base branch was modified (mergePullRequest)",
  });
  const logs: string[] = [];

  const result = await checkAndHandleMilestoneCompletions(deps(gh, logs));
  assertEquals(result.ok, true);

  assertEquals(armingCalls(calls).length, 1);
  const comments = commentCalls(calls);
  assertEquals(comments.length, 1);
  const body = comments[0]!.args[comments[0]!.args.indexOf("--body") + 1]!;
  assertStringIncludes(body, "Base branch was modified");
  assertStringIncludes(body, "Auto-Merge sweep retries");
  assertEquals(
    logs.some((l) =>
      l.includes("WARNING") && l.includes("was not armed") &&
      l.includes(`${REPO}#${PR_NUMBER}`)
    ),
    true,
  );
});

Deno.test("summary PR arming - skip_auto_merge repositories are never armed", async () => {
  _resetBaseProtectionMemo();
  const { gh, calls } = scriptGh();
  const logs: string[] = [];

  const result = await checkAndHandleMilestoneCompletions(
    deps(gh, logs, { skipAutoMerge: () => true }),
  );
  assertEquals(result.ok, true);

  assertEquals(calls.some((c) => c.key.includes("pr create")), true);
  assertEquals(armingCalls(calls).length, 0);
  assertEquals(commentCalls(calls).length, 0);
});

Deno.test("summary PR arming - an unreadable PR URL fails loud and arms nothing", async () => {
  _resetBaseProtectionMemo();
  const { gh, calls } = scriptGh({ prCreateOutput: "created, no URL here" });
  const logs: string[] = [];

  const result = await checkAndHandleMilestoneCompletions(deps(gh, logs));
  assertEquals(result.ok, true);

  assertEquals(armingCalls(calls).length, 0);
  assertEquals(commentCalls(calls).length, 0);
  assertEquals(
    logs.some((l) =>
      l.includes("WARNING") && l.includes("could not read a PR number")
    ),
    true,
  );
});

Deno.test("summary PR arming - an unprotected default branch takes the gated merge with the fleet logins", async () => {
  _resetBaseProtectionMemo();
  const { gh, calls } = scriptGh({ baseProtected: false });
  const logs: string[] = [];

  const result = await checkAndHandleMilestoneCompletions(
    deps(gh, logs, { fleetAuthors: ["bot"] }),
  );
  assertEquals(result.ok, true);

  // A base with no required checks never gets a bare `--auto` (Issue #4375).
  assertEquals(armingCalls(calls).length, 0);
  // With the fleet logins in hand the gated merge runs its own gate rather
  // than refusing the default-branch PR outright (Issue #2416/#1082), so the
  // PR carries no "auto-merge was not armed" comment naming that refusal.
  const refusals = commentCalls(calls).filter((c) =>
    c.args[c.args.indexOf("--body") + 1]!.includes("2416")
  );
  assertEquals(refusals.length, 0);
});

Deno.test("summary PR arming - an existing summary PR is left untouched", async () => {
  _resetBaseProtectionMemo();
  const { gh: base, calls } = scriptGh();
  const gh = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    // An open summary PR already exists on the milestone branch.
    if (key.includes("pr list") && key.includes("--state all")) {
      return Promise.resolve(
        JSON.stringify([
          {
            number: PR_NUMBER,
            title: `Milestone: ${MILESTONE}`,
            headRefName: MILESTONE_BRANCH,
            state: "OPEN",
          },
        ]),
      );
    }
    return base(args);
  };
  const logs: string[] = [];

  const result = await checkAndHandleMilestoneCompletions(deps(gh, logs));
  assertEquals(result.ok, true);

  assertEquals(calls.some((c) => c.key.includes("pr create")), false);
  assertEquals(armingCalls(calls).length, 0);
  assertEquals(commentCalls(calls).length, 0);
});
