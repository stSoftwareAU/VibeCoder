/**
 * A planted wrapper title must not silence the fleet's idle-task supply.
 *
 * Every idle-task template decides whether to file this run's wrapper by
 * asking GitHub whether one is already open, matching a **constant** title
 * with `in:title`. The constants are in a public repository, so anybody who
 * can open an issue can reproduce one exactly — and the search proved nothing
 * about who wrote the match. Eighteen such issues would have convinced every
 * host that every idle task was already filed, which stops the repository's
 * whole idle-task supply. Only the author is authenticated, so the author is
 * what the decision now rests on.
 *
 * Driven from the LIVE registry (`listTemplates()` after the side-effect
 * imports the production claim handler performs), not a hand-written list:
 * a nineteenth template that copy-pastes the old shape fails
 * `every registered template is covered`, which is the point — copy-paste is
 * how the defect reached eighteen files in the first place.
 *
 * The two trackers that share the shape — `baseline_carryover_tracker.ts` and
 * `audit_failure_notifier.ts` — are covered at the end of the file.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import "../lib/idle_task_claim_handler.ts";
import {
  type IdleTaskTemplate,
  listTemplates,
} from "../lib/idle_task_template.ts";
import type { AlertDedupAuthorOptions } from "../lib/alert_dedup_authors.ts";
import { MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES } from "../lib/marker_dedup_author_manifest.ts";
import { fileBaselineCarryoverTracker } from "../lib/baseline_carryover_tracker.ts";
import { notifyAuditFailure } from "../lib/audit_failure_notifier.ts";

import { createAlertFeedTemplate } from "../lib/idle_task_templates/alert_feed_template.ts";
import { createBashScriptRefsTemplate } from "../lib/idle_task_templates/bash_script_refs_template.ts";
import { createBashSyntaxAuditTemplate } from "../lib/idle_task_templates/bash_syntax_audit_template.ts";
import { createBestPracticesTemplate } from "../lib/idle_task_templates/best_practices_template.ts";
import { createDeadCodeTemplate } from "../lib/idle_task_templates/dead_code_template.ts";
import { createDeprecatedApiTemplate } from "../lib/idle_task_templates/deprecated_api_template.ts";
import { createDocCoverageTemplate } from "../lib/idle_task_templates/doc_coverage_template.ts";
import { createDocumentationAuditTemplate } from "../lib/idle_task_templates/documentation_audit_template.ts";
import { createDuplicatedKnowledgeTemplate } from "../lib/idle_task_templates/duplicated_knowledge_template.ts";
import { createFormatDriftTemplate } from "../lib/idle_task_templates/format_drift_template.ts";
import { createGitHubActionsAuditTemplate } from "../lib/idle_task_templates/github_actions_audit_template.ts";
import { createOrphanDepsTemplate } from "../lib/idle_task_templates/orphan_deps_template.ts";
import { createPrivateRepoReferenceTemplate } from "../lib/idle_task_templates/private_repo_reference_template.ts";
import { createRetroTemplate } from "../lib/idle_task_templates/retro_template.ts";
import { createSupplyChainReadinessTemplate } from "../lib/idle_task_templates/supply_chain_readiness_template.ts";
import { createSecurityScanTemplate } from "../lib/idle_task_templates/security_scan_template.ts";
import { createTestAuditTemplate } from "../lib/idle_task_templates/test_audit_template.ts";
import { createWorkflowAnnotationScanTemplate } from "../lib/idle_task_templates/workflow_annotation_scan_template.ts";

const REPO = "acme/widgets";

/** This host's fleet, as a test states it rather than writing a config. */
const FLEET = ["vibe-bot", "vibe-bot-syd"];

/** Neither a service account nor a fleet PR author — a drive-by contributor. */
const OUTSIDER = "helpful-stranger";

type Factory = (
  gh: (args: string[]) => Promise<string>,
  dedupAuthors: AlertDedupAuthorOptions,
) => IdleTaskTemplate;

/**
 * One factory per registered template, wired with only the two deps
 * `shouldFile` uses. `runTask` is not driven here — the other template suites
 * own that — so the remaining deps stay at their production defaults.
 */
const FACTORIES = new Map<string, Factory>([
  [
    "alert-feed",
    (gh, d) => createAlertFeedTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "bash-script-refs",
    (gh, d) =>
      createBashScriptRefsTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "bash-syntax-audit",
    (gh, d) =>
      createBashSyntaxAuditTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "best-practices",
    (gh, d) =>
      createBestPracticesTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "dead-code",
    (gh, d) => createDeadCodeTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "deprecated-api",
    (gh, d) =>
      createDeprecatedApiTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "doc-coverage",
    (gh, d) => createDocCoverageTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "documentation-audit",
    (gh, d) =>
      createDocumentationAuditTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "duplicated-knowledge",
    (gh, d) =>
      createDuplicatedKnowledgeTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "format-drift",
    (gh, d) => createFormatDriftTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "github-actions-audit",
    (gh, d) =>
      createGitHubActionsAuditTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "orphan-deps",
    (gh, d) => createOrphanDepsTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "private-repo-reference-audit",
    (gh, d) =>
      createPrivateRepoReferenceTemplate({
        ghCommandFn: gh,
        dedupAuthors: d,
        // The template's defining gate: it only files on a public repo, and
        // the production resolver fail-safes to "private" without a network.
        getVisibilityFn: () => Promise.resolve({ ok: true, value: "public" }),
      }),
  ],
  [
    "retro",
    (gh, d) => createRetroTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    // Fixed by #1100 rather than by the shared helper, so its deps spread
    // `AlertDedupAuthorOptions` directly instead of nesting them under
    // `dedupAuthors`. Covered here all the same — the suite asks what the
    // template does, not which change fixed it.
    "security-scan",
    (gh, d) =>
      createSecurityScanTemplate({
        ghCommandFn: gh,
        // This suite exercises `shouldFile` only, which never reaches the
        // scanner. Throwing rather than stubbing a result means a future
        // change that does reach it fails loudly instead of passing on a
        // fabricated scan.
        runSecurityScanFn: () => {
          throw new Error("the wrapper dedup must not run the scanner");
        },
        ...d,
      }),
  ],
  [
    "supply-chain-readiness",
    (gh, d) =>
      createSupplyChainReadinessTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "test-audit",
    (gh, d) => createTestAuditTemplate({ ghCommandFn: gh, dedupAuthors: d }),
  ],
  [
    "workflow-annotation-scan",
    (gh, d) =>
      createWorkflowAnnotationScanTemplate({
        ghCommandFn: gh,
        dedupAuthors: d,
      }),
  ],
]);

/**
 * Templates whose wrapper dedup is still unverified, so they cannot yet be
 * held to this contract.
 *
 * Read off the shrink-only manifest rather than restated: when the remaining
 * template is fixed and leaves the manifest, it joins this suite
 * automatically and `every registered template is covered` demands a factory
 * for it.
 */
const OUTSTANDING = new Set(
  MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES
    .filter((f) => f.startsWith("lib/idle_task_templates/")),
);

/** True when this gh invocation is the wrapper-title dedup search. */
function isTitleDedupSearch(call: string[]): boolean {
  if (call[0] !== "issue" || call[1] !== "list") return false;
  const index = call.indexOf("--search");
  return index >= 0 && (call[index + 1] ?? "").includes("in:title");
}

/**
 * A gh stub serving one planted open wrapper with the given author.
 *
 * Only the title dedup search sees it. Some templates run a second, unrelated
 * `gh issue list` first (a known-findings sweep, a visibility probe), and
 * serving the planted row to that one would gate the template out before the
 * dedup search ever ran — the test would then pass for the wrong reason.
 */
function ghServing(title: string, author: string | null) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (!isTitleDedupSearch(args)) return Promise.resolve("[]");
    return Promise.resolve(JSON.stringify([{
      number: 4242,
      title,
      body: "",
      url: `https://github.com/${REPO}/issues/4242`,
      author: author === null ? null : { login: author },
    }]));
  };
  return { gh, calls };
}

/** The `--json` field list a dedup search asked gh for. */
function jsonFields(call: string[]): string {
  const index = call.indexOf("--json");
  return index < 0 ? "" : call[index + 1] ?? "";
}

// ---------------------------------------------------------------------------
// Registry totality
// ---------------------------------------------------------------------------

Deno.test("wrapper dedup - every registered template is covered", () => {
  const uncovered = listTemplates()
    .filter((t) => t.shouldFile !== undefined)
    .map((t) => t.name)
    .filter((name) => !FACTORIES.has(name))
    .filter((name) =>
      // The outstanding template is named by its file, not its registry name.
      ![...OUTSTANDING].some((f) => f.includes(name.replaceAll("-", "_")))
    )
    .sort();
  assertEquals(
    uncovered,
    [],
    "these registered templates gate their wrapper on a title search that " +
      "this suite does not exercise. Add a factory to FACTORIES — a template " +
      "whose dedup is not covered here is exactly how the defect reached " +
      "eighteen files:\n" + uncovered.join("\n"),
  );
});

Deno.test("wrapper dedup - the outstanding allow-list is not stale", () => {
  // The allow-list is derived, so a fixed template must not still be named.
  for (const file of OUTSTANDING) {
    assert(
      MARKER_DEDUP_AUTHOR_UNVERIFIED_FILES.includes(file),
      `${file} is allow-listed here but not on the manifest`,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-template behaviour
// ---------------------------------------------------------------------------

for (const [name, create] of FACTORIES) {
  Deno.test(`${name} - a planted wrapper title from outside the fleet does not suppress filing`, async () => {
    const template = create(() => Promise.resolve("[]"), {});
    const title = template.buildIssueTitle(REPO);
    const { gh } = ghServing(title, OUTSIDER);

    const shouldFile = await create(gh, { fleetAuthors: FLEET }).shouldFile!({
      repo: REPO,
    });

    assertEquals(
      shouldFile,
      true,
      `${name}: an open issue titled "${title}" by @${OUTSIDER} suppressed ` +
        `the wrapper — the whole idle-task supply for a repository can be ` +
        `switched off by anyone able to open an issue`,
    );
  });

  Deno.test(`${name} - a genuine fleet-authored wrapper still suppresses filing`, async () => {
    const template = create(() => Promise.resolve("[]"), {});
    const title = template.buildIssueTitle(REPO);
    // A sibling host, not this one: cross-host convergence must survive, so
    // the check cannot be `--author @me`.
    const { gh } = ghServing(title, FLEET[1]!);

    assertEquals(
      await create(gh, { fleetAuthors: FLEET }).shouldFile!({ repo: REPO }),
      false,
      `${name}: a wrapper a sibling fleet host filed must still dedup, or ` +
        `every host files its own copy`,
    );
  });

  Deno.test(`${name} - an unresolvable fleet author set files rather than suppresses`, async () => {
    const template = create(() => Promise.resolve("[]"), {});
    const title = template.buildIssueTitle(REPO);
    // Even the fleet's own marker cannot be attributed with no fleet to
    // compare against. A duplicate wrapper is recoverable; a silenced
    // idle-task supply is not.
    const { gh } = ghServing(title, FLEET[0]!);

    assertEquals(
      await create(gh, { fleetAuthors: [] }).shouldFile!({ repo: REPO }),
      true,
      `${name}: an unresolvable fleet author set suppressed the wrapper`,
    );
  });

  Deno.test(`${name} - the dedup search asks gh for the author`, async () => {
    const template = create(() => Promise.resolve("[]"), {});
    const { gh, calls } = ghServing(template.buildIssueTitle(REPO), OUTSIDER);
    await create(gh, { fleetAuthors: FLEET }).shouldFile!({ repo: REPO });

    const search = calls.find(isTitleDedupSearch);
    assert(search, `${name}: no dedup search was issued at all`);
    assert(
      jsonFields(search).split(",").includes("author"),
      `${name}: the dedup search requested "${jsonFields(search)}" — ` +
        `without \`author\` the match cannot be attributed`,
    );
  });
}

// ---------------------------------------------------------------------------
// The two trackers that share the shape
// ---------------------------------------------------------------------------

Deno.test("baseline carryover tracker - a planted title does not suppress the tracker", async () => {
  const title = `Pre-existing quality-gate failures: ${REPO}`;
  const created: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "create") {
      created.push(args);
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(
        JSON.stringify([{
          number: 7,
          title,
          body: "",
          author: { login: OUTSIDER },
        }]),
      );
    }
    return Promise.resolve("[]");
  };

  await fileBaselineCarryoverTracker(REPO, [], {
    ghCommand: gh,
    logger: { warn: () => {} },
    dedupAuthors: { fleetAuthors: FLEET },
  });

  assertEquals(
    created.length,
    1,
    "an outsider's issue with the tracker's title suppressed the tracker, " +
      "so pre-existing quality-gate breakage would never be reported",
  );
});

Deno.test("baseline carryover tracker - a fleet-authored tracker still dedups", async () => {
  const title = `Pre-existing quality-gate failures: ${REPO}`;
  const created: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "create") {
      created.push(args);
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(
        JSON.stringify([{
          number: 7,
          title,
          body: "",
          author: { login: FLEET[0] },
        }]),
      );
    }
    return Promise.resolve("[]");
  };

  await fileBaselineCarryoverTracker(REPO, [], {
    ghCommand: gh,
    logger: { warn: () => {} },
    dedupAuthors: { fleetAuthors: FLEET },
  });

  assertEquals(created.length, 0);
});

Deno.test("audit failure notifier - a planted title does not suppress the tracking issue", async () => {
  let filed = false;
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "list") {
      const search = args[args.indexOf("--search") + 1] ?? "";
      const title = search.replace(/ in:title$/, "");
      return Promise.resolve(JSON.stringify([{
        number: 11,
        title,
        body: "",
        url: `https://github.com/${REPO}/issues/11`,
        author: { login: OUTSIDER },
      }]));
    }
    if (args[0] === "issue" && args[1] === "create") {
      filed = true;
      return Promise.resolve(`https://github.com/${REPO}/issues/12`);
    }
    return Promise.resolve("");
  };

  const result = await notifyAuditFailure({
    repo: REPO,
    ecosystem: "deno",
    ghCommandFn: gh,
    warnFn: () => {},
    dedupAuthors: { fleetAuthors: FLEET },
  });

  assertEquals(result.action, "filed");
  assert(filed, "the advisory tracking issue was never created");
});

Deno.test("audit failure notifier - a fleet-authored tracking issue still dedups", async () => {
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "list") {
      const search = args[args.indexOf("--search") + 1] ?? "";
      const title = search.replace(/ in:title$/, "");
      return Promise.resolve(JSON.stringify([{
        number: 11,
        title,
        body: "",
        url: `https://github.com/${REPO}/issues/11`,
        author: { login: FLEET[0] },
      }]));
    }
    return Promise.resolve("");
  };

  const result = await notifyAuditFailure({
    repo: REPO,
    ecosystem: "deno",
    ghCommandFn: gh,
    warnFn: () => {},
    dedupAuthors: { fleetAuthors: FLEET },
  });

  assertEquals(result.action, "skipped");
  assertEquals(result.issueNumber, 11);
  assertEquals(result.url, `https://github.com/${REPO}/issues/11`);
});

Deno.test("audit failure notifier - a failed lookup is still reported, not swallowed", async () => {
  // Issue #3649's guarantee must survive the author check being added.
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.reject(new Error("gh: API rate limit exceeded"));
    }
    return Promise.resolve("");
  };

  const result = await notifyAuditFailure({
    repo: REPO,
    ecosystem: "deno",
    ghCommandFn: gh,
    warnFn: () => {},
    dedupAuthors: { fleetAuthors: FLEET },
  });

  assertEquals(result.action, "error");
  assert(result.reason?.includes("rate limit"));
});
