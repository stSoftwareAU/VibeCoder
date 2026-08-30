/**
 * Human-action guidance for making a security scan *block* a merge
 * (Issue #600, part of #566).
 *
 * A recommendation issue that only says "add this workflow" leaves the scan
 * advisory: the check reports red and the PR merges anyway. The scan blocks
 * only once its check is listed in a ruleset's required status checks, and
 * only for the branches that ruleset targets — a ruleset covering the default
 * branch alone leaves every `milestone/**` PR unblocked, which is the
 * dominant merge path (Issue #1300).
 *
 * The worker is deliberately excluded from this change: its token is denied
 * the ruleset and repository-settings permissions that editing a ruleset
 * needs (Issue #599, `worker_token_privilege_scanner.ts`). So the fix is
 * guidance addressed to a human, not automation — and it says so.
 *
 * Pure string helpers: no filesystem, no network, no `gh`.
 *
 * Australian English throughout (behaviour, organisation).
 */

/** The milestone ruleset target that must also require the check. */
export const MILESTONE_RULESET_TARGET = "milestone/**";

/**
 * Derive the check-run names a workflow reports, in the `<workflow name> /
 * <job name>` form GitHub shows on a pull request.
 *
 * The workflow name comes from the top-level `name:` key, falling back to
 * `fallbackName` (GitHub itself falls back to the workflow's file path when
 * the key is absent). Each `jobs.<id>` entry contributes one check, named by
 * its own `name:` when it has one and by its id otherwise.
 *
 * Deliberately a line scan rather than a YAML parse: these strings are
 * workflow *templates* full of `${{ }}` expressions and the caller only needs
 * two keys. Matrix jobs expand to one check per combination on GitHub — the
 * base name derived here is still the string a human searches for in the
 * ruleset's check picker.
 *
 * @param text Raw workflow YAML.
 * @param fallbackName Name to use when the workflow declares no `name:`.
 * @returns One name per job, or `[workflowName]` when no job is parseable.
 *   Never empty.
 */
export function checkNamesFromWorkflow(
  text: string,
  fallbackName: string,
): string[] {
  const lines = text.split("\n");
  let workflowName = "";
  let inJobs = false;
  let jobIndent = -1;
  const jobs: { id: string; name?: string }[] = [];

  for (const line of lines) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;

    const topLevel = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (topLevel) {
      if (topLevel[1] === "name" && workflowName === "") {
        workflowName = unquote((topLevel[2] ?? "").trim());
      }
      inJobs = topLevel[1] === "jobs";
      continue;
    }
    if (!inJobs) continue;

    const keyed = /^(\s+)([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (!keyed) continue;
    const indent = (keyed[1] ?? "").length;
    const key = keyed[2] as string;
    const value = unquote((keyed[3] ?? "").trim());

    if (jobIndent < 0) jobIndent = indent;
    if (indent === jobIndent) {
      jobs.push({ id: key });
    } else if (indent === jobIndent + 2 && key === "name" && value !== "") {
      const job = jobs[jobs.length - 1];
      if (job && job.name === undefined) job.name = value;
    }
  }

  const name = workflowName === "" ? fallbackName : workflowName;
  if (jobs.length === 0) return [name];
  return jobs.map((job) => `${name} / ${job.name ?? job.id}`);
}

/** Strip one layer of matching quotes from a scalar value. */
function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? (quoted[2] as string) : value;
}

/**
 * Build the "make it block merges" markdown section for a scan whose checks
 * are `checkNames`.
 *
 * Rendered as an `###` sub-section so it nests under both the `###`-headed
 * workflow-sync issue bodies and the `## Suggested fix` block of a
 * best-practice finding.
 *
 * @throws Error when `checkNames` is empty — a section that names no check
 *   tells the human nothing actionable, so this fails loudly rather than
 *   emitting vague prose.
 */
export function requiredStatusCheckSection(
  checkNames: readonly string[],
): string {
  const names = checkNames.filter((n) => n.trim() !== "");
  if (names.length === 0) {
    throw new Error(
      "requiredStatusCheckSection() needs at least one check name — " +
        "guidance that names no check cannot be acted on (Issue #600).",
    );
  }
  const checkList = names.length === 1
    ? `\`${names[0]}\``
    : names.map((n) => `\n   - \`${n}\``).join("");
  const jobHint = names.length === 1
    ? "The ruleset's check picker lists it under its job name (the part " +
      "after the `/`), sourced from GitHub Actions."
    : "The ruleset's check picker lists each one under its job name (the " +
      "part after the `/`), sourced from GitHub Actions.";

  return `### Make this scan block merges (human action required)

Adding the workflow only makes the scan *advisory*: a red run reports the \
problem and the pull request still merges. It blocks a merge only once its \
check is a **required status check** on the ruleset that gates the branch \
being merged into.

1. Open **Settings → Rules → Rulesets** in this repository.
2. Edit the ruleset that targets the **default branch**, and the ruleset that \
targets \`${MILESTONE_RULESET_TARGET}\` (create it if there is none). Both \
targets matter: a ruleset that requires the check on the default branch alone \
leaves every \`${MILESTONE_RULESET_TARGET}\` pull request merging unblocked, \
and milestone branches are where most pull requests land (Issue #1300).
3. In each ruleset, enable **Require status checks to pass** and add: \
${checkList}
4. Save each ruleset. From then on a failing scan blocks the merge instead of \
merely reporting it.

${jobHint}

**A human must make this change — the worker cannot and must not.** The Vibe \
Coder worker's token is deliberately denied the ruleset and \
repository-settings permissions that editing a ruleset requires, so the \
ruleset that gates merges stays owned by a human administrator.`;
}
