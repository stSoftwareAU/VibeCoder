/**
 * The `merge-fallback` record every conflict fallback leaves behind
 * (Issue #2304, part of #2298), filed in VibeCoder as a worker failure
 * (Issue #4456).
 *
 * A fallback means the worker failed to finish the work, so it is never filed
 * as a new issue in the repository the conflict was in: that read as a fresh
 * work item instead of the worker completing the one it had. It is filed in
 * {@link MERGE_FALLBACK_TARGET_REPO}, labelled `bug`, with one open issue per
 * cause; a repeat appends a comment. VibeCoder is public, so a private source
 * repository is never named there: its repository, branches, PR, paths and
 * the agents' full replies are left out, and only the host, the timings, each
 * run's conclusion and how far behind the branch was are recorded.
 *
 * The conflict ladder ends in a fallback: on the PR path the PR is closed and
 * its originating issue re-queued; on the milestone path the merged children
 * are reverted newest-first and re-queued. Both were silent. The work was
 * undone, the conflict that undid it was not written down anywhere durable,
 * and the next attempt started from the same blank page — so the same
 * conflict could be walked into again with nothing to learn from.
 *
 * This module is the one place that writes that record down, for both paths.
 * It knows nothing about either caller: it takes what the fallback observed
 * and files (or appends to) one issue carrying the `merge-fallback` content
 * label.
 *
 * **Nothing is omitted.** Every field renders, and a field the caller could
 * not record renders as `not recorded` rather than disappearing. A missing
 * section and an unrecorded one look identical once the body is written, and
 * the reader cannot tell "the fleet did not measure this" from "the fleet
 * measured nothing worth saying" — which is exactly the silence this issue
 * exists to remove.
 *
 * **The dedup match is author-verified**, for the same reason every
 * title-keyed dedup in the worker verifies its own: the match is keyed on a
 * title, anyone who can open an issue chooses a title, and an unverified match
 * does two harmful things at once — it suppresses the flag, and it redirects the
 * flag's contents onto an issue somebody else opened. The match must also be
 * **open**: a closed flag means a human has finished with that PR or branch,
 * and a fresh fallback deserves its own issue rather than reopening a
 * conversation that ended.
 *
 * **The fail direction is towards filing.** An unparseable listing, an
 * unresolvable fleet identity or a label that could not be created all end in
 * a filed issue. A duplicate flag is noise a human closes in a moment; a
 * suppressed one is a fallback nobody ever hears about.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */ import { ALERT_DEDUP_TITLE_JSON_FIELDS, selectFleetAuthoredMatches } from "./alert_dedup_authors.ts";
import { sanitiseIssueText } from "./conflict_intent_context.ts";
import { spawnGh } from "./gh_spawn.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import { ensureLabelExists as defaultEnsureLabelExists } from "./label_operations.ts";
/** Content label marking an issue filed by a conflict fallback. */ export const MERGE_FALLBACK_LABEL = "merge-fallback";
/**
 * Where every fallback is filed (Issue #4456): a fallback is the worker's
 * failure, whichever monitored repository the conflict was in.
 */ export const MERGE_FALLBACK_TARGET_REPO = "stSoftwareAU/VibeCoder";
/** Worker-fault label every fallback record carries. */ const BUG_LABEL = "bug";
/** Title and cause when no conclusion names one. */ const UNCLASSIFIED_CAUSE = "unclassified";
/** Longest cause kept in a title. */ const MAX_CAUSE_CHARS = 100;
/** Callsite recorded in the label guard's audit line. */ const CALLER = "worker/deno/lib/merge_fallback_issue.ts";
/**
 * Per-run analysis cap, in characters.
 *
 * A GitHub issue body is capped at 65,536 characters, so two unbounded agent
 * replies can make the filing fail outright — the flag lost to the very thing
 * it records. Truncation is announced in the body rather than applied
 * quietly.
 */ const MAX_ANALYSIS_CHARS = 20_000;
/** Rendered in place of any field the fallback could not record. */ const NOT_RECORDED = "not recorded";
async function defaultGh(args) {
  const result = await spawnGh(args);
  if (!result.success) {
    throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}
/** The names a private source would be recognised by, longest first. */ function sourceNames(target) {
  const names = [
    target.repo,
    target.repo.split("/").pop() ?? "",
    ...target.kind === "pr" ? [
      target.headBranch ?? "",
      target.baseBranch ?? ""
    ] : [
      target.milestoneBranch,
      target.defaultBranch ?? ""
    ]
  ];
  return [
    ...new Set(names.filter((name)=>name.length > 0))
  ].sort((a, b)=>b.length - a.length);
}
/**
 * Text with nothing that names a private source: its repository and branch
 * names, any path or slash-joined name, and any `#N` — a bare number in
 * VibeCoder links to an unrelated VibeCoder issue.
 */ function scrubPrivate(text, target) {
  let scrubbed = text;
  for (const name of sourceNames(target)){
    scrubbed = replaceWord(scrubbed, name, "<source>");
  }
  return scrubbed.replace(/[^\s`'"(),]*\/[^\s`'"(),]*/g, "<path>").replace(/#(\d+)/g, "number $1");
}
/** A character that continues a name, so a match inside a longer one is left. */ function isNameChar(char) {
  return char !== undefined && /[\w/-]/.test(char);
}
/**
 * Every whole-word, case-insensitive occurrence of `word` replaced. A plain
 * scan rather than a regular expression built from the name, so no name can
 * change the pattern.
 */ function replaceWord(text, word, replacement) {
  const haystack = text.toLowerCase();
  const needle = word.toLowerCase();
  let out = "";
  let from = 0;
  for(let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)){
    if (at < from) continue;
    const end = at + needle.length;
    if (isNameChar(text[at - 1]) || isNameChar(text[end])) continue;
    out += text.slice(from, at) + replacement;
    from = end;
  }
  return out + text.slice(from);
}
/** `#N` qualified as `owner/repo#N`, so it never links to a VibeCoder issue. */ function qualifyReferences(text, repo) {
  return text.replace(/(^|[^\w/.-])#(\d+)\b/g, `$1${repo}#$2`);
}
/** One conclusion line, as the milestone ledger writes it. */ const CONCLUSION_RE = /^Concluded `[^`]+` at \S+: (.+)$/m;
/** A refusal that climbed, wrapping the reason it was refused for. */ const REFUSAL_CLIMB_RE = /^refused \d+ cycles? in a row \((.+)\) — climbing/;
/** The conclusion line of one run, when it wrote one. */ function conclusionLine(run) {
  const match = CONCLUSION_RE.exec(run.analysis ?? "");
  return match ? match[0] : undefined;
}
/**
 * Why the fallback was reached — the deduplication key (Issue #4456).
 *
 * The caller's explicit cause, else the last run's conclusion with a refusal
 * climb unwrapped to the reason that was refused and anything after the first
 * colon dropped, so measurements that vary per event cannot split one cause
 * into many issues. Names of the source are scrubbed whatever its
 * visibility, so one cause has one title across every repository.
 *
 * @param event - The fallback event
 * @returns A short, repository-agnostic cause
 */ export function mergeFallbackCause(event) {
  let cause = event.cause?.trim() ?? "";
  if (cause === "") {
    const last = event.runs?.at(-1);
    const match = CONCLUSION_RE.exec(last?.analysis ?? "");
    if (match) {
      const reason = match[1].trim();
      const climbed = REFUSAL_CLIMB_RE.exec(reason);
      cause = (climbed ? climbed[1] : reason).split(":")[0].trim();
    }
  }
  cause = scrubPrivate(sanitiseIssueText(cause), event.target).replace(/\s+/g, " ").trim().slice(0, MAX_CAUSE_CHARS);
  return cause === "" ? UNCLASSIFIED_CAUSE : cause;
}
/**
 * Title of the fallback record — also its deduplication key: one open issue
 * per cause, whichever repository or branch it happened on (Issue #4456).
 */ export function mergeFallbackTitle(event) {
  return `Merge fallback: ${mergeFallbackCause(event)}`;
}
/**
 * Marker tying a record to its cause.
 *
 * Canonical `vibe-*` grammar — a bare prefix and `key="value"` attributes
 * (Issue #842). Quotes are stripped so a cause can never close the attribute
 * early, and no source repository is named.
 */ export function mergeFallbackMarker(event) {
  const cause = mergeFallbackCause(event).replaceAll('"', "");
  return `<!-- vibe-merge-fallback cause="${cause}" -->`;
}
/** One `- **Label**: value` line, saying so when there is no value. */ function field(label, value) {
  const rendered = value === undefined || value === "" ? NOT_RECORDED : sanitiseIssueText(String(value));
  return `- **${label}**: ${rendered}`;
}
/**
 * Fence a block of agent text without letting it escape the fence.
 *
 * The analysis is the agent's own words and may contain a fenced block of
 * its own, so the fence is one backtick longer than the longest run inside
 * it — the CommonMark rule, applied deterministically rather than hoping.
 */ function fenceAnalysis(text) {
  const longestRun = Math.max(0, ...[
    ...text.matchAll(/`+/g)
  ].map((match)=>match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [
    fence,
    text,
    fence
  ];
}
/** The analysis, sanitised, qualified by repo and capped, or `not recorded`. */ function renderAnalysis(analysis, repo) {
  const text = analysis === undefined ? "" : qualifyReferences(sanitiseIssueText(analysis), repo).trim();
  if (text.length === 0) return [
    `- **Analysis**: ${NOT_RECORDED}`
  ];
  let capped = text.length > MAX_ANALYSIS_CHARS ? text.slice(0, MAX_ANALYSIS_CHARS) : text;
  // Never cut through a surrogate pair: half an emoji renders as U+FFFD and
  // makes the truncation look like corruption rather than a bound.
  const lastUnit = capped.charCodeAt(capped.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) capped = capped.slice(0, -1);
  const dropped = text.length - capped.length;
  return [
    "- **Analysis**:",
    "",
    ...fenceAnalysis(capped),
    ...dropped > 0 ? [
      "",
      `_${dropped} characters truncated — the full reply is in the run log._`
    ] : []
  ];
}
/** One run's stage timings line. */ function renderTimings(run) {
  const timings = run.timings ?? [];
  return timings.length === 0 ? `- **Stage timings**: ${NOT_RECORDED}` : `- **Stage timings**: ${timings.map((t)=>`${sanitiseIssueText(t.stage)} ${t.seconds === null ? "unfinished" : `${t.seconds}s`}`).join(", ")}`;
}
/** One run's host, timings and analysis. */ function renderRun(run, repo) {
  return [
    `#### Run ${run.run}`,
    "",
    field("Host", run.host),
    renderTimings(run),
    ...renderAnalysis(run.analysis, repo),
    ""
  ];
}
/** One run of a private source: host, timings and its conclusion only. */ function renderPrivateRun(run, target) {
  const conclusion = conclusionLine(run);
  return [
    `#### Run ${run.run}`,
    "",
    field("Host", run.host),
    renderTimings(run),
    conclusion === undefined ? `- **Conclusion**: ${NOT_RECORDED}` : `- **Conclusion**: ${scrubPrivate(sanitiseIssueText(conclusion), target)}`,
    ""
  ];
}
/** The target block — which PR or branch, and against what. */ function renderTarget(target) {
  if (target.kind === "pr") {
    return [
      field("Repository", target.repo),
      field("Pull request", `${target.repo}#${target.prNumber}`),
      field("Head branch", target.headBranch),
      field("Base branch", target.baseBranch)
    ];
  }
  return [
    field("Repository", target.repo),
    field("Milestone branch", target.milestoneBranch),
    field("Default branch", target.defaultBranch)
  ];
}
/**
 * What the abandoned PR changed, when the fallback read it (Issue #2310).
 *
 * The section renders only when {@link MergeFallbackEvent.diffSummary} is
 * present, because absent means nobody asked: a milestone branch has no PR diff
 * at all, and the PR route that re-queues an originating issue needs none.
 * Printing `not recorded` for a read nobody
 * attempted would claim a measurement failure that never happened.
 *
 * A summary that **was** read and came back empty says so in words, so "GitHub
 * reported no changed file" is never mistaken for "the diff was not read".
 */ function renderDiffSummary(event) {
  const files = event.diffSummary;
  if (files === undefined) return [];
  const omitted = event.diffSummaryOmitted ?? 0;
  return [
    "### What the PR changed",
    "",
    ...files.length === 0 ? [
      "GitHub reported no changed file for this PR."
    ] : files.map((file)=>`- \`${sanitiseIssueText(file.path)}\` ` + `(+${file.additions}/-${file.deletions})`),
    ...omitted > 0 ? [
      "",
      `_${omitted} further path(s) are not listed — the cap was hit._`
    ] : [],
    ""
  ];
}
/**
 * Body of the fallback record — and of the comment appended for a repeat.
 *
 * Pure: the same event and visibility always render the same body. A public
 * source renders every field, one the caller could not record as
 * `not recorded`, with each `#N` qualified by its repository. A private
 * source — the default, so an unknown visibility never leaks — renders only
 * what names nothing of it (Issue #4456).
 */ export function buildMergeFallbackBody(event, visibility = "private") {
  return visibility === "public" ? buildPublicBody(event) : buildPrivateBody(event);
}
function buildPrivateBody(event) {
  const { target, runs = [] } = event;
  const kind = target.kind === "pr" ? "a pull request" : "a milestone branch";
  return [
    mergeFallbackMarker(event),
    "",
    `The conflict fallback ran on ${kind} of a private monitored ` + "repository: the agent runs could not settle the conflict, so the fleet " + "fell back. A fallback is a worker failure (Issue #4456). The source is " + "private, so its repository, branches, paths and the agents' full " + "replies are left out; the hosts and times below find them in each " + "host's run log.",
    "",
    "### Cause",
    "",
    mergeFallbackCause(event),
    "",
    "### Agent runs",
    "",
    ...runs.length === 0 ? [
      NOT_RECORDED,
      ""
    ] : runs.flatMap((run)=>renderPrivateRun(run, target)),
    "### How far behind the base",
    "",
    field("Commits behind the base", event.behindBy),
    field("Behind since", event.behindSince)
  ].join("\n");
}
function buildPublicBody(event) {
  const { target, conflictedFiles = [], runs = [] } = event;
  const repo = sanitiseIssueText(target.repo);
  const what = target.kind === "pr" ? `${repo}#${target.prNumber}` : `${repo} \`${sanitiseIssueText(target.milestoneBranch)}\``;
  return [
    mergeFallbackMarker(event),
    "",
    `The conflict fallback ran on ${what}: the agent runs could not settle ` + "the conflict, so the fleet fell back. A fallback is a worker failure, " + "recorded here so the cause can be fixed rather than walked into again " + "(Issues #2298, #4456).",
    "",
    "### Cause",
    "",
    mergeFallbackCause(event),
    "",
    "### Target",
    "",
    ...renderTarget(target),
    "",
    "### Conflicted files",
    "",
    ...conflictedFiles.length === 0 ? [
      NOT_RECORDED
    ] : conflictedFiles.map((path)=>`- \`${sanitiseIssueText(path)}\``),
    "",
    "### Agent runs",
    "",
    ...runs.length === 0 ? [
      NOT_RECORDED,
      ""
    ] : runs.flatMap((run)=>renderRun(run, repo)),
    ...renderDiffSummary(event),
    "### How far behind the base",
    "",
    field("Commits behind the base", event.behindBy),
    field("Behind since", event.behindSince),
    "",
    "### What was closed or reverted",
    "",
    event.fallbackAction === undefined || event.fallbackAction === "" ? NOT_RECORDED : qualifyReferences(sanitiseIssueText(event.fallbackAction), repo)
  ].join("\n");
}
/** `--json` fields the dedup search needs: author, exact title, state, URL. */ const DEDUP_JSON_FIELDS = `${ALERT_DEDUP_TITLE_JSON_FIELDS},state,url`;
/**
 * The source repository's visibility, read through the caller's `gh`.
 *
 * Anything but an explicit `public` — an error, an empty answer, `internal` —
 * is private, so a failed lookup never names a private repository.
 */ async function sourceVisibility(gh, repo) {
  try {
    const answer = await gh([
      "api",
      `repos/${repo}`,
      "--jq",
      ".visibility"
    ]);
    return answer.trim().toLowerCase() === "public" ? "public" : "private";
  } catch  {
    return "private";
  }
}
/**
 * File one fallback event in VibeCoder as a worker failure, or append it to
 * the open record for the same cause (Issue #4456).
 *
 * @param filing - The event.
 * @param deps - Injected `gh`, label creation, fleet identity and logger.
 * @returns The flag issue, and whether this call appended to an existing one.
 *   A `gh` failure is returned as the error, never swallowed.
 */ export async function fileMergeFallbackIssue(filing, deps = {}) {
  const gh = deps.gh ?? defaultGh;
  const repo = MERGE_FALLBACK_TARGET_REPO;
  const title = mergeFallbackTitle(filing);
  const body = buildMergeFallbackBody(filing, await sourceVisibility(gh, filing.target.repo));
  const log = (message)=>{
    if (deps.logger?.warn) deps.logger.warn(message, {
      repo
    });
    else console.warn(message);
  };
  try {
    const existing = await findOpenFlagIssue(gh, repo, title, deps, log);
    if (existing !== undefined) {
      await gh([
        "issue",
        "comment",
        String(existing.number),
        "--repo",
        repo,
        "--body",
        body
      ]);
      deps.logger?.info?.("Appended a fallback event to its flag issue", {
        repo,
        issueNumber: existing.number
      });
      return {
        ok: true,
        value: {
          issueNumber: existing.number,
          url: existing.url ?? "",
          appended: true
        }
      };
    }
    // The flag is only readable if the label exists. A repo that has never
    // had a fallback has never had the label, so create it on first use —
    // colour and description come from the canonical content-label table.
    const ensure = deps.ensureLabelExists ?? defaultEnsureLabelExists;
    const ensured = await ensure(repo, MERGE_FALLBACK_LABEL);
    if (!ensured.ok) {
      // Said out loud, then pressed on: the label may already exist, and a
      // genuinely missing one fails the create below rather than silently.
      log(`[merge-fallback] could not create the \`${MERGE_FALLBACK_LABEL}\` ` + `label in ${repo}: ${ensured.error.message}. Filing anyway — the ` + "flag matters more than its colour.");
    }
    const created = await gh([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      title,
      "--body",
      body,
      ...guardedLabelArgs([
        BUG_LABEL,
        MERGE_FALLBACK_LABEL
      ], CALLER)
    ]);
    const url = created.trim();
    const parsed = Number(url.split("/").pop());
    const issueNumber = Number.isInteger(parsed) ? parsed : 0;
    if (issueNumber === 0) {
      // The issue exists — `gh` did not fail — but nothing can link to it.
      // A `0` handed back silently would read as a filed, findable flag.
      log(`[merge-fallback] filed the flag in ${repo} but could not read its ` + `number from \`gh issue create\` output (${url || "empty"}). The ` + "issue exists; the caller has no number to link it by.");
    }
    deps.logger?.info?.("Filed a conflict fallback as a VibeCoder failure", {
      repo,
      issueNumber
    });
    return {
      ok: true,
      value: {
        issueNumber,
        url,
        appended: false
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
/**
 * The filer both PR-path fallback routes use, bound to one `gh` (Issue #2310).
 *
 * One definition of the wiring rather than two: the label creation has to be
 * routed through the caller's own `gh` — the default reaches the real CLI — and
 * a second copy of that closure is a second thing to get wrong.
 *
 * @param deps - The caller's `gh`, its logger, and the fleet identity the
 *   dedup match is verified against
 * @returns A filer taking only the filing, for use as an injected seam
 */ export function createFallbackFlagFiler(deps) {
  return (filing)=>fileMergeFallbackIssue(filing, {
      gh: deps.gh,
      ...deps.logger !== undefined ? {
        logger: deps.logger
      } : {},
      ...deps.fleetAuthors !== undefined ? {
        fleetAuthors: deps.fleetAuthors
      } : {},
      ensureLabelExists: (repo, labelName, colour, description)=>defaultEnsureLabelExists(repo, labelName, colour, description, {
          ghCommandFn: deps.gh
        })
    });
}
/**
 * The open, fleet-authored flag issue for this title, if there is one.
 *
 * Unparseable output yields `undefined`, which files a fresh flag: the fail
 * direction is towards a duplicate rather than towards silence.
 */ async function findOpenFlagIssue(gh, repo, title, deps, log) {
  const listed = await gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    // Deliberately not filtered by `--label`: a human who takes the label off
    // a flag issue would otherwise make it invisible here, and the next
    // fallback would file a second flag for the same target. The exact title,
    // the open state and the fleet author are the match.
    "--search",
    `in:title "${title}"`,
    "--json",
    DEDUP_JSON_FIELDS
  ]);
  let rows;
  try {
    rows = JSON.parse(listed || "[]");
    if (!Array.isArray(rows)) throw new Error("the listing is not an array");
  } catch (error) {
    // Said out loud, never swallowed: dedup is off for this event, so the
    // flag is filed again rather than lost.
    log(`[merge-fallback] could not read the dedup listing for ${repo} ` + `"${title}": ${error instanceof Error ? error.message : String(error)}. Filing a fresh flag — a duplicate is recoverable, a lost ` + "fallback record is not.");
    return undefined;
  }
  // Belt: the exact title, and an issue GitHub still reports as open. The
  // `--state open` filter above says the same thing, but the flag redirects
  // an event onto whatever it matches, so the state is re-read from the row
  // rather than assumed from the argument.
  const candidates = rows.filter((row)=>row.title === title && (row.state === undefined || row.state.toUpperCase() === "OPEN"));
  // Braces: and only an issue a fleet account authored.
  const verified = await selectFleetAuthoredMatches(candidates, `merge fallback ${repo} ${title}`, deps, log, "a fresh flag issue is filed — a fallback event must never be posted " + "onto an issue the fleet did not open");
  return verified[0];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9tZXJnZV9mYWxsYmFja19pc3N1ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRoZSBgbWVyZ2UtZmFsbGJhY2tgIHJlY29yZCBldmVyeSBjb25mbGljdCBmYWxsYmFjayBsZWF2ZXMgYmVoaW5kXG4gKiAoSXNzdWUgIzIzMDQsIHBhcnQgb2YgIzIyOTgpLCBmaWxlZCBpbiBWaWJlQ29kZXIgYXMgYSB3b3JrZXIgZmFpbHVyZVxuICogKElzc3VlICM0NDU2KS5cbiAqXG4gKiBBIGZhbGxiYWNrIG1lYW5zIHRoZSB3b3JrZXIgZmFpbGVkIHRvIGZpbmlzaCB0aGUgd29yaywgc28gaXQgaXMgbmV2ZXIgZmlsZWRcbiAqIGFzIGEgbmV3IGlzc3VlIGluIHRoZSByZXBvc2l0b3J5IHRoZSBjb25mbGljdCB3YXMgaW46IHRoYXQgcmVhZCBhcyBhIGZyZXNoXG4gKiB3b3JrIGl0ZW0gaW5zdGVhZCBvZiB0aGUgd29ya2VyIGNvbXBsZXRpbmcgdGhlIG9uZSBpdCBoYWQuIEl0IGlzIGZpbGVkIGluXG4gKiB7QGxpbmsgTUVSR0VfRkFMTEJBQ0tfVEFSR0VUX1JFUE99LCBsYWJlbGxlZCBgYnVnYCwgd2l0aCBvbmUgb3BlbiBpc3N1ZSBwZXJcbiAqIGNhdXNlOyBhIHJlcGVhdCBhcHBlbmRzIGEgY29tbWVudC4gVmliZUNvZGVyIGlzIHB1YmxpYywgc28gYSBwcml2YXRlIHNvdXJjZVxuICogcmVwb3NpdG9yeSBpcyBuZXZlciBuYW1lZCB0aGVyZTogaXRzIHJlcG9zaXRvcnksIGJyYW5jaGVzLCBQUiwgcGF0aHMgYW5kXG4gKiB0aGUgYWdlbnRzJyBmdWxsIHJlcGxpZXMgYXJlIGxlZnQgb3V0LCBhbmQgb25seSB0aGUgaG9zdCwgdGhlIHRpbWluZ3MsIGVhY2hcbiAqIHJ1bidzIGNvbmNsdXNpb24gYW5kIGhvdyBmYXIgYmVoaW5kIHRoZSBicmFuY2ggd2FzIGFyZSByZWNvcmRlZC5cbiAqXG4gKiBUaGUgY29uZmxpY3QgbGFkZGVyIGVuZHMgaW4gYSBmYWxsYmFjazogb24gdGhlIFBSIHBhdGggdGhlIFBSIGlzIGNsb3NlZCBhbmRcbiAqIGl0cyBvcmlnaW5hdGluZyBpc3N1ZSByZS1xdWV1ZWQ7IG9uIHRoZSBtaWxlc3RvbmUgcGF0aCB0aGUgbWVyZ2VkIGNoaWxkcmVuXG4gKiBhcmUgcmV2ZXJ0ZWQgbmV3ZXN0LWZpcnN0IGFuZCByZS1xdWV1ZWQuIEJvdGggd2VyZSBzaWxlbnQuIFRoZSB3b3JrIHdhc1xuICogdW5kb25lLCB0aGUgY29uZmxpY3QgdGhhdCB1bmRpZCBpdCB3YXMgbm90IHdyaXR0ZW4gZG93biBhbnl3aGVyZSBkdXJhYmxlLFxuICogYW5kIHRoZSBuZXh0IGF0dGVtcHQgc3RhcnRlZCBmcm9tIHRoZSBzYW1lIGJsYW5rIHBhZ2Ug4oCUIHNvIHRoZSBzYW1lXG4gKiBjb25mbGljdCBjb3VsZCBiZSB3YWxrZWQgaW50byBhZ2FpbiB3aXRoIG5vdGhpbmcgdG8gbGVhcm4gZnJvbS5cbiAqXG4gKiBUaGlzIG1vZHVsZSBpcyB0aGUgb25lIHBsYWNlIHRoYXQgd3JpdGVzIHRoYXQgcmVjb3JkIGRvd24sIGZvciBib3RoIHBhdGhzLlxuICogSXQga25vd3Mgbm90aGluZyBhYm91dCBlaXRoZXIgY2FsbGVyOiBpdCB0YWtlcyB3aGF0IHRoZSBmYWxsYmFjayBvYnNlcnZlZFxuICogYW5kIGZpbGVzIChvciBhcHBlbmRzIHRvKSBvbmUgaXNzdWUgY2FycnlpbmcgdGhlIGBtZXJnZS1mYWxsYmFja2AgY29udGVudFxuICogbGFiZWwuXG4gKlxuICogKipOb3RoaW5nIGlzIG9taXR0ZWQuKiogRXZlcnkgZmllbGQgcmVuZGVycywgYW5kIGEgZmllbGQgdGhlIGNhbGxlciBjb3VsZFxuICogbm90IHJlY29yZCByZW5kZXJzIGFzIGBub3QgcmVjb3JkZWRgIHJhdGhlciB0aGFuIGRpc2FwcGVhcmluZy4gQSBtaXNzaW5nXG4gKiBzZWN0aW9uIGFuZCBhbiB1bnJlY29yZGVkIG9uZSBsb29rIGlkZW50aWNhbCBvbmNlIHRoZSBib2R5IGlzIHdyaXR0ZW4sIGFuZFxuICogdGhlIHJlYWRlciBjYW5ub3QgdGVsbCBcInRoZSBmbGVldCBkaWQgbm90IG1lYXN1cmUgdGhpc1wiIGZyb20gXCJ0aGUgZmxlZXRcbiAqIG1lYXN1cmVkIG5vdGhpbmcgd29ydGggc2F5aW5nXCIg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIHNpbGVuY2UgdGhpcyBpc3N1ZVxuICogZXhpc3RzIHRvIHJlbW92ZS5cbiAqXG4gKiAqKlRoZSBkZWR1cCBtYXRjaCBpcyBhdXRob3ItdmVyaWZpZWQqKiwgZm9yIHRoZSBzYW1lIHJlYXNvbiBldmVyeVxuICogdGl0bGUta2V5ZWQgZGVkdXAgaW4gdGhlIHdvcmtlciB2ZXJpZmllcyBpdHMgb3duOiB0aGUgbWF0Y2ggaXMga2V5ZWQgb24gYVxuICogdGl0bGUsIGFueW9uZSB3aG8gY2FuIG9wZW4gYW4gaXNzdWUgY2hvb3NlcyBhIHRpdGxlLCBhbmQgYW4gdW52ZXJpZmllZCBtYXRjaFxuICogZG9lcyB0d28gaGFybWZ1bCB0aGluZ3MgYXQgb25jZSDigJQgaXQgc3VwcHJlc3NlcyB0aGUgZmxhZywgYW5kIGl0IHJlZGlyZWN0cyB0aGVcbiAqIGZsYWcncyBjb250ZW50cyBvbnRvIGFuIGlzc3VlIHNvbWVib2R5IGVsc2Ugb3BlbmVkLiBUaGUgbWF0Y2ggbXVzdCBhbHNvIGJlXG4gKiAqKm9wZW4qKjogYSBjbG9zZWQgZmxhZyBtZWFucyBhIGh1bWFuIGhhcyBmaW5pc2hlZCB3aXRoIHRoYXQgUFIgb3IgYnJhbmNoLFxuICogYW5kIGEgZnJlc2ggZmFsbGJhY2sgZGVzZXJ2ZXMgaXRzIG93biBpc3N1ZSByYXRoZXIgdGhhbiByZW9wZW5pbmcgYVxuICogY29udmVyc2F0aW9uIHRoYXQgZW5kZWQuXG4gKlxuICogKipUaGUgZmFpbCBkaXJlY3Rpb24gaXMgdG93YXJkcyBmaWxpbmcuKiogQW4gdW5wYXJzZWFibGUgbGlzdGluZywgYW5cbiAqIHVucmVzb2x2YWJsZSBmbGVldCBpZGVudGl0eSBvciBhIGxhYmVsIHRoYXQgY291bGQgbm90IGJlIGNyZWF0ZWQgYWxsIGVuZCBpblxuICogYSBmaWxlZCBpc3N1ZS4gQSBkdXBsaWNhdGUgZmxhZyBpcyBub2lzZSBhIGh1bWFuIGNsb3NlcyBpbiBhIG1vbWVudDsgYVxuICogc3VwcHJlc3NlZCBvbmUgaXMgYSBmYWxsYmFjayBub2JvZHkgZXZlciBoZWFycyBhYm91dC5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgTG9nZ2VyLCBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7XG4gIEFMRVJUX0RFRFVQX1RJVExFX0pTT05fRklFTERTLFxuICB0eXBlIEFsZXJ0RGVkdXBBdXRob3JPcHRpb25zLFxuICB0eXBlIEFsZXJ0RGVkdXBSb3csXG4gIHNlbGVjdEZsZWV0QXV0aG9yZWRNYXRjaGVzLFxufSBmcm9tIFwiLi9hbGVydF9kZWR1cF9hdXRob3JzLnRzXCI7XG5pbXBvcnQgeyBzYW5pdGlzZUlzc3VlVGV4dCB9IGZyb20gXCIuL2NvbmZsaWN0X2ludGVudF9jb250ZXh0LnRzXCI7XG5pbXBvcnQgeyBzcGF3bkdoIH0gZnJvbSBcIi4vZ2hfc3Bhd24udHNcIjtcbmltcG9ydCB7IGd1YXJkZWRMYWJlbEFyZ3MgfSBmcm9tIFwiLi9ndWFyZGVkX2lzc3VlX2xhYmVscy50c1wiO1xuaW1wb3J0IHsgZW5zdXJlTGFiZWxFeGlzdHMgYXMgZGVmYXVsdEVuc3VyZUxhYmVsRXhpc3RzIH0gZnJvbSBcIi4vbGFiZWxfb3BlcmF0aW9ucy50c1wiO1xuXG4vKiogQ29udGVudCBsYWJlbCBtYXJraW5nIGFuIGlzc3VlIGZpbGVkIGJ5IGEgY29uZmxpY3QgZmFsbGJhY2suICovXG5leHBvcnQgY29uc3QgTUVSR0VfRkFMTEJBQ0tfTEFCRUwgPSBcIm1lcmdlLWZhbGxiYWNrXCI7XG5cbi8qKlxuICogV2hlcmUgZXZlcnkgZmFsbGJhY2sgaXMgZmlsZWQgKElzc3VlICM0NDU2KTogYSBmYWxsYmFjayBpcyB0aGUgd29ya2VyJ3NcbiAqIGZhaWx1cmUsIHdoaWNoZXZlciBtb25pdG9yZWQgcmVwb3NpdG9yeSB0aGUgY29uZmxpY3Qgd2FzIGluLlxuICovXG5leHBvcnQgY29uc3QgTUVSR0VfRkFMTEJBQ0tfVEFSR0VUX1JFUE8gPSBcInN0U29mdHdhcmVBVS9WaWJlQ29kZXJcIjtcblxuLyoqIFdvcmtlci1mYXVsdCBsYWJlbCBldmVyeSBmYWxsYmFjayByZWNvcmQgY2Fycmllcy4gKi9cbmNvbnN0IEJVR19MQUJFTCA9IFwiYnVnXCI7XG5cbi8qKiBUaXRsZSBhbmQgY2F1c2Ugd2hlbiBubyBjb25jbHVzaW9uIG5hbWVzIG9uZS4gKi9cbmNvbnN0IFVOQ0xBU1NJRklFRF9DQVVTRSA9IFwidW5jbGFzc2lmaWVkXCI7XG5cbi8qKiBMb25nZXN0IGNhdXNlIGtlcHQgaW4gYSB0aXRsZS4gKi9cbmNvbnN0IE1BWF9DQVVTRV9DSEFSUyA9IDEwMDtcblxuLyoqIFdoZXRoZXIgdGhlIHNvdXJjZSByZXBvc2l0b3J5IG1heSBiZSBuYW1lZCBpbiBWaWJlQ29kZXIuICovXG5leHBvcnQgdHlwZSBTb3VyY2VWaXNpYmlsaXR5ID0gXCJwdWJsaWNcIiB8IFwicHJpdmF0ZVwiO1xuXG4vKiogQ2FsbHNpdGUgcmVjb3JkZWQgaW4gdGhlIGxhYmVsIGd1YXJkJ3MgYXVkaXQgbGluZS4gKi9cbmNvbnN0IENBTExFUiA9IFwid29ya2VyL2Rlbm8vbGliL21lcmdlX2ZhbGxiYWNrX2lzc3VlLnRzXCI7XG5cbi8qKlxuICogUGVyLXJ1biBhbmFseXNpcyBjYXAsIGluIGNoYXJhY3RlcnMuXG4gKlxuICogQSBHaXRIdWIgaXNzdWUgYm9keSBpcyBjYXBwZWQgYXQgNjUsNTM2IGNoYXJhY3RlcnMsIHNvIHR3byB1bmJvdW5kZWQgYWdlbnRcbiAqIHJlcGxpZXMgY2FuIG1ha2UgdGhlIGZpbGluZyBmYWlsIG91dHJpZ2h0IOKAlCB0aGUgZmxhZyBsb3N0IHRvIHRoZSB2ZXJ5IHRoaW5nXG4gKiBpdCByZWNvcmRzLiBUcnVuY2F0aW9uIGlzIGFubm91bmNlZCBpbiB0aGUgYm9keSByYXRoZXIgdGhhbiBhcHBsaWVkXG4gKiBxdWlldGx5LlxuICovXG5jb25zdCBNQVhfQU5BTFlTSVNfQ0hBUlMgPSAyMF8wMDA7XG5cbi8qKiBSZW5kZXJlZCBpbiBwbGFjZSBvZiBhbnkgZmllbGQgdGhlIGZhbGxiYWNrIGNvdWxkIG5vdCByZWNvcmQuICovXG5jb25zdCBOT1RfUkVDT1JERUQgPSBcIm5vdCByZWNvcmRlZFwiO1xuXG4vKiogVGhlIFBSIG9yIG1pbGVzdG9uZSBicmFuY2ggYSBmYWxsYmFjayByYW4gb24uICovXG5leHBvcnQgdHlwZSBNZXJnZUZhbGxiYWNrVGFyZ2V0ID1cbiAgfCB7XG4gICAga2luZDogXCJwclwiO1xuICAgIC8qKiBSZXBvc2l0b3J5IGluIGBvd25lci9yZXBvYCBmb3JtIOKAlCB0aGUgZmxhZyBpcyBmaWxlZCBoZXJlLiAqL1xuICAgIHJlcG86IHN0cmluZztcbiAgICBwck51bWJlcjogbnVtYmVyO1xuICAgIGhlYWRCcmFuY2g/OiBzdHJpbmc7XG4gICAgYmFzZUJyYW5jaD86IHN0cmluZztcbiAgfVxuICB8IHtcbiAgICBraW5kOiBcIm1pbGVzdG9uZVwiO1xuICAgIHJlcG86IHN0cmluZztcbiAgICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZztcbiAgICBkZWZhdWx0QnJhbmNoPzogc3RyaW5nO1xuICB9O1xuXG4vKiogT25lIHN0YWdlIG9mIG9uZSBhdHRlbXB0LCBhbmQgdGhlIHdhbGwtY2xvY2sgc2Vjb25kcyBpdCB0b29rLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNZXJnZUZhbGxiYWNrU3RhZ2VUaW1pbmcge1xuICAvKiogU3RhZ2UgbmFtZSDigJQgYGRlZXBlbmAsIGBydWxlc2AsIGBjb250ZXh0YCwgYGFnZW50YCwgYGdhdGVgLCBgcHVzaGAuICovXG4gIHN0YWdlOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBXaG9sZSBzZWNvbmRzIHRoZSBzdGFnZSB0b29rLCBvciBgbnVsbGAgZm9yIGEgc3RhZ2UgdGhhdCBzdGFydGVkIGFuZFxuICAgKiBuZXZlciBzdG9wcGVkIChJc3N1ZSAjMjMxMSkg4oCUIHJlbmRlcmVkIGB1bmZpbmlzaGVkYCwgZXhhY3RseSBhc1xuICAgKiBgY29uZmxpY3Rfc3RhZ2VfdGltZXIudHNgIHJlcG9ydHMgaXQgKElzc3VlICMyMzA4KS4gQW4gYXR0ZW1wdCB0aGF0IGRpZWRcbiAgICogaW5zaWRlIHRoZSBhZ2VudCBpcyB0aGUgY2FzZSB0aGVzZSB0aW1pbmdzIGV4aXN0IHRvIHNob3csIHNvIGl0IG11c3Qgbm90XG4gICAqIHJlbmRlciBhcyBhIGR1cmF0aW9uLlxuICAgKi9cbiAgc2Vjb25kczogbnVtYmVyIHwgbnVsbDtcbn1cblxuLyoqIE9uZSBwYXRoIGFuIGFiYW5kb25lZCBQUiBjaGFuZ2VkLCBhcyBgZ2ggcHIgdmlldyAtLWpzb24gZmlsZXNgIGxpc3RzIGl0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBNZXJnZUZhbGxiYWNrRGlmZkZpbGUge1xuICBwYXRoOiBzdHJpbmc7XG4gIGFkZGl0aW9uczogbnVtYmVyO1xuICBkZWxldGlvbnM6IG51bWJlcjtcbn1cblxuLyoqIFdoYXQgb25lIGFnZW50IHJ1biBkaWQsIGFuZCB3aGF0IGl0IGNvc3QuICovXG5leHBvcnQgaW50ZXJmYWNlIE1lcmdlRmFsbGJhY2tSdW4ge1xuICAvKiogMS1iYXNlZCBydW4gbnVtYmVyLCBhcyB0aGUgYXR0ZW1wdCBsZWRnZXIgY291bnRzIGl0LiAqL1xuICBydW46IG51bWJlcjtcbiAgLyoqIFRoZSBhZ2VudCdzIG93biByZXBseSB0ZXh0LiBTYW5pdGlzZWQgYmVmb3JlIGl0IGlzIHJlbmRlcmVkLiAqL1xuICBhbmFseXNpcz86IHN0cmluZztcbiAgLyoqIFBlci1zdGFnZSB3YWxsLWNsb2NrIHRpbWluZ3MgZm9yIHRoaXMgcnVuLiAqL1xuICB0aW1pbmdzPzogcmVhZG9ubHkgTWVyZ2VGYWxsYmFja1N0YWdlVGltaW5nW107XG4gIC8qKiBIb3N0IHRoYXQgcmFuIGl0LiAqL1xuICBob3N0Pzogc3RyaW5nO1xufVxuXG4vKiogT25lIGZhbGxiYWNrIGV2ZW50LCBhcyB0aGUgZmxhZyBpc3N1ZSByZWNvcmRzIGl0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBNZXJnZUZhbGxiYWNrRXZlbnQge1xuICB0YXJnZXQ6IE1lcmdlRmFsbGJhY2tUYXJnZXQ7XG4gIC8qKiBGaWxlcyBzdGlsbCBjb25mbGljdGVkIHdoZW4gdGhlIGZhbGxiYWNrIHdhcyByZWFjaGVkLiAqL1xuICBjb25mbGljdGVkRmlsZXM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEJvdGggYWdlbnQgcnVucywgaW4gb3JkZXIuICovXG4gIHJ1bnM/OiByZWFkb25seSBNZXJnZUZhbGxiYWNrUnVuW107XG4gIC8qKiBDb21taXRzIHRoZSBicmFuY2ggd2FzIGJlaGluZCBpdHMgYmFzZS4gKi9cbiAgYmVoaW5kQnk/OiBudW1iZXI7XG4gIC8qKiBXaGVuIGl0IGZpcnN0IHdlbnQgYmVoaW5kIOKAlCBhbiBJU08gdGltZXN0YW1wLCBhcyB0aGUgY2FsbGVyIHJlYWQgaXQuICovXG4gIGJlaGluZFNpbmNlPzogc3RyaW5nO1xuICAvKiogV2hhdCB0aGUgZmFsbGJhY2sgY2xvc2VkIG9yIHJldmVydGVkLiAqL1xuICBmYWxsYmFja0FjdGlvbj86IHN0cmluZztcbiAgLyoqXG4gICAqIFdoYXQgYSBjb25mbGljdGluZyBQUiB3aXRoIG5vIG9yaWdpbmF0aW5nIGlzc3VlIGNoYW5nZWQgKElzc3VlICMyMzEwKSxcbiAgICogcmVuZGVyZWQgb25seSBmb3IgYSBwdWJsaWMgc291cmNlLiBBYnNlbnQgbWVhbnMgdGhlIGZhbGxiYWNrIGRpZCBub3QgcmVhZCBvbmUg4oCUIGEgbWlsZXN0b25lIGJyYW5jaCBoYXNcbiAgICogbm8gUFIgZGlmZiwgYW5kIHRoZSByb3V0ZSB0aGF0IHJlLXF1ZXVlcyBhbiBvcmlnaW5hdGluZyBpc3N1ZSBkb2VzIG5vdCBuZWVkXG4gICAqIG9uZSDigJQgYW5kIHRoZSBzZWN0aW9uIGlzIHRoZW4gbm90IHJlbmRlcmVkIGF0IGFsbCwgcmF0aGVyIHRoYW4gY2xhaW1pbmcgYVxuICAgKiByZWFkIHRoYXQgd2FzIG5ldmVyIGF0dGVtcHRlZC5cbiAgICovXG4gIGRpZmZTdW1tYXJ5PzogcmVhZG9ubHkgTWVyZ2VGYWxsYmFja0RpZmZGaWxlW107XG4gIC8qKiBQYXRocyBiZXlvbmQgdGhlIGNhbGxlcidzIGNhcCwgY291bnRlZCByYXRoZXIgdGhhbiBkcm9wcGVkIGluIHNpbGVuY2UuICovXG4gIGRpZmZTdW1tYXJ5T21pdHRlZD86IG51bWJlcjtcbiAgLyoqXG4gICAqIFdoeSB0aGUgZmFsbGJhY2sgd2FzIHJlYWNoZWQsIHdoZW4gdGhlIGNhbGxlciBrbm93cyBpdC4gQWJzZW50LCBpdCBpcyByZWFkXG4gICAqIGZyb20gdGhlIGxhc3QgcnVuJ3MgY29uY2x1c2lvbiBsaW5lICh7QGxpbmsgbWVyZ2VGYWxsYmFja0NhdXNlfSkuXG4gICAqL1xuICBjYXVzZT86IHN0cmluZztcbn1cblxuLyoqIFdoYXQgYSBjYWxsZXIgaGFuZHMge0BsaW5rIGZpbGVNZXJnZUZhbGxiYWNrSXNzdWV9LiAqL1xuZXhwb3J0IHR5cGUgTWVyZ2VGYWxsYmFja0ZpbGluZyA9IE1lcmdlRmFsbGJhY2tFdmVudDtcblxuLyoqIFdoYXQge0BsaW5rIGZpbGVNZXJnZUZhbGxiYWNrSXNzdWV9IGRpZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTWVyZ2VGYWxsYmFja091dGNvbWUge1xuICBpc3N1ZU51bWJlcjogbnVtYmVyO1xuICAvKiogVVJMIG9mIHRoZSBmbGFnIGlzc3VlLCBvciBcIlwiIHdoZW4gYGdoYCBkaWQgbm90IHJlcG9ydCBvbmUuICovXG4gIHVybDogc3RyaW5nO1xuICAvKiogVHJ1ZSB3aGVuIHRoZSBldmVudCB3YXMgYXBwZW5kZWQgdG8gYW4gZXhpc3RpbmcgZmxhZyBpc3N1ZS4gKi9cbiAgYXBwZW5kZWQ6IGJvb2xlYW47XG59XG5cbi8qKiBJbmplY3RlZCBzZWFtcyBzbyB0aGUgd2hvbGUgcGF0aCBpcyB0ZXN0YWJsZSB3aXRob3V0IEdpdEh1Yi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTWVyZ2VGYWxsYmFja0lzc3VlRGVwcyBleHRlbmRzIEFsZXJ0RGVkdXBBdXRob3JPcHRpb25zIHtcbiAgLyoqIFJ1bnMgYGdoYCwgcmV0dXJuaW5nIHN0ZG91dDsgdGhyb3dzIG9uIGZhaWx1cmUuICovXG4gIGdoPzogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz47XG4gIC8qKiBMYWJlbCBjcmVhdGlvbiBvdmVycmlkZSAodGVzdHMpLiBQcm9kdWN0aW9uOiBgZW5zdXJlTGFiZWxFeGlzdHNgLiAqL1xuICBlbnN1cmVMYWJlbEV4aXN0cz86IChcbiAgICByZXBvOiBzdHJpbmcsXG4gICAgbGFiZWxOYW1lOiBzdHJpbmcsXG4gICAgY29sb3VyPzogc3RyaW5nLFxuICAgIGRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICApID0+IFByb21pc2U8UmVzdWx0PHZvaWQ+PjtcbiAgbG9nZ2VyPzogTG9nZ2VyO1xufVxuXG5hc3luYyBmdW5jdGlvbiBkZWZhdWx0R2goYXJnczogc3RyaW5nW10pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBzcGF3bkdoKGFyZ3MpO1xuICBpZiAoIXJlc3VsdC5zdWNjZXNzKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGdoICR7YXJnc1swXX0gJHthcmdzWzFdID8/IFwiXCJ9IGZhaWxlZCAoZXhpdCAke3Jlc3VsdC5jb2RlfSk6ICR7XG4gICAgICAgIHJlc3VsdC5zdGRlcnIudHJpbSgpIHx8IHJlc3VsdC5zdGRvdXQudHJpbSgpXG4gICAgICB9YCxcbiAgICApO1xuICB9XG4gIHJldHVybiByZXN1bHQuc3Rkb3V0O1xufVxuXG4vKiogVGhlIG5hbWVzIGEgcHJpdmF0ZSBzb3VyY2Ugd291bGQgYmUgcmVjb2duaXNlZCBieSwgbG9uZ2VzdCBmaXJzdC4gKi9cbmZ1bmN0aW9uIHNvdXJjZU5hbWVzKHRhcmdldDogTWVyZ2VGYWxsYmFja1RhcmdldCk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbmFtZXMgPSBbXG4gICAgdGFyZ2V0LnJlcG8sXG4gICAgdGFyZ2V0LnJlcG8uc3BsaXQoXCIvXCIpLnBvcCgpID8/IFwiXCIsXG4gICAgLi4uKHRhcmdldC5raW5kID09PSBcInByXCJcbiAgICAgID8gW3RhcmdldC5oZWFkQnJhbmNoID8/IFwiXCIsIHRhcmdldC5iYXNlQnJhbmNoID8/IFwiXCJdXG4gICAgICA6IFt0YXJnZXQubWlsZXN0b25lQnJhbmNoLCB0YXJnZXQuZGVmYXVsdEJyYW5jaCA/PyBcIlwiXSksXG4gIF07XG4gIHJldHVybiBbLi4ubmV3IFNldChuYW1lcy5maWx0ZXIoKG5hbWUpID0+IG5hbWUubGVuZ3RoID4gMCkpXVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmxlbmd0aCAtIGEubGVuZ3RoKTtcbn1cblxuLyoqXG4gKiBUZXh0IHdpdGggbm90aGluZyB0aGF0IG5hbWVzIGEgcHJpdmF0ZSBzb3VyY2U6IGl0cyByZXBvc2l0b3J5IGFuZCBicmFuY2hcbiAqIG5hbWVzLCBhbnkgcGF0aCBvciBzbGFzaC1qb2luZWQgbmFtZSwgYW5kIGFueSBgI05gIOKAlCBhIGJhcmUgbnVtYmVyIGluXG4gKiBWaWJlQ29kZXIgbGlua3MgdG8gYW4gdW5yZWxhdGVkIFZpYmVDb2RlciBpc3N1ZS5cbiAqL1xuZnVuY3Rpb24gc2NydWJQcml2YXRlKHRleHQ6IHN0cmluZywgdGFyZ2V0OiBNZXJnZUZhbGxiYWNrVGFyZ2V0KTogc3RyaW5nIHtcbiAgbGV0IHNjcnViYmVkID0gdGV4dDtcbiAgZm9yIChjb25zdCBuYW1lIG9mIHNvdXJjZU5hbWVzKHRhcmdldCkpIHtcbiAgICBzY3J1YmJlZCA9IHJlcGxhY2VXb3JkKHNjcnViYmVkLCBuYW1lLCBcIjxzb3VyY2U+XCIpO1xuICB9XG4gIHJldHVybiBzY3J1YmJlZFxuICAgIC5yZXBsYWNlKC9bXlxcc2AnXCIoKSxdKlxcL1teXFxzYCdcIigpLF0qL2csIFwiPHBhdGg+XCIpXG4gICAgLnJlcGxhY2UoLyMoXFxkKykvZywgXCJudW1iZXIgJDFcIik7XG59XG5cbi8qKiBBIGNoYXJhY3RlciB0aGF0IGNvbnRpbnVlcyBhIG5hbWUsIHNvIGEgbWF0Y2ggaW5zaWRlIGEgbG9uZ2VyIG9uZSBpcyBsZWZ0LiAqL1xuZnVuY3Rpb24gaXNOYW1lQ2hhcihjaGFyOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgcmV0dXJuIGNoYXIgIT09IHVuZGVmaW5lZCAmJiAvW1xcdy8tXS8udGVzdChjaGFyKTtcbn1cblxuLyoqXG4gKiBFdmVyeSB3aG9sZS13b3JkLCBjYXNlLWluc2Vuc2l0aXZlIG9jY3VycmVuY2Ugb2YgYHdvcmRgIHJlcGxhY2VkLiBBIHBsYWluXG4gKiBzY2FuIHJhdGhlciB0aGFuIGEgcmVndWxhciBleHByZXNzaW9uIGJ1aWx0IGZyb20gdGhlIG5hbWUsIHNvIG5vIG5hbWUgY2FuXG4gKiBjaGFuZ2UgdGhlIHBhdHRlcm4uXG4gKi9cbmZ1bmN0aW9uIHJlcGxhY2VXb3JkKHRleHQ6IHN0cmluZywgd29yZDogc3RyaW5nLCByZXBsYWNlbWVudDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgaGF5c3RhY2sgPSB0ZXh0LnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IG5lZWRsZSA9IHdvcmQudG9Mb3dlckNhc2UoKTtcbiAgbGV0IG91dCA9IFwiXCI7XG4gIGxldCBmcm9tID0gMDtcbiAgZm9yIChcbiAgICBsZXQgYXQgPSBoYXlzdGFjay5pbmRleE9mKG5lZWRsZSk7XG4gICAgYXQgIT09IC0xO1xuICAgIGF0ID0gaGF5c3RhY2suaW5kZXhPZihuZWVkbGUsIGF0ICsgMSlcbiAgKSB7XG4gICAgaWYgKGF0IDwgZnJvbSkgY29udGludWU7XG4gICAgY29uc3QgZW5kID0gYXQgKyBuZWVkbGUubGVuZ3RoO1xuICAgIGlmIChpc05hbWVDaGFyKHRleHRbYXQgLSAxXSkgfHwgaXNOYW1lQ2hhcih0ZXh0W2VuZF0pKSBjb250aW51ZTtcbiAgICBvdXQgKz0gdGV4dC5zbGljZShmcm9tLCBhdCkgKyByZXBsYWNlbWVudDtcbiAgICBmcm9tID0gZW5kO1xuICB9XG4gIHJldHVybiBvdXQgKyB0ZXh0LnNsaWNlKGZyb20pO1xufVxuXG4vKiogYCNOYCBxdWFsaWZpZWQgYXMgYG93bmVyL3JlcG8jTmAsIHNvIGl0IG5ldmVyIGxpbmtzIHRvIGEgVmliZUNvZGVyIGlzc3VlLiAqL1xuZnVuY3Rpb24gcXVhbGlmeVJlZmVyZW5jZXModGV4dDogc3RyaW5nLCByZXBvOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKC8oXnxbXlxcdy8uLV0pIyhcXGQrKVxcYi9nLCBgJDEke3JlcG99IyQyYCk7XG59XG5cbi8qKiBPbmUgY29uY2x1c2lvbiBsaW5lLCBhcyB0aGUgbWlsZXN0b25lIGxlZGdlciB3cml0ZXMgaXQuICovXG5jb25zdCBDT05DTFVTSU9OX1JFID0gL15Db25jbHVkZWQgYFteYF0rYCBhdCBcXFMrOiAoLispJC9tO1xuXG4vKiogQSByZWZ1c2FsIHRoYXQgY2xpbWJlZCwgd3JhcHBpbmcgdGhlIHJlYXNvbiBpdCB3YXMgcmVmdXNlZCBmb3IuICovXG5jb25zdCBSRUZVU0FMX0NMSU1CX1JFID0gL15yZWZ1c2VkIFxcZCsgY3ljbGVzPyBpbiBhIHJvdyBcXCgoLispXFwpIOKAlCBjbGltYmluZy87XG5cbi8qKiBUaGUgY29uY2x1c2lvbiBsaW5lIG9mIG9uZSBydW4sIHdoZW4gaXQgd3JvdGUgb25lLiAqL1xuZnVuY3Rpb24gY29uY2x1c2lvbkxpbmUocnVuOiBNZXJnZUZhbGxiYWNrUnVuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgbWF0Y2ggPSBDT05DTFVTSU9OX1JFLmV4ZWMocnVuLmFuYWx5c2lzID8/IFwiXCIpO1xuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFswXSA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBXaHkgdGhlIGZhbGxiYWNrIHdhcyByZWFjaGVkIOKAlCB0aGUgZGVkdXBsaWNhdGlvbiBrZXkgKElzc3VlICM0NDU2KS5cbiAqXG4gKiBUaGUgY2FsbGVyJ3MgZXhwbGljaXQgY2F1c2UsIGVsc2UgdGhlIGxhc3QgcnVuJ3MgY29uY2x1c2lvbiB3aXRoIGEgcmVmdXNhbFxuICogY2xpbWIgdW53cmFwcGVkIHRvIHRoZSByZWFzb24gdGhhdCB3YXMgcmVmdXNlZCBhbmQgYW55dGhpbmcgYWZ0ZXIgdGhlIGZpcnN0XG4gKiBjb2xvbiBkcm9wcGVkLCBzbyBtZWFzdXJlbWVudHMgdGhhdCB2YXJ5IHBlciBldmVudCBjYW5ub3Qgc3BsaXQgb25lIGNhdXNlXG4gKiBpbnRvIG1hbnkgaXNzdWVzLiBOYW1lcyBvZiB0aGUgc291cmNlIGFyZSBzY3J1YmJlZCB3aGF0ZXZlciBpdHNcbiAqIHZpc2liaWxpdHksIHNvIG9uZSBjYXVzZSBoYXMgb25lIHRpdGxlIGFjcm9zcyBldmVyeSByZXBvc2l0b3J5LlxuICpcbiAqIEBwYXJhbSBldmVudCAtIFRoZSBmYWxsYmFjayBldmVudFxuICogQHJldHVybnMgQSBzaG9ydCwgcmVwb3NpdG9yeS1hZ25vc3RpYyBjYXVzZVxuICovXG5leHBvcnQgZnVuY3Rpb24gbWVyZ2VGYWxsYmFja0NhdXNlKGV2ZW50OiBNZXJnZUZhbGxiYWNrRXZlbnQpOiBzdHJpbmcge1xuICBsZXQgY2F1c2UgPSBldmVudC5jYXVzZT8udHJpbSgpID8/IFwiXCI7XG4gIGlmIChjYXVzZSA9PT0gXCJcIikge1xuICAgIGNvbnN0IGxhc3QgPSBldmVudC5ydW5zPy5hdCgtMSk7XG4gICAgY29uc3QgbWF0Y2ggPSBDT05DTFVTSU9OX1JFLmV4ZWMobGFzdD8uYW5hbHlzaXMgPz8gXCJcIik7XG4gICAgaWYgKG1hdGNoKSB7XG4gICAgICBjb25zdCByZWFzb24gPSBtYXRjaFsxXSEudHJpbSgpO1xuICAgICAgY29uc3QgY2xpbWJlZCA9IFJFRlVTQUxfQ0xJTUJfUkUuZXhlYyhyZWFzb24pO1xuICAgICAgY2F1c2UgPSAoY2xpbWJlZCA/IGNsaW1iZWRbMV0hIDogcmVhc29uKS5zcGxpdChcIjpcIilbMF0hLnRyaW0oKTtcbiAgICB9XG4gIH1cbiAgY2F1c2UgPSBzY3J1YlByaXZhdGUoc2FuaXRpc2VJc3N1ZVRleHQoY2F1c2UpLCBldmVudC50YXJnZXQpXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpXG4gICAgLnRyaW0oKVxuICAgIC5zbGljZSgwLCBNQVhfQ0FVU0VfQ0hBUlMpO1xuICByZXR1cm4gY2F1c2UgPT09IFwiXCIgPyBVTkNMQVNTSUZJRURfQ0FVU0UgOiBjYXVzZTtcbn1cblxuLyoqXG4gKiBUaXRsZSBvZiB0aGUgZmFsbGJhY2sgcmVjb3JkIOKAlCBhbHNvIGl0cyBkZWR1cGxpY2F0aW9uIGtleTogb25lIG9wZW4gaXNzdWVcbiAqIHBlciBjYXVzZSwgd2hpY2hldmVyIHJlcG9zaXRvcnkgb3IgYnJhbmNoIGl0IGhhcHBlbmVkIG9uIChJc3N1ZSAjNDQ1NikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZUZhbGxiYWNrVGl0bGUoZXZlbnQ6IE1lcmdlRmFsbGJhY2tFdmVudCk6IHN0cmluZyB7XG4gIHJldHVybiBgTWVyZ2UgZmFsbGJhY2s6ICR7bWVyZ2VGYWxsYmFja0NhdXNlKGV2ZW50KX1gO1xufVxuXG4vKipcbiAqIE1hcmtlciB0eWluZyBhIHJlY29yZCB0byBpdHMgY2F1c2UuXG4gKlxuICogQ2Fub25pY2FsIGB2aWJlLSpgIGdyYW1tYXIg4oCUIGEgYmFyZSBwcmVmaXggYW5kIGBrZXk9XCJ2YWx1ZVwiYCBhdHRyaWJ1dGVzXG4gKiAoSXNzdWUgIzg0MikuIFF1b3RlcyBhcmUgc3RyaXBwZWQgc28gYSBjYXVzZSBjYW4gbmV2ZXIgY2xvc2UgdGhlIGF0dHJpYnV0ZVxuICogZWFybHksIGFuZCBubyBzb3VyY2UgcmVwb3NpdG9yeSBpcyBuYW1lZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1lcmdlRmFsbGJhY2tNYXJrZXIoZXZlbnQ6IE1lcmdlRmFsbGJhY2tFdmVudCk6IHN0cmluZyB7XG4gIGNvbnN0IGNhdXNlID0gbWVyZ2VGYWxsYmFja0NhdXNlKGV2ZW50KS5yZXBsYWNlQWxsKCdcIicsIFwiXCIpO1xuICByZXR1cm4gYDwhLS0gdmliZS1tZXJnZS1mYWxsYmFjayBjYXVzZT1cIiR7Y2F1c2V9XCIgLS0+YDtcbn1cblxuLyoqIE9uZSBgLSAqKkxhYmVsKio6IHZhbHVlYCBsaW5lLCBzYXlpbmcgc28gd2hlbiB0aGVyZSBpcyBubyB2YWx1ZS4gKi9cbmZ1bmN0aW9uIGZpZWxkKGxhYmVsOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcgfCBudW1iZXIgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICBjb25zdCByZW5kZXJlZCA9IHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IFwiXCJcbiAgICA/IE5PVF9SRUNPUkRFRFxuICAgIDogc2FuaXRpc2VJc3N1ZVRleHQoU3RyaW5nKHZhbHVlKSk7XG4gIHJldHVybiBgLSAqKiR7bGFiZWx9Kio6ICR7cmVuZGVyZWR9YDtcbn1cblxuLyoqXG4gKiBGZW5jZSBhIGJsb2NrIG9mIGFnZW50IHRleHQgd2l0aG91dCBsZXR0aW5nIGl0IGVzY2FwZSB0aGUgZmVuY2UuXG4gKlxuICogVGhlIGFuYWx5c2lzIGlzIHRoZSBhZ2VudCdzIG93biB3b3JkcyBhbmQgbWF5IGNvbnRhaW4gYSBmZW5jZWQgYmxvY2sgb2ZcbiAqIGl0cyBvd24sIHNvIHRoZSBmZW5jZSBpcyBvbmUgYmFja3RpY2sgbG9uZ2VyIHRoYW4gdGhlIGxvbmdlc3QgcnVuIGluc2lkZVxuICogaXQg4oCUIHRoZSBDb21tb25NYXJrIHJ1bGUsIGFwcGxpZWQgZGV0ZXJtaW5pc3RpY2FsbHkgcmF0aGVyIHRoYW4gaG9waW5nLlxuICovXG5mdW5jdGlvbiBmZW5jZUFuYWx5c2lzKHRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbG9uZ2VzdFJ1biA9IE1hdGgubWF4KFxuICAgIDAsXG4gICAgLi4uWy4uLnRleHQubWF0Y2hBbGwoL2ArL2cpXS5tYXAoKG1hdGNoKSA9PiBtYXRjaFswXS5sZW5ndGgpLFxuICApO1xuICBjb25zdCBmZW5jZSA9IFwiYFwiLnJlcGVhdChNYXRoLm1heCgzLCBsb25nZXN0UnVuICsgMSkpO1xuICByZXR1cm4gW2ZlbmNlLCB0ZXh0LCBmZW5jZV07XG59XG5cbi8qKiBUaGUgYW5hbHlzaXMsIHNhbml0aXNlZCwgcXVhbGlmaWVkIGJ5IHJlcG8gYW5kIGNhcHBlZCwgb3IgYG5vdCByZWNvcmRlZGAuICovXG5mdW5jdGlvbiByZW5kZXJBbmFseXNpcyhhbmFseXNpczogc3RyaW5nIHwgdW5kZWZpbmVkLCByZXBvOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHRleHQgPSBhbmFseXNpcyA9PT0gdW5kZWZpbmVkXG4gICAgPyBcIlwiXG4gICAgOiBxdWFsaWZ5UmVmZXJlbmNlcyhzYW5pdGlzZUlzc3VlVGV4dChhbmFseXNpcyksIHJlcG8pLnRyaW0oKTtcbiAgaWYgKHRleHQubGVuZ3RoID09PSAwKSByZXR1cm4gW2AtICoqQW5hbHlzaXMqKjogJHtOT1RfUkVDT1JERUR9YF07XG5cbiAgbGV0IGNhcHBlZCA9IHRleHQubGVuZ3RoID4gTUFYX0FOQUxZU0lTX0NIQVJTXG4gICAgPyB0ZXh0LnNsaWNlKDAsIE1BWF9BTkFMWVNJU19DSEFSUylcbiAgICA6IHRleHQ7XG4gIC8vIE5ldmVyIGN1dCB0aHJvdWdoIGEgc3Vycm9nYXRlIHBhaXI6IGhhbGYgYW4gZW1vamkgcmVuZGVycyBhcyBVK0ZGRkQgYW5kXG4gIC8vIG1ha2VzIHRoZSB0cnVuY2F0aW9uIGxvb2sgbGlrZSBjb3JydXB0aW9uIHJhdGhlciB0aGFuIGEgYm91bmQuXG4gIGNvbnN0IGxhc3RVbml0ID0gY2FwcGVkLmNoYXJDb2RlQXQoY2FwcGVkLmxlbmd0aCAtIDEpO1xuICBpZiAobGFzdFVuaXQgPj0gMHhkODAwICYmIGxhc3RVbml0IDw9IDB4ZGJmZikgY2FwcGVkID0gY2FwcGVkLnNsaWNlKDAsIC0xKTtcbiAgY29uc3QgZHJvcHBlZCA9IHRleHQubGVuZ3RoIC0gY2FwcGVkLmxlbmd0aDtcbiAgcmV0dXJuIFtcbiAgICBcIi0gKipBbmFseXNpcyoqOlwiLFxuICAgIFwiXCIsXG4gICAgLi4uZmVuY2VBbmFseXNpcyhjYXBwZWQpLFxuICAgIC4uLihkcm9wcGVkID4gMFxuICAgICAgPyBbXG4gICAgICAgIFwiXCIsXG4gICAgICAgIGBfJHtkcm9wcGVkfSBjaGFyYWN0ZXJzIHRydW5jYXRlZCDigJQgdGhlIGZ1bGwgcmVwbHkgaXMgaW4gdGhlIHJ1biBsb2cuX2AsXG4gICAgICBdXG4gICAgICA6IFtdKSxcbiAgXTtcbn1cblxuLyoqIE9uZSBydW4ncyBzdGFnZSB0aW1pbmdzIGxpbmUuICovXG5mdW5jdGlvbiByZW5kZXJUaW1pbmdzKHJ1bjogTWVyZ2VGYWxsYmFja1J1bik6IHN0cmluZyB7XG4gIGNvbnN0IHRpbWluZ3MgPSBydW4udGltaW5ncyA/PyBbXTtcbiAgcmV0dXJuIHRpbWluZ3MubGVuZ3RoID09PSAwXG4gICAgPyBgLSAqKlN0YWdlIHRpbWluZ3MqKjogJHtOT1RfUkVDT1JERUR9YFxuICAgIDogYC0gKipTdGFnZSB0aW1pbmdzKio6ICR7XG4gICAgICB0aW1pbmdzXG4gICAgICAgIC5tYXAoKHQpID0+XG4gICAgICAgICAgYCR7c2FuaXRpc2VJc3N1ZVRleHQodC5zdGFnZSl9ICR7XG4gICAgICAgICAgICB0LnNlY29uZHMgPT09IG51bGwgPyBcInVuZmluaXNoZWRcIiA6IGAke3Quc2Vjb25kc31zYFxuICAgICAgICAgIH1gXG4gICAgICAgIClcbiAgICAgICAgLmpvaW4oXCIsIFwiKVxuICAgIH1gO1xufVxuXG4vKiogT25lIHJ1bidzIGhvc3QsIHRpbWluZ3MgYW5kIGFuYWx5c2lzLiAqL1xuZnVuY3Rpb24gcmVuZGVyUnVuKHJ1bjogTWVyZ2VGYWxsYmFja1J1biwgcmVwbzogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gW1xuICAgIGAjIyMjIFJ1biAke3J1bi5ydW59YCxcbiAgICBcIlwiLFxuICAgIGZpZWxkKFwiSG9zdFwiLCBydW4uaG9zdCksXG4gICAgcmVuZGVyVGltaW5ncyhydW4pLFxuICAgIC4uLnJlbmRlckFuYWx5c2lzKHJ1bi5hbmFseXNpcywgcmVwbyksXG4gICAgXCJcIixcbiAgXTtcbn1cblxuLyoqIE9uZSBydW4gb2YgYSBwcml2YXRlIHNvdXJjZTogaG9zdCwgdGltaW5ncyBhbmQgaXRzIGNvbmNsdXNpb24gb25seS4gKi9cbmZ1bmN0aW9uIHJlbmRlclByaXZhdGVSdW4oXG4gIHJ1bjogTWVyZ2VGYWxsYmFja1J1bixcbiAgdGFyZ2V0OiBNZXJnZUZhbGxiYWNrVGFyZ2V0LFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBjb25jbHVzaW9uID0gY29uY2x1c2lvbkxpbmUocnVuKTtcbiAgcmV0dXJuIFtcbiAgICBgIyMjIyBSdW4gJHtydW4ucnVufWAsXG4gICAgXCJcIixcbiAgICBmaWVsZChcIkhvc3RcIiwgcnVuLmhvc3QpLFxuICAgIHJlbmRlclRpbWluZ3MocnVuKSxcbiAgICBjb25jbHVzaW9uID09PSB1bmRlZmluZWRcbiAgICAgID8gYC0gKipDb25jbHVzaW9uKio6ICR7Tk9UX1JFQ09SREVEfWBcbiAgICAgIDogYC0gKipDb25jbHVzaW9uKio6ICR7XG4gICAgICAgIHNjcnViUHJpdmF0ZShzYW5pdGlzZUlzc3VlVGV4dChjb25jbHVzaW9uKSwgdGFyZ2V0KVxuICAgICAgfWAsXG4gICAgXCJcIixcbiAgXTtcbn1cblxuLyoqIFRoZSB0YXJnZXQgYmxvY2sg4oCUIHdoaWNoIFBSIG9yIGJyYW5jaCwgYW5kIGFnYWluc3Qgd2hhdC4gKi9cbmZ1bmN0aW9uIHJlbmRlclRhcmdldCh0YXJnZXQ6IE1lcmdlRmFsbGJhY2tUYXJnZXQpOiBzdHJpbmdbXSB7XG4gIGlmICh0YXJnZXQua2luZCA9PT0gXCJwclwiKSB7XG4gICAgcmV0dXJuIFtcbiAgICAgIGZpZWxkKFwiUmVwb3NpdG9yeVwiLCB0YXJnZXQucmVwbyksXG4gICAgICBmaWVsZChcIlB1bGwgcmVxdWVzdFwiLCBgJHt0YXJnZXQucmVwb30jJHt0YXJnZXQucHJOdW1iZXJ9YCksXG4gICAgICBmaWVsZChcIkhlYWQgYnJhbmNoXCIsIHRhcmdldC5oZWFkQnJhbmNoKSxcbiAgICAgIGZpZWxkKFwiQmFzZSBicmFuY2hcIiwgdGFyZ2V0LmJhc2VCcmFuY2gpLFxuICAgIF07XG4gIH1cbiAgcmV0dXJuIFtcbiAgICBmaWVsZChcIlJlcG9zaXRvcnlcIiwgdGFyZ2V0LnJlcG8pLFxuICAgIGZpZWxkKFwiTWlsZXN0b25lIGJyYW5jaFwiLCB0YXJnZXQubWlsZXN0b25lQnJhbmNoKSxcbiAgICBmaWVsZChcIkRlZmF1bHQgYnJhbmNoXCIsIHRhcmdldC5kZWZhdWx0QnJhbmNoKSxcbiAgXTtcbn1cblxuLyoqXG4gKiBXaGF0IHRoZSBhYmFuZG9uZWQgUFIgY2hhbmdlZCwgd2hlbiB0aGUgZmFsbGJhY2sgcmVhZCBpdCAoSXNzdWUgIzIzMTApLlxuICpcbiAqIFRoZSBzZWN0aW9uIHJlbmRlcnMgb25seSB3aGVuIHtAbGluayBNZXJnZUZhbGxiYWNrRXZlbnQuZGlmZlN1bW1hcnl9IGlzXG4gKiBwcmVzZW50LCBiZWNhdXNlIGFic2VudCBtZWFucyBub2JvZHkgYXNrZWQ6IGEgbWlsZXN0b25lIGJyYW5jaCBoYXMgbm8gUFIgZGlmZlxuICogYXQgYWxsLCBhbmQgdGhlIFBSIHJvdXRlIHRoYXQgcmUtcXVldWVzIGFuIG9yaWdpbmF0aW5nIGlzc3VlIG5lZWRzIG5vbmUuXG4gKiBQcmludGluZyBgbm90IHJlY29yZGVkYCBmb3IgYSByZWFkIG5vYm9keVxuICogYXR0ZW1wdGVkIHdvdWxkIGNsYWltIGEgbWVhc3VyZW1lbnQgZmFpbHVyZSB0aGF0IG5ldmVyIGhhcHBlbmVkLlxuICpcbiAqIEEgc3VtbWFyeSB0aGF0ICoqd2FzKiogcmVhZCBhbmQgY2FtZSBiYWNrIGVtcHR5IHNheXMgc28gaW4gd29yZHMsIHNvIFwiR2l0SHViXG4gKiByZXBvcnRlZCBubyBjaGFuZ2VkIGZpbGVcIiBpcyBuZXZlciBtaXN0YWtlbiBmb3IgXCJ0aGUgZGlmZiB3YXMgbm90IHJlYWRcIi5cbiAqL1xuZnVuY3Rpb24gcmVuZGVyRGlmZlN1bW1hcnkoZXZlbnQ6IE1lcmdlRmFsbGJhY2tFdmVudCk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZmlsZXMgPSBldmVudC5kaWZmU3VtbWFyeTtcbiAgaWYgKGZpbGVzID09PSB1bmRlZmluZWQpIHJldHVybiBbXTtcbiAgY29uc3Qgb21pdHRlZCA9IGV2ZW50LmRpZmZTdW1tYXJ5T21pdHRlZCA/PyAwO1xuICByZXR1cm4gW1xuICAgIFwiIyMjIFdoYXQgdGhlIFBSIGNoYW5nZWRcIixcbiAgICBcIlwiLFxuICAgIC4uLihmaWxlcy5sZW5ndGggPT09IDBcbiAgICAgID8gW1wiR2l0SHViIHJlcG9ydGVkIG5vIGNoYW5nZWQgZmlsZSBmb3IgdGhpcyBQUi5cIl1cbiAgICAgIDogZmlsZXMubWFwKChmaWxlKSA9PlxuICAgICAgICBgLSBcXGAke3Nhbml0aXNlSXNzdWVUZXh0KGZpbGUucGF0aCl9XFxgIGAgK1xuICAgICAgICBgKCske2ZpbGUuYWRkaXRpb25zfS8tJHtmaWxlLmRlbGV0aW9uc30pYFxuICAgICAgKSksXG4gICAgLi4uKG9taXR0ZWQgPiAwXG4gICAgICA/IFtcIlwiLCBgXyR7b21pdHRlZH0gZnVydGhlciBwYXRoKHMpIGFyZSBub3QgbGlzdGVkIOKAlCB0aGUgY2FwIHdhcyBoaXQuX2BdXG4gICAgICA6IFtdKSxcbiAgICBcIlwiLFxuICBdO1xufVxuXG4vKipcbiAqIEJvZHkgb2YgdGhlIGZhbGxiYWNrIHJlY29yZCDigJQgYW5kIG9mIHRoZSBjb21tZW50IGFwcGVuZGVkIGZvciBhIHJlcGVhdC5cbiAqXG4gKiBQdXJlOiB0aGUgc2FtZSBldmVudCBhbmQgdmlzaWJpbGl0eSBhbHdheXMgcmVuZGVyIHRoZSBzYW1lIGJvZHkuIEEgcHVibGljXG4gKiBzb3VyY2UgcmVuZGVycyBldmVyeSBmaWVsZCwgb25lIHRoZSBjYWxsZXIgY291bGQgbm90IHJlY29yZCBhc1xuICogYG5vdCByZWNvcmRlZGAsIHdpdGggZWFjaCBgI05gIHF1YWxpZmllZCBieSBpdHMgcmVwb3NpdG9yeS4gQSBwcml2YXRlXG4gKiBzb3VyY2Ug4oCUIHRoZSBkZWZhdWx0LCBzbyBhbiB1bmtub3duIHZpc2liaWxpdHkgbmV2ZXIgbGVha3Mg4oCUIHJlbmRlcnMgb25seVxuICogd2hhdCBuYW1lcyBub3RoaW5nIG9mIGl0IChJc3N1ZSAjNDQ1NikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZE1lcmdlRmFsbGJhY2tCb2R5KFxuICBldmVudDogTWVyZ2VGYWxsYmFja0V2ZW50LFxuICB2aXNpYmlsaXR5OiBTb3VyY2VWaXNpYmlsaXR5ID0gXCJwcml2YXRlXCIsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gdmlzaWJpbGl0eSA9PT0gXCJwdWJsaWNcIlxuICAgID8gYnVpbGRQdWJsaWNCb2R5KGV2ZW50KVxuICAgIDogYnVpbGRQcml2YXRlQm9keShldmVudCk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUHJpdmF0ZUJvZHkoZXZlbnQ6IE1lcmdlRmFsbGJhY2tFdmVudCk6IHN0cmluZyB7XG4gIGNvbnN0IHsgdGFyZ2V0LCBydW5zID0gW10gfSA9IGV2ZW50O1xuICBjb25zdCBraW5kID0gdGFyZ2V0LmtpbmQgPT09IFwicHJcIiA/IFwiYSBwdWxsIHJlcXVlc3RcIiA6IFwiYSBtaWxlc3RvbmUgYnJhbmNoXCI7XG4gIHJldHVybiBbXG4gICAgbWVyZ2VGYWxsYmFja01hcmtlcihldmVudCksXG4gICAgXCJcIixcbiAgICBgVGhlIGNvbmZsaWN0IGZhbGxiYWNrIHJhbiBvbiAke2tpbmR9IG9mIGEgcHJpdmF0ZSBtb25pdG9yZWQgYCArXG4gICAgXCJyZXBvc2l0b3J5OiB0aGUgYWdlbnQgcnVucyBjb3VsZCBub3Qgc2V0dGxlIHRoZSBjb25mbGljdCwgc28gdGhlIGZsZWV0IFwiICtcbiAgICBcImZlbGwgYmFjay4gQSBmYWxsYmFjayBpcyBhIHdvcmtlciBmYWlsdXJlIChJc3N1ZSAjNDQ1NikuIFRoZSBzb3VyY2UgaXMgXCIgK1xuICAgIFwicHJpdmF0ZSwgc28gaXRzIHJlcG9zaXRvcnksIGJyYW5jaGVzLCBwYXRocyBhbmQgdGhlIGFnZW50cycgZnVsbCBcIiArXG4gICAgXCJyZXBsaWVzIGFyZSBsZWZ0IG91dDsgdGhlIGhvc3RzIGFuZCB0aW1lcyBiZWxvdyBmaW5kIHRoZW0gaW4gZWFjaCBcIiArXG4gICAgXCJob3N0J3MgcnVuIGxvZy5cIixcbiAgICBcIlwiLFxuICAgIFwiIyMjIENhdXNlXCIsXG4gICAgXCJcIixcbiAgICBtZXJnZUZhbGxiYWNrQ2F1c2UoZXZlbnQpLFxuICAgIFwiXCIsXG4gICAgXCIjIyMgQWdlbnQgcnVuc1wiLFxuICAgIFwiXCIsXG4gICAgLi4uKHJ1bnMubGVuZ3RoID09PSAwXG4gICAgICA/IFtOT1RfUkVDT1JERUQsIFwiXCJdXG4gICAgICA6IHJ1bnMuZmxhdE1hcCgocnVuKSA9PiByZW5kZXJQcml2YXRlUnVuKHJ1biwgdGFyZ2V0KSkpLFxuICAgIFwiIyMjIEhvdyBmYXIgYmVoaW5kIHRoZSBiYXNlXCIsXG4gICAgXCJcIixcbiAgICBmaWVsZChcIkNvbW1pdHMgYmVoaW5kIHRoZSBiYXNlXCIsIGV2ZW50LmJlaGluZEJ5KSxcbiAgICBmaWVsZChcIkJlaGluZCBzaW5jZVwiLCBldmVudC5iZWhpbmRTaW5jZSksXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuZnVuY3Rpb24gYnVpbGRQdWJsaWNCb2R5KGV2ZW50OiBNZXJnZUZhbGxiYWNrRXZlbnQpOiBzdHJpbmcge1xuICBjb25zdCB7IHRhcmdldCwgY29uZmxpY3RlZEZpbGVzID0gW10sIHJ1bnMgPSBbXSB9ID0gZXZlbnQ7XG4gIGNvbnN0IHJlcG8gPSBzYW5pdGlzZUlzc3VlVGV4dCh0YXJnZXQucmVwbyk7XG4gIGNvbnN0IHdoYXQgPSB0YXJnZXQua2luZCA9PT0gXCJwclwiXG4gICAgPyBgJHtyZXBvfSMke3RhcmdldC5wck51bWJlcn1gXG4gICAgOiBgJHtyZXBvfSBcXGAke3Nhbml0aXNlSXNzdWVUZXh0KHRhcmdldC5taWxlc3RvbmVCcmFuY2gpfVxcYGA7XG5cbiAgcmV0dXJuIFtcbiAgICBtZXJnZUZhbGxiYWNrTWFya2VyKGV2ZW50KSxcbiAgICBcIlwiLFxuICAgIGBUaGUgY29uZmxpY3QgZmFsbGJhY2sgcmFuIG9uICR7d2hhdH06IHRoZSBhZ2VudCBydW5zIGNvdWxkIG5vdCBzZXR0bGUgYCArXG4gICAgXCJ0aGUgY29uZmxpY3QsIHNvIHRoZSBmbGVldCBmZWxsIGJhY2suIEEgZmFsbGJhY2sgaXMgYSB3b3JrZXIgZmFpbHVyZSwgXCIgK1xuICAgIFwicmVjb3JkZWQgaGVyZSBzbyB0aGUgY2F1c2UgY2FuIGJlIGZpeGVkIHJhdGhlciB0aGFuIHdhbGtlZCBpbnRvIGFnYWluIFwiICtcbiAgICBcIihJc3N1ZXMgIzIyOTgsICM0NDU2KS5cIixcbiAgICBcIlwiLFxuICAgIFwiIyMjIENhdXNlXCIsXG4gICAgXCJcIixcbiAgICBtZXJnZUZhbGxiYWNrQ2F1c2UoZXZlbnQpLFxuICAgIFwiXCIsXG4gICAgXCIjIyMgVGFyZ2V0XCIsXG4gICAgXCJcIixcbiAgICAuLi5yZW5kZXJUYXJnZXQodGFyZ2V0KSxcbiAgICBcIlwiLFxuICAgIFwiIyMjIENvbmZsaWN0ZWQgZmlsZXNcIixcbiAgICBcIlwiLFxuICAgIC4uLihjb25mbGljdGVkRmlsZXMubGVuZ3RoID09PSAwXG4gICAgICA/IFtOT1RfUkVDT1JERURdXG4gICAgICA6IGNvbmZsaWN0ZWRGaWxlcy5tYXAoKHBhdGgpID0+IGAtIFxcYCR7c2FuaXRpc2VJc3N1ZVRleHQocGF0aCl9XFxgYCkpLFxuICAgIFwiXCIsXG4gICAgXCIjIyMgQWdlbnQgcnVuc1wiLFxuICAgIFwiXCIsXG4gICAgLi4uKHJ1bnMubGVuZ3RoID09PSAwXG4gICAgICA/IFtOT1RfUkVDT1JERUQsIFwiXCJdXG4gICAgICA6IHJ1bnMuZmxhdE1hcCgocnVuKSA9PiByZW5kZXJSdW4ocnVuLCByZXBvKSkpLFxuICAgIC4uLnJlbmRlckRpZmZTdW1tYXJ5KGV2ZW50KSxcbiAgICBcIiMjIyBIb3cgZmFyIGJlaGluZCB0aGUgYmFzZVwiLFxuICAgIFwiXCIsXG4gICAgZmllbGQoXCJDb21taXRzIGJlaGluZCB0aGUgYmFzZVwiLCBldmVudC5iZWhpbmRCeSksXG4gICAgZmllbGQoXCJCZWhpbmQgc2luY2VcIiwgZXZlbnQuYmVoaW5kU2luY2UpLFxuICAgIFwiXCIsXG4gICAgXCIjIyMgV2hhdCB3YXMgY2xvc2VkIG9yIHJldmVydGVkXCIsXG4gICAgXCJcIixcbiAgICBldmVudC5mYWxsYmFja0FjdGlvbiA9PT0gdW5kZWZpbmVkIHx8IGV2ZW50LmZhbGxiYWNrQWN0aW9uID09PSBcIlwiXG4gICAgICA/IE5PVF9SRUNPUkRFRFxuICAgICAgOiBxdWFsaWZ5UmVmZXJlbmNlcyhzYW5pdGlzZUlzc3VlVGV4dChldmVudC5mYWxsYmFja0FjdGlvbiksIHJlcG8pLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKiBgLS1qc29uYCBmaWVsZHMgdGhlIGRlZHVwIHNlYXJjaCBuZWVkczogYXV0aG9yLCBleGFjdCB0aXRsZSwgc3RhdGUsIFVSTC4gKi9cbmNvbnN0IERFRFVQX0pTT05fRklFTERTID0gYCR7QUxFUlRfREVEVVBfVElUTEVfSlNPTl9GSUVMRFN9LHN0YXRlLHVybGA7XG5cbi8qKiBPbmUgcm93IG9mIHRoZSBmbGFnLWlzc3VlIGRlZHVwIHNlYXJjaC4gKi9cbmludGVyZmFjZSBGbGFnSXNzdWVSb3cgZXh0ZW5kcyBBbGVydERlZHVwUm93IHtcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIHN0YXRlPzogc3RyaW5nO1xuICB1cmw/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogVGhlIHNvdXJjZSByZXBvc2l0b3J5J3MgdmlzaWJpbGl0eSwgcmVhZCB0aHJvdWdoIHRoZSBjYWxsZXIncyBgZ2hgLlxuICpcbiAqIEFueXRoaW5nIGJ1dCBhbiBleHBsaWNpdCBgcHVibGljYCDigJQgYW4gZXJyb3IsIGFuIGVtcHR5IGFuc3dlciwgYGludGVybmFsYCDigJRcbiAqIGlzIHByaXZhdGUsIHNvIGEgZmFpbGVkIGxvb2t1cCBuZXZlciBuYW1lcyBhIHByaXZhdGUgcmVwb3NpdG9yeS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc291cmNlVmlzaWJpbGl0eShcbiAgZ2g6IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+LFxuICByZXBvOiBzdHJpbmcsXG4pOiBQcm9taXNlPFNvdXJjZVZpc2liaWxpdHk+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBhbnN3ZXIgPSBhd2FpdCBnaChbXCJhcGlcIiwgYHJlcG9zLyR7cmVwb31gLCBcIi0tanFcIiwgXCIudmlzaWJpbGl0eVwiXSk7XG4gICAgcmV0dXJuIGFuc3dlci50cmltKCkudG9Mb3dlckNhc2UoKSA9PT0gXCJwdWJsaWNcIiA/IFwicHVibGljXCIgOiBcInByaXZhdGVcIjtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwicHJpdmF0ZVwiO1xuICB9XG59XG5cbi8qKlxuICogRmlsZSBvbmUgZmFsbGJhY2sgZXZlbnQgaW4gVmliZUNvZGVyIGFzIGEgd29ya2VyIGZhaWx1cmUsIG9yIGFwcGVuZCBpdCB0b1xuICogdGhlIG9wZW4gcmVjb3JkIGZvciB0aGUgc2FtZSBjYXVzZSAoSXNzdWUgIzQ0NTYpLlxuICpcbiAqIEBwYXJhbSBmaWxpbmcgLSBUaGUgZXZlbnQuXG4gKiBAcGFyYW0gZGVwcyAtIEluamVjdGVkIGBnaGAsIGxhYmVsIGNyZWF0aW9uLCBmbGVldCBpZGVudGl0eSBhbmQgbG9nZ2VyLlxuICogQHJldHVybnMgVGhlIGZsYWcgaXNzdWUsIGFuZCB3aGV0aGVyIHRoaXMgY2FsbCBhcHBlbmRlZCB0byBhbiBleGlzdGluZyBvbmUuXG4gKiAgIEEgYGdoYCBmYWlsdXJlIGlzIHJldHVybmVkIGFzIHRoZSBlcnJvciwgbmV2ZXIgc3dhbGxvd2VkLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmlsZU1lcmdlRmFsbGJhY2tJc3N1ZShcbiAgZmlsaW5nOiBNZXJnZUZhbGxiYWNrRmlsaW5nLFxuICBkZXBzOiBNZXJnZUZhbGxiYWNrSXNzdWVEZXBzID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxNZXJnZUZhbGxiYWNrT3V0Y29tZT4+IHtcbiAgY29uc3QgZ2ggPSBkZXBzLmdoID8/IGRlZmF1bHRHaDtcbiAgY29uc3QgcmVwbyA9IE1FUkdFX0ZBTExCQUNLX1RBUkdFVF9SRVBPO1xuICBjb25zdCB0aXRsZSA9IG1lcmdlRmFsbGJhY2tUaXRsZShmaWxpbmcpO1xuICBjb25zdCBib2R5ID0gYnVpbGRNZXJnZUZhbGxiYWNrQm9keShcbiAgICBmaWxpbmcsXG4gICAgYXdhaXQgc291cmNlVmlzaWJpbGl0eShnaCwgZmlsaW5nLnRhcmdldC5yZXBvKSxcbiAgKTtcbiAgY29uc3QgbG9nID0gKG1lc3NhZ2U6IHN0cmluZykgPT4ge1xuICAgIGlmIChkZXBzLmxvZ2dlcj8ud2FybikgZGVwcy5sb2dnZXIud2FybihtZXNzYWdlLCB7IHJlcG8gfSk7XG4gICAgZWxzZSBjb25zb2xlLndhcm4obWVzc2FnZSk7XG4gIH07XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGZpbmRPcGVuRmxhZ0lzc3VlKGdoLCByZXBvLCB0aXRsZSwgZGVwcywgbG9nKTtcblxuICAgIGlmIChleGlzdGluZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBhd2FpdCBnaChbXG4gICAgICAgIFwiaXNzdWVcIixcbiAgICAgICAgXCJjb21tZW50XCIsXG4gICAgICAgIFN0cmluZyhleGlzdGluZy5udW1iZXIpLFxuICAgICAgICBcIi0tcmVwb1wiLFxuICAgICAgICByZXBvLFxuICAgICAgICBcIi0tYm9keVwiLFxuICAgICAgICBib2R5LFxuICAgICAgXSk7XG4gICAgICBkZXBzLmxvZ2dlcj8uaW5mbz8uKFwiQXBwZW5kZWQgYSBmYWxsYmFjayBldmVudCB0byBpdHMgZmxhZyBpc3N1ZVwiLCB7XG4gICAgICAgIHJlcG8sXG4gICAgICAgIGlzc3VlTnVtYmVyOiBleGlzdGluZy5udW1iZXIsXG4gICAgICB9KTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZToge1xuICAgICAgICAgIGlzc3VlTnVtYmVyOiBleGlzdGluZy5udW1iZXIsXG4gICAgICAgICAgdXJsOiBleGlzdGluZy51cmwgPz8gXCJcIixcbiAgICAgICAgICBhcHBlbmRlZDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gVGhlIGZsYWcgaXMgb25seSByZWFkYWJsZSBpZiB0aGUgbGFiZWwgZXhpc3RzLiBBIHJlcG8gdGhhdCBoYXMgbmV2ZXJcbiAgICAvLyBoYWQgYSBmYWxsYmFjayBoYXMgbmV2ZXIgaGFkIHRoZSBsYWJlbCwgc28gY3JlYXRlIGl0IG9uIGZpcnN0IHVzZSDigJRcbiAgICAvLyBjb2xvdXIgYW5kIGRlc2NyaXB0aW9uIGNvbWUgZnJvbSB0aGUgY2Fub25pY2FsIGNvbnRlbnQtbGFiZWwgdGFibGUuXG4gICAgY29uc3QgZW5zdXJlID0gZGVwcy5lbnN1cmVMYWJlbEV4aXN0cyA/PyBkZWZhdWx0RW5zdXJlTGFiZWxFeGlzdHM7XG4gICAgY29uc3QgZW5zdXJlZCA9IGF3YWl0IGVuc3VyZShyZXBvLCBNRVJHRV9GQUxMQkFDS19MQUJFTCk7XG4gICAgaWYgKCFlbnN1cmVkLm9rKSB7XG4gICAgICAvLyBTYWlkIG91dCBsb3VkLCB0aGVuIHByZXNzZWQgb246IHRoZSBsYWJlbCBtYXkgYWxyZWFkeSBleGlzdCwgYW5kIGFcbiAgICAgIC8vIGdlbnVpbmVseSBtaXNzaW5nIG9uZSBmYWlscyB0aGUgY3JlYXRlIGJlbG93IHJhdGhlciB0aGFuIHNpbGVudGx5LlxuICAgICAgbG9nKFxuICAgICAgICBgW21lcmdlLWZhbGxiYWNrXSBjb3VsZCBub3QgY3JlYXRlIHRoZSBcXGAke01FUkdFX0ZBTExCQUNLX0xBQkVMfVxcYCBgICtcbiAgICAgICAgICBgbGFiZWwgaW4gJHtyZXBvfTogJHtlbnN1cmVkLmVycm9yLm1lc3NhZ2V9LiBGaWxpbmcgYW55d2F5IOKAlCB0aGUgYCArXG4gICAgICAgICAgXCJmbGFnIG1hdHRlcnMgbW9yZSB0aGFuIGl0cyBjb2xvdXIuXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGNyZWF0ZWQgPSBhd2FpdCBnaChbXG4gICAgICBcImlzc3VlXCIsXG4gICAgICBcImNyZWF0ZVwiLFxuICAgICAgXCItLXJlcG9cIixcbiAgICAgIHJlcG8sXG4gICAgICBcIi0tdGl0bGVcIixcbiAgICAgIHRpdGxlLFxuICAgICAgXCItLWJvZHlcIixcbiAgICAgIGJvZHksXG4gICAgICAuLi5ndWFyZGVkTGFiZWxBcmdzKFtCVUdfTEFCRUwsIE1FUkdFX0ZBTExCQUNLX0xBQkVMXSwgQ0FMTEVSKSxcbiAgICBdKTtcbiAgICBjb25zdCB1cmwgPSBjcmVhdGVkLnRyaW0oKTtcbiAgICBjb25zdCBwYXJzZWQgPSBOdW1iZXIodXJsLnNwbGl0KFwiL1wiKS5wb3AoKSk7XG4gICAgY29uc3QgaXNzdWVOdW1iZXIgPSBOdW1iZXIuaXNJbnRlZ2VyKHBhcnNlZCkgPyBwYXJzZWQgOiAwO1xuICAgIGlmIChpc3N1ZU51bWJlciA9PT0gMCkge1xuICAgICAgLy8gVGhlIGlzc3VlIGV4aXN0cyDigJQgYGdoYCBkaWQgbm90IGZhaWwg4oCUIGJ1dCBub3RoaW5nIGNhbiBsaW5rIHRvIGl0LlxuICAgICAgLy8gQSBgMGAgaGFuZGVkIGJhY2sgc2lsZW50bHkgd291bGQgcmVhZCBhcyBhIGZpbGVkLCBmaW5kYWJsZSBmbGFnLlxuICAgICAgbG9nKFxuICAgICAgICBgW21lcmdlLWZhbGxiYWNrXSBmaWxlZCB0aGUgZmxhZyBpbiAke3JlcG99IGJ1dCBjb3VsZCBub3QgcmVhZCBpdHMgYCArXG4gICAgICAgICAgYG51bWJlciBmcm9tIFxcYGdoIGlzc3VlIGNyZWF0ZVxcYCBvdXRwdXQgKCR7dXJsIHx8IFwiZW1wdHlcIn0pLiBUaGUgYCArXG4gICAgICAgICAgXCJpc3N1ZSBleGlzdHM7IHRoZSBjYWxsZXIgaGFzIG5vIG51bWJlciB0byBsaW5rIGl0IGJ5LlwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgZGVwcy5sb2dnZXI/LmluZm8/LihcIkZpbGVkIGEgY29uZmxpY3QgZmFsbGJhY2sgYXMgYSBWaWJlQ29kZXIgZmFpbHVyZVwiLCB7XG4gICAgICByZXBvLFxuICAgICAgaXNzdWVOdW1iZXIsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGlzc3VlTnVtYmVyLCB1cmwsIGFwcGVuZGVkOiBmYWxzZSB9IH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBmaWxlciBib3RoIFBSLXBhdGggZmFsbGJhY2sgcm91dGVzIHVzZSwgYm91bmQgdG8gb25lIGBnaGAgKElzc3VlICMyMzEwKS5cbiAqXG4gKiBPbmUgZGVmaW5pdGlvbiBvZiB0aGUgd2lyaW5nIHJhdGhlciB0aGFuIHR3bzogdGhlIGxhYmVsIGNyZWF0aW9uIGhhcyB0byBiZVxuICogcm91dGVkIHRocm91Z2ggdGhlIGNhbGxlcidzIG93biBgZ2hgIOKAlCB0aGUgZGVmYXVsdCByZWFjaGVzIHRoZSByZWFsIENMSSDigJQgYW5kXG4gKiBhIHNlY29uZCBjb3B5IG9mIHRoYXQgY2xvc3VyZSBpcyBhIHNlY29uZCB0aGluZyB0byBnZXQgd3JvbmcuXG4gKlxuICogQHBhcmFtIGRlcHMgLSBUaGUgY2FsbGVyJ3MgYGdoYCwgaXRzIGxvZ2dlciwgYW5kIHRoZSBmbGVldCBpZGVudGl0eSB0aGVcbiAqICAgZGVkdXAgbWF0Y2ggaXMgdmVyaWZpZWQgYWdhaW5zdFxuICogQHJldHVybnMgQSBmaWxlciB0YWtpbmcgb25seSB0aGUgZmlsaW5nLCBmb3IgdXNlIGFzIGFuIGluamVjdGVkIHNlYW1cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUZhbGxiYWNrRmxhZ0ZpbGVyKGRlcHM6IHtcbiAgZ2g6IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+O1xuICBsb2dnZXI/OiBMb2dnZXI7XG4gIGZsZWV0QXV0aG9ycz86IHJlYWRvbmx5IHN0cmluZ1tdO1xufSk6IChmaWxpbmc6IE1lcmdlRmFsbGJhY2tGaWxpbmcpID0+IFByb21pc2U8UmVzdWx0PE1lcmdlRmFsbGJhY2tPdXRjb21lPj4ge1xuICByZXR1cm4gKGZpbGluZzogTWVyZ2VGYWxsYmFja0ZpbGluZykgPT5cbiAgICBmaWxlTWVyZ2VGYWxsYmFja0lzc3VlKGZpbGluZywge1xuICAgICAgZ2g6IGRlcHMuZ2gsXG4gICAgICAuLi4oZGVwcy5sb2dnZXIgIT09IHVuZGVmaW5lZCA/IHsgbG9nZ2VyOiBkZXBzLmxvZ2dlciB9IDoge30pLFxuICAgICAgLi4uKGRlcHMuZmxlZXRBdXRob3JzICE9PSB1bmRlZmluZWRcbiAgICAgICAgPyB7IGZsZWV0QXV0aG9yczogZGVwcy5mbGVldEF1dGhvcnMgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIGVuc3VyZUxhYmVsRXhpc3RzOiAoXG4gICAgICAgIHJlcG86IHN0cmluZyxcbiAgICAgICAgbGFiZWxOYW1lOiBzdHJpbmcsXG4gICAgICAgIGNvbG91cj86IHN0cmluZyxcbiAgICAgICAgZGVzY3JpcHRpb24/OiBzdHJpbmcsXG4gICAgICApID0+XG4gICAgICAgIGRlZmF1bHRFbnN1cmVMYWJlbEV4aXN0cyhyZXBvLCBsYWJlbE5hbWUsIGNvbG91ciwgZGVzY3JpcHRpb24sIHtcbiAgICAgICAgICBnaENvbW1hbmRGbjogZGVwcy5naCxcbiAgICAgICAgfSksXG4gICAgfSk7XG59XG5cbi8qKlxuICogVGhlIG9wZW4sIGZsZWV0LWF1dGhvcmVkIGZsYWcgaXNzdWUgZm9yIHRoaXMgdGl0bGUsIGlmIHRoZXJlIGlzIG9uZS5cbiAqXG4gKiBVbnBhcnNlYWJsZSBvdXRwdXQgeWllbGRzIGB1bmRlZmluZWRgLCB3aGljaCBmaWxlcyBhIGZyZXNoIGZsYWc6IHRoZSBmYWlsXG4gKiBkaXJlY3Rpb24gaXMgdG93YXJkcyBhIGR1cGxpY2F0ZSByYXRoZXIgdGhhbiB0b3dhcmRzIHNpbGVuY2UuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZpbmRPcGVuRmxhZ0lzc3VlKFxuICBnaDogKGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHN0cmluZz4sXG4gIHJlcG86IHN0cmluZyxcbiAgdGl0bGU6IHN0cmluZyxcbiAgZGVwczogTWVyZ2VGYWxsYmFja0lzc3VlRGVwcyxcbiAgbG9nOiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkLFxuKTogUHJvbWlzZTxGbGFnSXNzdWVSb3cgfCB1bmRlZmluZWQ+IHtcbiAgY29uc3QgbGlzdGVkID0gYXdhaXQgZ2goW1xuICAgIFwiaXNzdWVcIixcbiAgICBcImxpc3RcIixcbiAgICBcIi0tcmVwb1wiLFxuICAgIHJlcG8sXG4gICAgXCItLXN0YXRlXCIsXG4gICAgXCJvcGVuXCIsXG4gICAgLy8gRGVsaWJlcmF0ZWx5IG5vdCBmaWx0ZXJlZCBieSBgLS1sYWJlbGA6IGEgaHVtYW4gd2hvIHRha2VzIHRoZSBsYWJlbCBvZmZcbiAgICAvLyBhIGZsYWcgaXNzdWUgd291bGQgb3RoZXJ3aXNlIG1ha2UgaXQgaW52aXNpYmxlIGhlcmUsIGFuZCB0aGUgbmV4dFxuICAgIC8vIGZhbGxiYWNrIHdvdWxkIGZpbGUgYSBzZWNvbmQgZmxhZyBmb3IgdGhlIHNhbWUgdGFyZ2V0LiBUaGUgZXhhY3QgdGl0bGUsXG4gICAgLy8gdGhlIG9wZW4gc3RhdGUgYW5kIHRoZSBmbGVldCBhdXRob3IgYXJlIHRoZSBtYXRjaC5cbiAgICBcIi0tc2VhcmNoXCIsXG4gICAgYGluOnRpdGxlIFwiJHt0aXRsZX1cImAsXG4gICAgXCItLWpzb25cIixcbiAgICBERURVUF9KU09OX0ZJRUxEUyxcbiAgXSk7XG5cbiAgbGV0IHJvd3M6IEZsYWdJc3N1ZVJvd1tdO1xuICB0cnkge1xuICAgIHJvd3MgPSBKU09OLnBhcnNlKGxpc3RlZCB8fCBcIltdXCIpIGFzIEZsYWdJc3N1ZVJvd1tdO1xuICAgIGlmICghQXJyYXkuaXNBcnJheShyb3dzKSkgdGhyb3cgbmV3IEVycm9yKFwidGhlIGxpc3RpbmcgaXMgbm90IGFuIGFycmF5XCIpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIFNhaWQgb3V0IGxvdWQsIG5ldmVyIHN3YWxsb3dlZDogZGVkdXAgaXMgb2ZmIGZvciB0aGlzIGV2ZW50LCBzbyB0aGVcbiAgICAvLyBmbGFnIGlzIGZpbGVkIGFnYWluIHJhdGhlciB0aGFuIGxvc3QuXG4gICAgbG9nKFxuICAgICAgYFttZXJnZS1mYWxsYmFja10gY291bGQgbm90IHJlYWQgdGhlIGRlZHVwIGxpc3RpbmcgZm9yICR7cmVwb30gYCArXG4gICAgICAgIGBcIiR7dGl0bGV9XCI6ICR7XG4gICAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpXG4gICAgICAgIH0uIEZpbGluZyBhIGZyZXNoIGZsYWcg4oCUIGEgZHVwbGljYXRlIGlzIHJlY292ZXJhYmxlLCBhIGxvc3QgYCArXG4gICAgICAgIFwiZmFsbGJhY2sgcmVjb3JkIGlzIG5vdC5cIixcbiAgICApO1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICAvLyBCZWx0OiB0aGUgZXhhY3QgdGl0bGUsIGFuZCBhbiBpc3N1ZSBHaXRIdWIgc3RpbGwgcmVwb3J0cyBhcyBvcGVuLiBUaGVcbiAgLy8gYC0tc3RhdGUgb3BlbmAgZmlsdGVyIGFib3ZlIHNheXMgdGhlIHNhbWUgdGhpbmcsIGJ1dCB0aGUgZmxhZyByZWRpcmVjdHNcbiAgLy8gYW4gZXZlbnQgb250byB3aGF0ZXZlciBpdCBtYXRjaGVzLCBzbyB0aGUgc3RhdGUgaXMgcmUtcmVhZCBmcm9tIHRoZSByb3dcbiAgLy8gcmF0aGVyIHRoYW4gYXNzdW1lZCBmcm9tIHRoZSBhcmd1bWVudC5cbiAgY29uc3QgY2FuZGlkYXRlcyA9IHJvd3MuZmlsdGVyKChyb3cpID0+XG4gICAgcm93LnRpdGxlID09PSB0aXRsZSAmJlxuICAgIChyb3cuc3RhdGUgPT09IHVuZGVmaW5lZCB8fCByb3cuc3RhdGUudG9VcHBlckNhc2UoKSA9PT0gXCJPUEVOXCIpXG4gICk7XG4gIC8vIEJyYWNlczogYW5kIG9ubHkgYW4gaXNzdWUgYSBmbGVldCBhY2NvdW50IGF1dGhvcmVkLlxuICBjb25zdCB2ZXJpZmllZCA9IGF3YWl0IHNlbGVjdEZsZWV0QXV0aG9yZWRNYXRjaGVzKFxuICAgIGNhbmRpZGF0ZXMsXG4gICAgYG1lcmdlIGZhbGxiYWNrICR7cmVwb30gJHt0aXRsZX1gLFxuICAgIGRlcHMsXG4gICAgbG9nLFxuICAgIFwiYSBmcmVzaCBmbGFnIGlzc3VlIGlzIGZpbGVkIOKAlCBhIGZhbGxiYWNrIGV2ZW50IG11c3QgbmV2ZXIgYmUgcG9zdGVkIFwiICtcbiAgICAgIFwib250byBhbiBpc3N1ZSB0aGUgZmxlZXQgZGlkIG5vdCBvcGVuXCIsXG4gICk7XG4gIHJldHVybiB2ZXJpZmllZFswXTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBZ0RDLEdBR0QsU0FDRSw2QkFBNkIsRUFHN0IsMEJBQTBCLFFBQ3JCLDJCQUEyQjtBQUNsQyxTQUFTLGlCQUFpQixRQUFRLCtCQUErQjtBQUNqRSxTQUFTLE9BQU8sUUFBUSxnQkFBZ0I7QUFDeEMsU0FBUyxnQkFBZ0IsUUFBUSw0QkFBNEI7QUFDN0QsU0FBUyxxQkFBcUIsd0JBQXdCLFFBQVEsd0JBQXdCO0FBRXRGLGlFQUFpRSxHQUNqRSxPQUFPLE1BQU0sdUJBQXVCLGlCQUFpQjtBQUVyRDs7O0NBR0MsR0FDRCxPQUFPLE1BQU0sNkJBQTZCLHlCQUF5QjtBQUVuRSxzREFBc0QsR0FDdEQsTUFBTSxZQUFZO0FBRWxCLGtEQUFrRCxHQUNsRCxNQUFNLHFCQUFxQjtBQUUzQixtQ0FBbUMsR0FDbkMsTUFBTSxrQkFB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
// denoCacheMetadata=17804994396424031088,6210172755264029105