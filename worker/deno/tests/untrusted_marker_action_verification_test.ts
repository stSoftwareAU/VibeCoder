/**
 * A marker nobody in the fleet wrote must not drive an action.
 *
 * The alerting dedups fixed alongside `alert_dedup_authors.ts` all failed
 * the same way — silence. The sites covered here are worse, because the
 * action a planted marker steers is not "stay quiet": it closes issues,
 * disables the security scan, suppresses work permanently, exhausts a
 * retry budget, redirects an escalation body onto an attacker-chosen
 * issue, and writes labels.
 *
 * On a public repository the issue **body** and **title** are both
 * attacker-controlled; only the author is authenticated. So every one of
 * these searches gets the same control — the match counts only when a
 * fleet account wrote it — and every one of them states, in a test, which
 * way it fails when the author cannot be established.
 *
 * The fail direction is **not** uniform, and that is the point:
 *
 *   | site                       | unverifiable match means            |
 *   | -------------------------- | ----------------------------------- |
 *   | `purge_stale_workflow_…`   | close nothing (destructive write)   |
 *   | `security_scan_template`   | scan (never report clean)           |
 *   | `references_refresh`       | file the proposal                   |
 *   | `workflow_sync`            | file the issue                      |
 *   | `shared_cooldown`          | do not suppress the work            |
 *   | `failure_detection_resume` | retry rather than escalate          |
 *   | `escalate_as_work`         | file a fresh escalation             |
 *   | `host_escalation`          | create, never comment elsewhere     |
 *   | `collaborator_precheck`    | file a fresh issue                  |
 *   | `best_practices_relabel`   | write no labels                     |
 *
 * The single rule underneath them: *fail towards the action that cannot
 * cause harm*. These assertions exist so the direction is not quietly
 * reversed later by someone optimising for fewer duplicates.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import type { GitHubClient, GitHubComment, Logger, Result } from "../types.ts";
import {
  type CommandOutput,
  purgeStaleWorkflowIssuesForRepo,
} from "../lib/purge_stale_workflow_issues.ts";
import {
  deduplicationTag,
  partialDeduplicationTag,
  syncWorkflowsForRepo,
} from "../setup/workflow_sync.ts";
import { createSecurityScanTemplate } from "../lib/idle_task_templates/security_scan_template.ts";
import {
  extractKnownGapIds,
  parseKnownGapRows,
  REFRESH_MARKER,
  type RefreshDeps,
  type RefreshOptions,
  runReferencesRefresh,
  type SourceGap,
} from "../lib/references_refresh.ts";
import {
  buildCooldownComment,
  hasActiveCooldownSignal,
} from "../lib/shared_cooldown.ts";
import {
  buildResumeAttemptMarker,
  MAX_FAILURE_DETECTION_RESUME_ATTEMPTS,
  resumeFailureDetectionRepair,
} from "../lib/failure_detection_resume.ts";
import { escalateAsWork } from "../lib/escalate_as_work.ts";
import { fileOrCommentIssue } from "../lib/host_escalation.ts";
import {
  PRECHECK_DEDUP_TAG,
  verifyMonitoredCollaborators,
} from "../setup/collaborator_precheck.ts";
import { relabelBestPracticesForRepo } from "../setup/best_practices_relabel.ts";
import { BEST_PRACTICES_MARKER } from "../setup/best_practices_sync.ts";

// ===========================================================================
// Shared fixtures
// ===========================================================================

/** The account this host authenticates as. */
const HOST = "vibe-coder-bot";
/** Anyone at all with an issue-open button on a public repository. */
const OUTSIDER = "passer-by";
/** The fleet, as the worker resolves it. */
const FLEET: readonly string[] = [HOST, "vibe-coder-grq23"];
/** An unresolvable fleet — no configuration, or a config that will not read. */
const UNRESOLVED: readonly string[] = [];

const REPO = "owner/repo";

function ok(stdout: string): CommandOutput {
  return { success: true, stdout, stderr: "" };
}

/** Read the value following `flag`. */
function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function silentLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
    security() {},
    skipReason() {},
    timing() {},
  } as unknown as Logger;
}

// ===========================================================================
// 1. purge_stale_workflow_issues.ts — the destructive one
// ===========================================================================

/** One issue the fake GitHub holds for the purge tests. */
interface PurgeIssue {
  number: number;
  body: string;
  author: string;
}

const GITLEAKS_YAML = `name: Gitleaks
on:
  pull_request:
    branches: ["*"]
jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gitleaks/gitleaks-action@v2
`;

/**
 * A `gh` fake for the purge: it answers the issue search, the visibility
 * probe, language detection and the workflow audit, and records every
 * command so "was a close issued at all" is observable — the return value
 * alone cannot tell a refusal from a failed close.
 */
function purgeGh(issues: PurgeIssue[]) {
  const commands: string[][] = [];
  const runCommand = (cmd: string[]): Promise<CommandOutput> => {
    commands.push(cmd);
    const joined = cmd.join(" ");

    if (joined.includes("gh issue list")) {
      const search = (argValue(cmd, "--search") ?? "")
        .replace(/"/g, "")
        .replace(/\s*in:body$/, "")
        .trim();
      return Promise.resolve(ok(JSON.stringify(
        issues
          .filter((issue) => issue.body.includes(search))
          .map((issue) => ({
            number: issue.number,
            body: issue.body,
            author: { login: issue.author },
          })),
      )));
    }
    if (joined.includes("gh issue close")) return Promise.resolve(ok(""));
    if (
      joined.includes(`repos/${REPO}`) && cmd.includes("--jq") &&
      argValue(cmd, "--jq") === ".visibility"
    ) {
      return Promise.resolve(ok("public"));
    }
    if (joined.includes(`repos/${REPO}/languages`)) {
      return Promise.resolve(ok("{}"));
    }
    if (joined.includes(`repos/${REPO}/contents/.github/workflows/`)) {
      return Promise.resolve(ok(GITLEAKS_YAML));
    }
    if (joined.includes(`repos/${REPO}/contents/.github/workflows`)) {
      return Promise.resolve(
        ok(JSON.stringify([{ name: "gitleaks.yml", type: "file" }])),
      );
    }
    if (joined.includes(`repos/${REPO}/contents/`)) {
      return Promise.resolve(
        ok(JSON.stringify([{ name: "README.md", type: "file" }])),
      );
    }
    return Promise.resolve(ok(""));
  };
  const closes = () =>
    commands.filter((c) => c.join(" ").includes("issue close"));
  return { runCommand, commands, closes };
}

Deno.test("purge - a planted workflow-sync tag never reaches gh issue close", async () => {
  const gh = purgeGh([
    {
      number: 46,
      body: `Nothing to see here.\n${partialDeduplicationTag("gitleaks")}`,
      author: OUTSIDER,
    },
  ]);
  const logs: string[] = [];

  const result = await purgeStaleWorkflowIssuesForRepo(REPO, {
    runCommand: gh.runCommand,
    fleetAuthors: FLEET,
    log: (m) => logs.push(m),
  });

  assert(result.ok, "the pass itself must still succeed");
  assertEquals(
    gh.closes(),
    [],
    "an issue the fleet did not write must not be closed by the fleet",
  );
  assertEquals(result.value.closed, []);
  assert(
    logs.some((l) => l.includes("outside the fleet")),
    `the discard must be logged: ${logs.join("\n")}`,
  );
});

Deno.test("purge - a fleet-authored workflow-sync tag is still closed", async () => {
  const gh = purgeGh([
    {
      number: 46,
      body: `Raised by the fleet.\n${partialDeduplicationTag("gitleaks")}`,
      author: HOST,
    },
  ]);

  const result = await purgeStaleWorkflowIssuesForRepo(REPO, {
    runCommand: gh.runCommand,
    fleetAuthors: FLEET,
  });

  assert(result.ok, "the pass must succeed");
  assertEquals(result.value.closed.map((c) => c.number), [46]);
  assertEquals(
    gh.closes().length,
    1,
    "the genuine stale issue is still closed",
  );
});

Deno.test("purge - an unresolvable fleet closes nothing and says so", async () => {
  const gh = purgeGh([
    {
      number: 46,
      body: `Raised by the fleet.\n${partialDeduplicationTag("gitleaks")}`,
      author: HOST,
    },
  ]);
  const logs: string[] = [];

  const result = await purgeStaleWorkflowIssuesForRepo(REPO, {
    runCommand: gh.runCommand,
    fleetAuthors: UNRESOLVED,
    log: (m) => logs.push(m),
  });

  assert(result.ok);
  assertEquals(
    gh.closes(),
    [],
    "an unverifiable match must never drive the destructive write",
  );
  assert(
    logs.some((l) => l.includes("fleet author set unresolved")),
    logs.join("\n"),
  );
  assert(
    logs.some((l) => l.includes("no issue is closed")),
    `the fail direction must be named in the log: ${logs.join("\n")}`,
  );
});

// ===========================================================================
// 2. security_scan_template.ts — must never report clean
// ===========================================================================

const SEC_FINDING_BODY = "A finding.\n<!-- finding-id: SEC-abc123 -->";

/** A `gh` fake answering the two `shouldFile` gates. */
function scanGh(
  findings: { number: number; body: string; author: string }[],
  wrappers: { number: number; title: string; author: string }[] = [],
  failWith?: Error,
) {
  return (args: string[]): Promise<string> => {
    if (failWith) return Promise.reject(failWith);
    const search = argValue(args, "--search") ?? "";
    if (search.includes("in:title")) {
      return Promise.resolve(JSON.stringify(
        wrappers.map((w) => ({
          number: w.number,
          title: w.title,
          author: { login: w.author },
        })),
      ));
    }
    return Promise.resolve(JSON.stringify(
      findings.map((f) => ({
        number: f.number,
        body: f.body,
        author: { login: f.author },
      })),
    ));
  };
}

Deno.test("security scan - a planted SEC- finding does not disable scanning", async () => {
  const logs: string[] = [];
  const template = createSecurityScanTemplate({
    runSecurityScanFn: () => {
      throw new Error("the scanner is not reached by shouldFile");
    },
    ghCommandFn: scanGh([{
      number: 7,
      body: SEC_FINDING_BODY,
      author: OUTSIDER,
    }]),
    fleetAuthors: FLEET,
    log: (m) => logs.push(m),
  });

  assertEquals(
    await template.shouldFile!({ repo: REPO }),
    true,
    "an outsider's SEC- marker must not stand down the security scan",
  );
});

Deno.test("security scan - a fleet-authored SEC- finding still defers the scan", async () => {
  const template = createSecurityScanTemplate({
    runSecurityScanFn: () => {
      throw new Error("the scanner is not reached by shouldFile");
    },
    ghCommandFn: scanGh([{ number: 7, body: SEC_FINDING_BODY, author: HOST }]),
    fleetAuthors: FLEET,
  });

  assertEquals(
    await template.shouldFile!({ repo: REPO }),
    false,
    "the fix must not be 'always scan' — a real open finding still defers",
  );
});

Deno.test("security scan - a planted wrapper title does not disable scanning", async () => {
  const template = createSecurityScanTemplate({
    runSecurityScanFn: () => {
      throw new Error("the scanner is not reached by shouldFile");
    },
    ghCommandFn: scanGh([], [
      { number: 9, title: "Run a security scan", author: OUTSIDER },
    ]),
    fleetAuthors: FLEET,
  });

  assertEquals(
    await template.shouldFile!({ repo: REPO }),
    true,
    "anyone can title an issue 'Run a security scan'",
  );
});

Deno.test("security scan - a lookup that cannot run scans rather than reporting clean", async () => {
  const logs: string[] = [];
  const template = createSecurityScanTemplate({
    runSecurityScanFn: () => {
      throw new Error("the scanner is not reached by shouldFile");
    },
    ghCommandFn: scanGh([], [], new Error("gh: API rate limit exceeded")),
    fleetAuthors: FLEET,
    log: (m) => logs.push(m),
  });

  assertEquals(
    await template.shouldFile!({ repo: REPO }),
    true,
    "a security control that cannot run must scan, never report clean",
  );
  assert(
    logs.some((l) => l.includes("rate limit")),
    `the failed lookup must be loud, not swallowed: ${logs.join("\n")}`,
  );
});

Deno.test("security scan - an unresolvable fleet scans and says so", async () => {
  const logs: string[] = [];
  const template = createSecurityScanTemplate({
    runSecurityScanFn: () => {
      throw new Error("the scanner is not reached by shouldFile");
    },
    ghCommandFn: scanGh([{ number: 7, body: SEC_FINDING_BODY, author: HOST }]),
    fleetAuthors: UNRESOLVED,
    log: (m) => logs.push(m),
  });

  assertEquals(await template.shouldFile!({ repo: REPO }), true);
  assert(
    logs.some((l) => l.includes("the scan goes ahead")),
    `the fail direction must be named in the log: ${logs.join("\n")}`,
  );
});

// ===========================================================================
// 3a. references_refresh.ts — a planted CLOSED issue suppresses forever
// ===========================================================================

const REFERENCES_DOC = [
  "| Source | What we took | Where it shows up |",
  "| ------ | ------------ | ----------------- |",
  "| [mattpocock/skills](https://github.com/mattpocock/skills) | The grilling " +
  "session | `prompts/grill-me/`, `docs/workflows/grill-me.md` |",
].join("\n");

const SKILLS_URL = "https://github.com/mattpocock/skills";

const SKILLS_GAP: SourceGap = {
  key: "the-new-idea",
  unit: "The new idea",
  detail: ["Something worth having."],
};

interface RefsIssue {
  number: number;
  state: "OPEN" | "CLOSED";
  body: string;
  author: string;
}

function refsHarness(seeded: RefsIssue[], fleetAuthors: readonly string[]) {
  const issues = [...seeded];
  const created: string[] = [];
  const logs: string[] = [];
  let next = 900;
  const deps: RefreshDeps = {
    probeFn: (entry) =>
      Promise.resolve(
        entry.url === SKILLS_URL
          ? { revision: "rev-2", gaps: [SKILLS_GAP] }
          : { revision: "rev-1", gaps: [] },
      ),
    readTextFn: (path) =>
      path === "docs/REFERENCES.md"
        ? Promise.resolve(REFERENCES_DOC)
        : Promise.reject(new Deno.errors.NotFound(path)),
    writeTextFn: () => Promise.resolve(),
    ghCommandFn: (args) => {
      if (args[1] === "list") {
        const term = (argValue(args, "--search") ?? "").replace(" in:body", "");
        return Promise.resolve(JSON.stringify(
          issues
            .filter((i) => i.body.includes(term))
            .map((i) => ({
              number: i.number,
              body: i.body,
              author: { login: i.author },
            })),
        ));
      }
      if (args[1] === "create") {
        next += 1;
        created.push(argValue(args, "--title") ?? "");
        return Promise.resolve(`https://github.com/${REPO}/issues/${next}\n`);
      }
      return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
    },
    fleetAuthors,
    log: (m: string) => logs.push(m),
  };
  const options: RefreshOptions = {
    slug: REPO,
    referencesPath: "docs/REFERENCES.md",
    statePath: ".github/references-refresh-state.json",
    fileIssues: true,
    maxIssues: 10,
    now: new Date("2026-09-01T00:00:00Z"),
  };
  return { deps, options, created, logs };
}

/** The gap id the sweep mints for the seeded source and gap. */
async function skillsGapId(): Promise<string> {
  const { gapId } = await import("../lib/references_refresh.ts");
  return await gapId(SKILLS_URL, SKILLS_GAP.key);
}

Deno.test("references refresh - a planted closed marker does not silence the proposal", async () => {
  const id = await skillsGapId();
  const h = refsHarness([{
    number: 5,
    state: "CLOSED",
    body: `Rejected.\n<!-- ${REFRESH_MARKER}-id: ${id} -->`,
    author: OUTSIDER,
  }], FLEET);

  const result = await runReferencesRefresh(h.options, h.deps);

  assert(result.ok, result.summary);
  assertEquals(
    result.alreadyFiled,
    [],
    "a closed issue anyone could open must not suppress a proposal for ever",
  );
  assertEquals(h.created.length, 1, "the proposal is still filed");
});

Deno.test("references refresh - a fleet-authored marker still suppresses the proposal", async () => {
  const id = await skillsGapId();
  const h = refsHarness([{
    number: 5,
    state: "CLOSED",
    body: `Considered and rejected.\n<!-- ${REFRESH_MARKER}-id: ${id} -->`,
    author: HOST,
  }], FLEET);

  const result = await runReferencesRefresh(h.options, h.deps);

  assert(result.ok, result.summary);
  assertEquals(result.alreadyFiled, [id]);
  assertEquals(h.created, [], "a proposal a human rejected stays rejected");
});

Deno.test("references refresh - an unresolvable fleet files rather than stays silent", async () => {
  const id = await skillsGapId();
  const h = refsHarness([{
    number: 5,
    state: "CLOSED",
    body: `Considered and rejected.\n<!-- ${REFRESH_MARKER}-id: ${id} -->`,
    author: HOST,
  }], UNRESOLVED);

  const result = await runReferencesRefresh(h.options, h.deps);

  assert(result.ok, result.summary);
  assertEquals(h.created.length, 1);
  assert(
    h.logs.some((l) => l.includes("fleet author set unresolved")),
    h.logs.join("\n"),
  );
});

Deno.test("references refresh - the parser keeps the author beside the marker", () => {
  const rows = parseKnownGapRows(JSON.stringify([{
    number: 5,
    body: `<!-- ${REFRESH_MARKER}-id: REF-000000000000 -->`,
    author: { login: HOST },
  }]));
  assertEquals(rows[0]?.author?.login, HOST);
  assertEquals([...extractKnownGapIds(rows).keys()], ["REF-000000000000"]);
});

// ===========================================================================
// 3b. setup/workflow_sync.ts — the same permanent suppression
// ===========================================================================

/** A `gh` fake answering language detection, the audit and the dedup search. */
function syncGh(issues: { number: number; body: string; author: string }[]) {
  const commands: string[][] = [];
  const runCommand = (cmd: string[]): Promise<CommandOutput> => {
    commands.push(cmd);
    const joined = cmd.join(" ");
    if (joined.includes("gh issue list")) {
      const search = (argValue(cmd, "--search") ?? "")
        .replace(/"/g, "")
        .replace(/\s*in:body$/, "")
        .trim();
      return Promise.resolve(ok(JSON.stringify(
        issues
          .filter((i) => i.body.includes(search))
          .map((i) => ({
            number: i.number,
            body: i.body,
            author: { login: i.author },
          })),
      )));
    }
    if (joined.includes("gh issue create")) {
      return Promise.resolve(ok(`https://github.com/${REPO}/issues/1\n`));
    }
    if (joined.includes(`repos/${REPO}/languages`)) {
      return Promise.resolve(ok("{}"));
    }
    if (joined.includes(`repos/${REPO}/contents/.github/workflows`)) {
      return Promise.resolve(ok(JSON.stringify([])));
    }
    if (joined.includes(`repos/${REPO}/contents/`)) {
      return Promise.resolve(
        ok(JSON.stringify([{ name: "README.md", type: "file" }])),
      );
    }
    return Promise.resolve(ok(""));
  };
  const creates = () =>
    commands.filter((c) => c.join(" ").includes("issue create"));
  return { runCommand, creates };
}

Deno.test("workflow sync - a planted dedup tag does not suppress the issue for ever", async () => {
  const gh = syncGh([{
    number: 3,
    body: `Unrelated.\n${deduplicationTag("gitleaks")}`,
    author: OUTSIDER,
  }]);

  const result = await syncWorkflowsForRepo(REPO, {
    runCommand: gh.runCommand,
    fleetAuthors: FLEET,
  });

  assert(result.ok, result.error);
  assert(
    gh.creates().some((c) =>
      (argValue(c, "--body") ?? "").includes(deduplicationTag("gitleaks"))
    ),
    "an outsider's tag in a closed issue must not suppress the sync for ever",
  );
});

Deno.test("workflow sync - a fleet-authored dedup tag still suppresses", async () => {
  const gh = syncGh([{
    number: 3,
    body: `Filed by the fleet.\n${deduplicationTag("gitleaks")}`,
    author: HOST,
  }]);

  const result = await syncWorkflowsForRepo(REPO, {
    runCommand: gh.runCommand,
    fleetAuthors: FLEET,
  });

  assert(result.ok, result.error);
  assert(
    !gh.creates().some((c) =>
      (argValue(c, "--body") ?? "").includes(deduplicationTag("gitleaks"))
    ),
    "the fleet's own gitleaks issue must not be re-filed",
  );
});

// ===========================================================================
// 4. shared_cooldown.ts — the projection threw the author away
// ===========================================================================

/** One comment the fake REST API holds. */
interface FakeComment {
  body: string;
  user: { login: string };
}

/**
 * A `gh api … --jq` fake that models jq's object construction rather than
 * recording the request: it applies the `select(.body | test(...))` filter
 * and then projects exactly the paths the caller named. A projection that
 * drops `.user.login` therefore truthfully returns rows with no author,
 * and a test written against the old projection cannot pass by accident.
 */
function commentsGh(comments: FakeComment[]) {
  return (args: string[]): Promise<string> => {
    const jq = argValue(args, "--jq") ?? "";
    const test = jq.match(/test\("([^"]*)"\)/)?.[1] ?? "";
    const shape = jq.match(/\{([^}]*)\}/)?.[1] ?? "";
    const fields = shape.split(",").map((pair) => {
      const [key, path] = pair.split(":");
      return { key: (key ?? "").trim(), path: (path ?? "").trim() };
    }).filter((f) => f.key !== "" && f.path.startsWith("."));
    const selected = comments.filter((c) =>
      new RegExp(test.replace(/\\/g, "")).test(c.body)
    );
    return Promise.resolve(JSON.stringify(selected.map((c) => {
      const row: Record<string, unknown> = {};
      for (const field of fields) {
        let value: unknown = c;
        for (const segment of field.path.slice(1).split(".")) {
          value = (value as Record<string, unknown> | undefined)?.[segment];
        }
        row[field.key] = value;
      }
      return row;
    })));
  };
}

Deno.test("shared cooldown - a planted cooldown comment does not park the issue", async () => {
  const now = Math.floor(Date.now() / 1000);
  const logs: string[] = [];

  const active = await hasActiveCooldownSignal(
    REPO,
    42,
    600,
    commentsGh([{
      body: buildCooldownComment("worker-1", now),
      user: { login: OUTSIDER },
    }]),
    { fleetAuthors: FLEET },
    (m) => logs.push(m),
  );

  assertEquals(
    active,
    false,
    "anyone can post a COOLDOWN comment; only the fleet's own counts",
  );
});

Deno.test("shared cooldown - a fleet-authored cooldown comment still parks the issue", async () => {
  const now = Math.floor(Date.now() / 1000);

  const active = await hasActiveCooldownSignal(
    REPO,
    42,
    600,
    commentsGh([{
      body: buildCooldownComment("worker-1", now),
      user: { login: HOST },
    }]),
    { fleetAuthors: FLEET },
    () => {},
  );

  assertEquals(active, true, "cross-worker cooldown must still work");
});

Deno.test("shared cooldown - an unresolvable fleet does not suppress the work", async () => {
  const now = Math.floor(Date.now() / 1000);
  const logs: string[] = [];

  const active = await hasActiveCooldownSignal(
    REPO,
    42,
    600,
    commentsGh([{
      body: buildCooldownComment("worker-1", now),
      user: { login: HOST },
    }]),
    { fleetAuthors: UNRESOLVED },
    (m) => logs.push(m),
  );

  assertEquals(active, false, "an unverifiable cooldown must not stop work");
  assert(
    logs.some((l) => l.includes("the issue is not skipped")),
    `the fail direction must be named in the log: ${logs.join("\n")}`,
  );
});

// ===========================================================================
// 5. failure_detection_resume.ts — a planted attempt marker burns the budget
// ===========================================================================

function resumeComment(body: string, author: string): GitHubComment {
  return {
    id: 1,
    body,
    author,
    createdAt: new Date(0).toISOString(),
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

function resumeClient(comments: GitHubComment[], recorder: {
  labelsAdded: string[];
  labelsRemoved: string[];
  comments: string[];
}): GitHubClient {
  return {
    getIssueComments: () => Promise.resolve(comments),
    postComment: (_r: string, _n: number, body: string) => {
      recorder.comments.push(body);
      return Promise.resolve(undefined);
    },
    addLabel: (_r: string, _n: number, label: string) => {
      recorder.labelsAdded.push(label);
      return Promise.resolve();
    },
    removeLabel: (_r: string, _n: number, label: string) => {
      recorder.labelsRemoved.push(label);
      return Promise.resolve();
    },
  } as unknown as GitHubClient;
}

/** A `gh` stub whose parent reports no enumerable sub-issues. */
const noSubIssues = (args: string[]): Promise<string> =>
  args[0] === "api" && (args[1] ?? "").includes("/sub_issues")
    ? Promise.resolve("[]")
    : Promise.resolve("");

const forbiddenClaude = (): Promise<Result<{ output: string }>> =>
  Promise.resolve({ ok: true as const, value: { output: "" } });

Deno.test("failure-detection resume - a planted attempt marker does not spend the budget", async () => {
  const recorder: {
    labelsAdded: string[];
    labelsRemoved: string[];
    comments: string[];
  } = { labelsAdded: [], labelsRemoved: [], comments: [] };
  const spent = Array.from(
    { length: MAX_FAILURE_DETECTION_RESUME_ATTEMPTS },
    (_, i) => resumeComment(buildResumeAttemptMarker(i + 1), OUTSIDER),
  );

  const outcome = await resumeFailureDetectionRepair({
    repo: REPO,
    parentIssueNumber: 100,
    ghClient: resumeClient(spent, recorder),
    ghCommandFn: noSubIssues,
    runClaude: forbiddenClaude,
    logger: silentLogger(),
    needsHumanLabel: "needs-human",
    fleetAuthors: FLEET,
    escalationDeps: {
      github: {
        ensureLabelExists: () =>
          Promise.resolve({ ok: true, value: undefined }),
      },
    },
  });

  assert(
    outcome.status !== "escalated",
    "a stranger's attempt marker must not force the escalated outcome",
  );
  assertEquals(
    recorder.labelsAdded.includes("needs-human"),
    false,
    "and must not hand the parent to a human",
  );
});

Deno.test("failure-detection resume - a fleet-authored attempt marker still spends the budget", async () => {
  const recorder: {
    labelsAdded: string[];
    labelsRemoved: string[];
    comments: string[];
  } = { labelsAdded: [], labelsRemoved: [], comments: [] };
  const spent = Array.from(
    { length: MAX_FAILURE_DETECTION_RESUME_ATTEMPTS },
    (_, i) => resumeComment(buildResumeAttemptMarker(i + 1), HOST),
  );

  const outcome = await resumeFailureDetectionRepair({
    repo: REPO,
    parentIssueNumber: 100,
    ghClient: resumeClient(spent, recorder),
    ghCommandFn: noSubIssues,
    runClaude: forbiddenClaude,
    logger: silentLogger(),
    needsHumanLabel: "needs-human",
    fleetAuthors: FLEET,
    escalationDeps: {
      github: {
        ensureLabelExists: () =>
          Promise.resolve({ ok: true, value: undefined }),
      },
    },
  });

  assertEquals(
    outcome.status,
    "escalated",
    "the fix must not be 'never escalate' — a real spent budget still does",
  );
});

// ===========================================================================
// 6a. escalate_as_work.ts — the escalation body lands on the matched issue
// ===========================================================================

function escalationGh(
  issues: { number: number; title: string; author: string }[],
) {
  const commands: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    commands.push(args);
    if (args[1] === "list") {
      return Promise.resolve(JSON.stringify(
        issues.map((i) => ({
          number: i.number,
          title: i.title,
          author: { login: i.author },
        })),
      ));
    }
    if (args[1] === "create") {
      return Promise.resolve(`https://github.com/${REPO}/issues/321\n`);
    }
    return Promise.resolve("");
  };
  const comments = () => commands.filter((c) => c[1] === "comment");
  const creates = () => commands.filter((c) => c[1] === "create");
  return { gh, commands, comments, creates };
}

Deno.test("escalate as work - a planted title never receives the escalation body", async () => {
  const escalation = {
    repo: REPO,
    prNumber: 7,
    summary: "CI has been red for 2h",
    reason: "semgrep is failing",
    nextStep: "fix the semgrep finding",
  };
  const title = (await import("../lib/escalate_as_work.ts"))
    .workEscalationTitle(escalation);
  const gh = escalationGh([{ number: 55, title, author: OUTSIDER }]);

  const result = await escalateAsWork(escalation, {
    gh: gh.gh,
    fleetAuthors: FLEET,
  });

  assert(result.ok);
  assertEquals(
    gh.comments(),
    [],
    "the escalation must not be redirected onto an attacker-chosen issue",
  );
  assertEquals(gh.creates().length, 1, "a fresh escalation is filed instead");
  assertEquals(result.value.filed, true);
});

Deno.test("escalate as work - a fleet-authored title still deduplicates", async () => {
  const escalation = {
    repo: REPO,
    prNumber: 7,
    summary: "CI has been red for 2h",
    reason: "semgrep is failing",
    nextStep: "fix the semgrep finding",
  };
  const title = (await import("../lib/escalate_as_work.ts"))
    .workEscalationTitle(escalation);
  const gh = escalationGh([{ number: 55, title, author: HOST }]);

  const result = await escalateAsWork(escalation, {
    gh: gh.gh,
    fleetAuthors: FLEET,
  });

  assert(result.ok);
  assertEquals(result.value.issueNumber, 55);
  assertEquals(result.value.filed, false);
  assertEquals(gh.comments().length, 1, "an ongoing blockage stays one issue");
});

// ===========================================================================
// 6b. host_escalation.ts — "commented" must mean the fleet's own issue
// ===========================================================================

Deno.test("host escalation - a planted title is created fresh, never commented on", async () => {
  const commands: string[][] = [];
  const delivery = await fileOrCommentIssue({
    repo: REPO,
    title: "GRQ-23: the checkout could not be updated",
    body: "the report",
    env: {},
  }, {
    ghFn: (args: readonly string[]) => {
      commands.push([...args]);
      if (args[1] === "list") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([{
            number: 8,
            title: "GRQ-23: the checkout could not be updated",
            author: { login: OUTSIDER },
          }]),
          stderr: "",
          success: true,
        });
      }
      return Promise.resolve({
        code: 0,
        stdout: "",
        stderr: "",
        success: true,
      });
    },
    fleetAuthors: FLEET,
  });

  assertEquals(
    delivery,
    "created",
    "reporting 'commented' when the report landed on a stranger's issue is a lie",
  );
  assert(
    !commands.some((c) => c[1] === "comment"),
    "the escalation body must not be posted onto an attacker-chosen issue",
  );
});

Deno.test("host escalation - a fleet-authored title is still commented on", async () => {
  const commands: string[][] = [];
  const delivery = await fileOrCommentIssue({
    repo: REPO,
    title: "GRQ-23: the checkout could not be updated",
    body: "the report",
    env: {},
  }, {
    ghFn: (args: readonly string[]) => {
      commands.push([...args]);
      if (args[1] === "list") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([{
            number: 8,
            title: "GRQ-23: the checkout could not be updated",
            author: { login: HOST },
          }]),
          stderr: "",
          success: true,
        });
      }
      return Promise.resolve({
        code: 0,
        stdout: "",
        stderr: "",
        success: true,
      });
    },
    fleetAuthors: FLEET,
  });

  assertEquals(delivery, "commented", "one issue per host per condition");
  assertEquals(commands.filter((c) => c[1] === "comment").length, 1);
});

// ===========================================================================
// 6c. setup/collaborator_precheck.ts — the follow-up carries invite commands
// ===========================================================================

function precheckGh(
  issues: { number: number; body: string; author: string }[],
) {
  const commands: string[][] = [];
  const runCommand = (cmd: string[]): Promise<CommandOutput> => {
    commands.push(cmd);
    const joined = cmd.join(" ");
    if (joined.includes("gh api user")) {
      return Promise.resolve(ok(HOST));
    }
    if (joined.includes("gh issue list")) {
      const search = (argValue(cmd, "--search") ?? "")
        .replace(/"/g, "")
        .replace(/\s*in:body$/, "")
        .trim();
      return Promise.resolve(ok(JSON.stringify(
        issues
          .filter((i) => i.body.includes(search))
          .map((i) => ({
            number: i.number,
            body: i.body,
            author: { login: i.author },
          })),
      )));
    }
    if (joined.includes("gh issue create")) {
      return Promise.resolve(ok(`https://github.com/${REPO}/issues/1\n`));
    }
    if (joined.includes("gh issue comment")) return Promise.resolve(ok(""));
    // Every repo access probe fails, so the precheck has something to report.
    return Promise.resolve({ success: false, stdout: "", stderr: "no access" });
  };
  const comments = () =>
    commands.filter((c) => c.join(" ").includes("issue comment"));
  return { runCommand, commands, comments };
}

Deno.test("collaborator precheck - a planted dedup tag never receives the invite commands", async () => {
  const gh = precheckGh([{
    number: 12,
    body: `Unrelated issue.\n${PRECHECK_DEDUP_TAG}`,
    author: OUTSIDER,
  }]);

  const result = await verifyMonitoredCollaborators({
    repos: ["owner/target"],
    runCommand: gh.runCommand,
    targetRepo: REPO,
    fleetAuthors: FLEET,
  });

  assertEquals(
    gh.comments(),
    [],
    "the follow-up carries collaborator-invite commands; it goes on our issue only",
  );
  assertEquals(result.issueFiled, true, "a fresh precheck issue is filed");
  assertEquals(result.issueUpdated, false);
});

Deno.test("collaborator precheck - a fleet-authored dedup tag is still commented on", async () => {
  const gh = precheckGh([{
    number: 12,
    body: `Filed by the fleet.\n${PRECHECK_DEDUP_TAG}`,
    author: HOST,
  }]);

  const result = await verifyMonitoredCollaborators({
    repos: ["owner/target"],
    runCommand: gh.runCommand,
    targetRepo: REPO,
    fleetAuthors: FLEET,
  });

  assertEquals(result.issueUpdated, true);
  assertEquals(result.issueFiled, false);
  assertEquals(gh.comments().length, 1);
});

// ===========================================================================
// 7. setup/best_practices_relabel.ts — labels written onto every match
// ===========================================================================

function relabelGh(
  issues: { number: number; body: string; author: string; labels: string[] }[],
) {
  const commands: string[][] = [];
  const runCommand = (cmd: string[]): Promise<CommandOutput> => {
    commands.push(cmd);
    const joined = cmd.join(" ");
    if (joined.includes("gh issue list")) {
      const search = (argValue(cmd, "--search") ?? "")
        .replace(/"/g, "")
        .replace(/\s*in:body$/, "")
        .trim();
      return Promise.resolve(ok(JSON.stringify(
        issues
          .filter((i) => i.body.includes(search))
          .map((i) => ({
            number: i.number,
            body: i.body,
            labels: i.labels.map((name) => ({ name })),
            author: { login: i.author },
          })),
      )));
    }
    return Promise.resolve(ok("[]"));
  };
  const writes = () =>
    commands.filter((c) => {
      const joined = c.join(" ");
      return joined.includes("issue edit") || joined.includes("label create");
    });
  return { runCommand, commands, writes };
}

const RELABEL_BODY = [
  `Findings.\n${BEST_PRACTICES_MARKER}`,
  "",
  "- severity: **high**",
].join("\n");

Deno.test("best practices relabel - a planted marker gets no labels written", async () => {
  const gh = relabelGh([{
    number: 30,
    body: RELABEL_BODY,
    author: OUTSIDER,
    labels: [],
  }]);

  const result = await relabelBestPracticesForRepo(REPO, {
    ghCommandFn: gh.runCommand,
    fleetAuthors: FLEET,
  });

  assertEquals(
    result.scanned,
    0,
    "an outsider's issue is not a scan candidate",
  );
  assertEquals(result.relabelled, 0);
  assertEquals(gh.writes(), [], "no label is written onto a stranger's issue");
});

Deno.test("best practices relabel - a fleet-authored marker is still relabelled", async () => {
  const gh = relabelGh([{
    number: 30,
    body: RELABEL_BODY,
    author: HOST,
    labels: [],
  }]);

  const result = await relabelBestPracticesForRepo(REPO, {
    ghCommandFn: gh.runCommand,
    fleetAuthors: FLEET,
    dryRun: true,
  });

  assertEquals(result.scanned, 1);
  assertEquals(result.relabelled, 1, "the backfill still does its job");
});
