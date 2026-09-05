/**
 * The filer command supplies its fleet gate with the claim scan's inputs
 * (Issue #1050).
 *
 * `anyRepoHasUnblockedRealWork` can model every gate the scan applies and
 * still make no difference to a running worker, because the data those gates
 * need — the fleet's open PRs, the fleet identity — is supplied by
 * `commands/maybe_file_idle_task.ts` and by nothing else. That is the shape
 * of both field incidents: the gate was fine, its inputs were missing, and
 * every unit test passed because each one handed the gate its own data.
 *
 * So this test drives the real command with a `gh` stub and asserts on the
 * decision it reaches. `org/pr-blocked` holds six `work-on` issues behind one
 * open fleet PR — the `stSoftwareAU/NEAT-AI-Ockham` shape of 2026-09-05, six
 * issues (#104-#110) behind PR #116 — and the scan can start none of them.
 * The filer must therefore not skip with `approved_work_in_flight`.
 *
 * The inverse is asserted with the same stub minus the PR: the six issues
 * become startable, and the filer must skip. Without that pairing the fix
 * degrades to "always file" and re-introduces the #2106 flooding.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { maybeFileIdleTaskCommand } from "../commands/maybe_file_idle_task.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  getTemplate,
  type IdleTaskTemplate,
  registerTemplate,
} from "../lib/idle_task_template.ts";
import type { IdleTaskMilestone } from "../lib/idle_task_milestone.ts";
import type { Result, WorkerConfig } from "../types.ts";

const WORKER_USER = "worker-bot";
const SIBLING = "sibling-bot";
/**
 * Repository names are per-case, because the filer's PR probes read through
 * the shared, file-backed issue cache: one case's `prs_<author>` entry would
 * otherwise answer the other case's probe.
 */
function repos(caseName: string): { blocked: string; quiet: string } {
  return {
    blocked: `org/filer-gate-1050-${caseName}-blocked`,
    quiet: `org/filer-gate-1050-${caseName}-quiet`,
  };
}

/** A test-only template, so the filer does not depend on production prose. */
const TEMPLATE_NAME = "filer-gate-1050-template";
const testTemplate: IdleTaskTemplate = {
  name: TEMPLATE_NAME,
  description: "Test-only template for the Issue #1050 filer-gate wiring.",
  buildIssueTitle: (repo) => `Run ${TEMPLATE_NAME} on ${repo}`,
  buildIssueBody: (opts) => `# ${TEMPLATE_NAME} on ${opts.repo}`,
  runTask: () => Promise.resolve({ ok: true, summary: `${TEMPLATE_NAME} ran` }),
};
if (getTemplate(TEMPLATE_NAME) === undefined) registerTemplate(testTemplate);

function config(names: { blocked: string; quiet: string }): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [names.blocked, names.quiet],
    allowedAuthors: ["human-dev", WORKER_USER],
    fleetPrAuthors: [SIBLING],
  };
}

/** Six unassigned `work-on` issues in the default-branch stream. */
function blockedBacklog(repo: string): Array<Record<string, unknown>> {
  return [104, 105, 107, 108, 109, 110].map((number) => ({
    number,
    title: `Backlog ${number}`,
    url: `https://github.com/${repo}/issues/${number}`,
    labels: [{ name: "work-on" }],
    assignees: [],
    milestone: null,
    body: "",
  }));
}

/**
 * A `gh` stub over the two-repo fleet. `withOpenPr` decides whether the fleet
 * has an open PR in `BLOCKED_REPO`'s default-branch stream.
 */
function makeGh(
  names: { blocked: string; quiet: string },
  withOpenPr: boolean,
): { fn: (args: string[]) => Promise<string>; created: string[] } {
  const created: string[] = [];
  const fn = (args: string[]): Promise<string> => {
    const repoIdx = args.indexOf("--repo");
    const repo = repoIdx >= 0 ? args[repoIdx + 1] ?? "" : "";

    if (args[0] === "pr" && args[1] === "list") {
      const state = args[args.indexOf("--state") + 1] ?? "";
      if (state === "open" && withOpenPr && repo === names.blocked) {
        return Promise.resolve(JSON.stringify([{
          number: 116,
          title: "Fix the thing",
          baseRefName: "main",
          headRefName: "issue-104-fix",
          url: `https://github.com/${repo}/pull/116`,
          body: "",
        }]));
      }
      return Promise.resolve("[]");
    }
    if (args[0] === "issue" && args[1] === "list") {
      const labelIdx = args.indexOf("--label");
      const label = labelIdx >= 0 ? args[labelIdx + 1] ?? "" : "";
      const rows = repo === names.blocked ? blockedBacklog(repo) : [];
      // A label-filtered query (the per-repo busy check) sees only issues
      // carrying that label.
      const filtered = label === ""
        ? rows
        : rows.filter((r) =>
          (r.labels as Array<{ name: string }>).some((l) => l.name === label)
        );
      return Promise.resolve(JSON.stringify(filtered));
    }
    if (args[0] === "issue" && args[1] === "create") {
      created.push(repo);
      return Promise.resolve(`https://github.com/${repo}/issues/9999\n`);
    }
    return Promise.resolve("");
  };
  return { fn, created };
}

/**
 * Run the real filer over the two-repo fleet and return everything it logged.
 * Every gate downstream of the fleet-global one is stubbed to "clear", so a
 * run that gets past the gate under test never reaches the network.
 */
async function runFiler(
  caseName: string,
  withOpenPr: boolean,
): Promise<{ log: string[]; created: string[] }> {
  const names = repos(caseName);
  const gh = makeGh(names, withOpenPr);
  const log: string[] = [];
  await maybeFileIdleTaskCommand.execute(
    {
      "monitored-repos": `${names.blocked},${names.quiet}`,
      "github-user": WORKER_USER,
      "worker-user": WORKER_USER,
      __testDeps: {
        ghCommandFn: gh.fn,
        pickTemplateFn: () => testTemplate,
        findExistingFn: () => Promise.resolve(null),
        findOpenWrappersFn: () => Promise.resolve([]),
        dueScansFn: () => Promise.resolve([]),
        countOutputLabelOpenIssuesFn: () => Promise.resolve(0),
        isRepoCooledDownFn: () => Promise.resolve(false),
        verifyLabelsFn: () => Promise.resolve(["idle-task"]),
        ensureLabelFn: () =>
          Promise.resolve({ ok: true, value: undefined } as Result<void>),
        ensureMilestoneFn: (opts: { repo: string; template: string }) =>
          Promise.resolve(
            {
              number: 17,
              title: `idle-task: ${opts.template}`,
            } as IdleTaskMilestone,
          ),
        nowFn: () => new Date("2026-09-05T00:00:00.000Z"),
        log: (line: string) => log.push(line),
        randomFn: () => 0,
      },
    } as Record<string, unknown>,
    config(names),
  );
  return { log, created: gh.created };
}

Deno.test(
  "filer gate wiring - a backlog behind an open fleet PR does not suppress filing (Issue #1050)",
  async () => {
    const { log, created } = await runFiler("blocked", true);
    assertEquals(
      log.some((l) => l.includes("reason=approved_work_in_flight")),
      false,
      `six PR-blocked issues are not startable work; log:\n${log.join("\n")}`,
    );
    assert(
      created.length > 0,
      `an idle task must actually be filed; log:\n${log.join("\n")}`,
    );
  },
);

Deno.test(
  "filer gate wiring - the same backlog with no open PR does suppress filing (Issue #2813)",
  async () => {
    const { log, created } = await runFiler("free", false);
    assert(
      log.some((l) => l.includes("reason=approved_work_in_flight")),
      `six startable issues must suppress filing; log:\n${log.join("\n")}`,
    );
    assertEquals(created.length, 0, "nothing may be filed beside real work");
  },
);
