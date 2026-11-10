/**
 * Decision logic for the agent-side `gh` guard (Issue #3643).
 *
 * The worker's egress controls — the per-run write-repo allowlist
 * (`write_repo_allowlist.ts`) and the worker label guard
 * (`worker_label_guard.ts`) — enforce inside the worker's own Deno process,
 * at `runGhCommandRaw`. The party those controls name as the injected one is
 * the **agent subprocess**, which runs unrestricted Bash with an inherited
 * `GH_TOKEN`; its own `gh` calls never traverse `runGhCommandRaw`, so neither
 * control saw them.
 *
 * This module is the single decision the `gh` shim (`gh_guard_shim.ts`)
 * re-enters for every agent `gh` invocation, before the real binary runs. It
 * is pure — the caller supplies the run's allowlist state — so it can be
 * evaluated in a short-lived child process with no permissions at all.
 *
 * Six checks, in order:
 *   1. **Reserved workflow labels.** A *mutation* that adds `top-priority`,
 *      `work-on`, `question`, … is refused. The check is a denylist of the
 *      reserved names (`WORKER_FORBIDDEN_LABEL_LITERALS`), not the worker's
 *      positive allowlist, because the agent's legitimate label surface is
 *      genuinely wider than the worker's enumerable call sites (the scan
 *      templates file findings with content labels such as `confidence:high`).
 *      Reads (`gh issue list --label work-on`) are untouched.
 *   2. **Recognised root command** (Issue #3866). The guard classifies the
 *      *pre-expansion* argv, but the real binary expands a config alias
 *      (`~/.config/gh/config.yml`) or hands an unknown name to an extension —
 *      whatever the alias names is a write the guard never saw. A root the
 *      guard does not recognise as a genuine `gh` command is therefore
 *      refused rather than classified as a read.
 *   3. **Local `gh` state** (Issue #187). `gh auth login|switch|setup-git`,
 *      `gh config set`, `gh alias set` and `gh extension install` rewrite the
 *      pinned `GH_CONFIG_DIR` rather than anything on GitHub, so the mutation
 *      classifier reported no mutation and they passed as reads. They are
 *      refused unconditionally — see `gh_local_state_guard.ts`.
 *   4. **Credential disclosure** (Issue #1371). `gh auth token` and
 *      `gh auth status --show-token` change nothing, so they passed as
 *      reads — but they print the run's GitHub token, and an agent holding
 *      it can call the REST API directly, where none of the above applies.
 *      Refused unconditionally — see `gh_credential_disclosure_guard.ts`.
 *   5. **PR base change** (Issue #3433). `gh pr edit --base` and the REST
 *      `PATCH`/`POST …/pulls/N` with `base` are refused unconditionally (alongside
 *      the PR-lifecycle refusal): moving a milestone PR to the default branch
 *      skips the milestone's final review.
 *   6. **Write-repo allowlist.** Mirrors `enforceGhWriteAllowlist`: inert
 *      until the run seeds an allowlist, a no-op for reads and for cwd-repo
 *      writes with no explicit repo, and a refusal for a mutation that
 *      explicitly names an off-allowlist repo.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { classifyGhMutation } from "./audit_mutation_classifier.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";
import { WORKER_FORBIDDEN_LABEL_LITERALS } from "./worker_label_guard.ts";
import { RESERVED_LABELS } from "./config_defaults.ts";
import { classifyIssueLifecycle, ISSUE_LIFECYCLE_VERBS } from "./gh_issue_lifecycle.ts";
import { classifyPrLifecycle, PR_LIFECYCLE_VERBS } from "./gh_pr_lifecycle.ts";
import { canonicaliseGhArgs } from "./gh_argv_canonical.ts";
import { classifyPrBaseChange } from "./pr_base_change_guard.ts";
import { classifyGhCredentialDisclosure } from "./gh_credential_disclosure_guard.ts";
import { classifyGhLocalStateChange } from "./gh_local_state_guard.ts";
/**
 * Root commands the real `gh` binary implements itself (Issue #3866).
 *
 * `gh` only expands a config alias, or dispatches to an extension, for a name
 * that is *not* one of these — a core command cannot be shadowed. So an
 * argument vector whose root is absent from this set is precisely the case the
 * argv-only guard cannot classify: the write it performs is named somewhere
 * the guard never reads. Such a call is refused, not waved through as a read.
 *
 * Taken from `gh --help` (core, Actions, additional commands and help topics)
 * plus `gh`'s own built-in command aliases (`cs`, `ext`, `at`, …). A genuinely
 * new upstream command is refused until it is listed here — the fail-closed
 * direction, and the refusal says exactly what to do.
 */ export const GH_KNOWN_ROOT_COMMANDS = new Set([
  // Core
  "auth",
  "browse",
  "codespace",
  "cs",
  "discussion",
  "gist",
  "issue",
  "org",
  "pr",
  "project",
  "release",
  "repo",
  "skill",
  "skills",
  // GitHub Actions
  "cache",
  "run",
  "workflow",
  // Additional
  "agent-task",
  "agent-tasks",
  "alias",
  "api",
  "attestation",
  "at",
  "completion",
  "config",
  "copilot",
  "extension",
  "extensions",
  "ext",
  "gpg-key",
  "label",
  "licenses",
  "preview",
  "ruleset",
  "search",
  "secret",
  "ssh-key",
  "status",
  "variable",
  // Help topics and the built-in help/version verbs
  "accessibility",
  "actions",
  "environment",
  "exit-codes",
  "formatting",
  "help",
  "mintty",
  "reference",
  "telemetry",
  "version"
]);
/**
 * The root command of a `gh` argument vector, if it names one.
 *
 * Mirrors the classifier's own reading: the first argument that is not a flag.
 * `undefined` for `gh`, `gh --version` and friends, which name no command.
 *
 * @param args - Arguments passed to the `gh` binary.
 * @returns The root command token, or undefined when none is present.
 */ export function ghRootCommand(args) {
  let i = 0;
  while(args[i]?.startsWith("-"))i++;
  return args[i];
}
/** Flags whose value is one or more comma-separated label names. */ const LABEL_FLAGS = new Set([
  "--add-label",
  "--label",
  "-l"
]);
/** `gh api` field flags whose value may carry `labels[]=<name>`. */ const FIELD_FLAGS = new Set([
  "-f",
  "-F",
  "--field",
  "--raw-field"
]);
/**
 * The subset of field flags whose `@`-prefixed value `gh` reads from a file
 * (`@-` from stdin) — verified against gh 2.97.0 (Issue #93). `-f`/
 * `--raw-field` add a static string and never expand `@`, so a literal
 * `@name` there is a real label name, not a file.
 */ const FIELD_FILE_FLAGS = new Set([
  "-F",
  "--field"
]);
/**
 * Normalise a label name for reserved-label comparison (Issue #195).
 *
 * Trims leading/trailing whitespace then lower-cases. `String.prototype.trim()`
 * already folds ASCII whitespace (space, tab, newline, CR) and Unicode Zs
 * characters (NBSP and friends). This helper also strips the zero-width space
 * (`U+200B`), which `trim()` does not treat as whitespace. Folding more than
 * GitHub's REST API is safe for a denylist: it can only cause a false refusal
 * of a weird-but-legitimate label, never a bypass. Both the argv path
 * ({@link splitLabels} / {@link FORBIDDEN_LABELS} comparison) and the JSON
 * `--input` path ({@link scanBodyForForbiddenLabel}) go through this helper so
 * the two cannot drift.
 */ function normaliseLabelName(name) {
  return name.replaceAll("\u200B", "").trim().toLowerCase();
}
/**
 * Reserved workflow labels the agent subprocess may not apply, normalised for
 * case-insensitive matching.
 *
 * The UNION of two lists, deliberately, because each holds something the other
 * does not (Issue #1422):
 *
 * - `RESERVED_LABELS` (`config_defaults.ts`) is the canonical set the worker
 *   may never self-apply. It is mostly computed from `LABEL_DEFAULTS`, so a
 *   label renamed there stays covered here with no second edit.
 * - `WORKER_FORBIDDEN_LABEL_LITERALS` (`worker_label_guard.ts`) carries
 *   `best-model`, which is NOT in `RESERVED_LABELS`. Deriving from the
 *   canonical set alone — the obvious reading of this defect — would have
 *   silently DROPPED that label from the agent denylist while appearing to
 *   strengthen it.
 *
 * The defect was not one stale list. It was two hand-maintained lists that had
 * drifted in both directions, with only the shorter one reaching the agent
 * guard: `claude`, `help wanted`, `failed`, `failed-once`,
 * `needs-clarification`, `needs-human`, `grill-me` and
 * `needs-failure-detection-repair` were all reserved and none were enforced
 * here. `failed` and `needs-human` gate the fleet's own escalation, so an
 * agent able to apply them could park an unrelated issue out of discovery,
 * and `label_security.ts` could not strip them — it trusts the identity the
 * agent subprocess authenticates as.
 *
 * `label_denylist_union_test.ts` asserts containment in BOTH directions, so
 * neither list can gain an entry this guard misses.
 */ const FORBIDDEN_LABELS = new Set([
  ...RESERVED_LABELS,
  ...WORKER_FORBIDDEN_LABEL_LITERALS
].map((l)=>normaliseLabelName(l)));
/**
 * Split a comma-separated label value into trimmed, non-empty names.
 *
 * Empties (including all-whitespace tokens) are dropped — argv's historical
 * behaviour. The JSON `--input` path must not copy this: a whitespace-only
 * element there is `unreadable` (fail closed). Comparison still uses
 * {@link normaliseLabelName} so the two paths share one normalisation.
 */ function splitLabels(value) {
  return value.split(",").map((s)=>s.trim()).filter((s)=>normaliseLabelName(s).length > 0);
}
/**
 * Label names carried by a `gh api` field value such as `labels[]=x`.
 *
 * An `@`-prefixed value on a `-F`/`--field` flag is read from a file by `gh`,
 * so the label names never reach the argv (Issue #93). Emitting the literal
 * `@path` as a label would be worse than emitting nothing — it would look as
 * if the guard inspected the value when it did not — so return no names and
 * let the `unreadableBody` backstop refuse the command. `expandsAtFile` is
 * false for `-f`/`--raw-field`, where `@literal` really is the label name.
 */ function labelsFromField(field, expandsAtFile) {
  const match = field.match(/^labels(?:\[\])?=([\s\S]*)$/);
  if (!match) return [];
  const value = match[1] ?? "";
  if (expandsAtFile && value.startsWith("@")) return [];
  return splitLabels(value);
}
/**
 * Collect every label name named by a `gh` argument vector.
 *
 * Covers the space form (`--add-label x`), the equals form (`--label=x`), the
 * short form (`-l x`), the attached shorthand form (`-lx`, `-l=x` — pflag
 * spellings normalised by {@link normaliseGhArgs}, Issue #3867),
 * comma-separated lists, and `gh api` label fields. Every occurrence
 * contributes, because `--label` is a pflag string *slice*: repeating it
 * accumulates rather than replaces.
 *
 * @param args - Arguments passed to the `gh` binary.
 * @returns Label names in the order they appear.
 */ export function extractLabelValues(rawArgs) {
  const args = normaliseGhArgs(rawArgs);
  const labels = [];
  for(let i = 0; i < args.length; i++){
    const token = args[i];
    if (token === undefined) continue;
    if (LABEL_FLAGS.has(token)) {
      // pflag takes the following token as the value whatever it looks like.
      const value = args[i + 1];
      if (value !== undefined) {
        labels.push(...splitLabels(value));
        i++;
      }
      continue;
    }
    if (token.startsWith("--add-label=")) {
      labels.push(...splitLabels(token.slice("--add-label=".length)));
      continue;
    }
    if (token.startsWith("--label=")) {
      labels.push(...splitLabels(token.slice("--label=".length)));
      continue;
    }
    if (FIELD_FLAGS.has(token)) {
      const value = args[i + 1];
      if (value !== undefined) {
        labels.push(...labelsFromField(value, FIELD_FILE_FLAGS.has(token)));
        i++;
      }
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0 && FIELD_FLAGS.has(token.slice(0, eq))) {
      labels.push(...labelsFromField(token.slice(eq + 1), FIELD_FILE_FLAGS.has(token.slice(0, eq))));
    }
  }
  return labels;
}
/**
 * `gh label` verbs whose positional argument is a label NAME (Issue #2518).
 *
 * `clone` is deliberately absent: its positional is a
 * `<source-repository>`, never a label name, and it only creates labels the
 * destination lacks — labels absent from the source "will not be deleted or
 * modified", so it can neither rename nor destroy a reserved label. Comparing
 * a repo slug against the denylist would refuse legitimate clones and protect
 * nothing.
 */ const LABEL_DEFINITION_VERBS = new Set([
  "create",
  "edit",
  "delete"
]);
/**
 * Value-taking flags of `gh label create|edit|delete` in separated spelling.
 *
 * Skipping their values is what keeps a *description* that merely mentions a
 * reserved label ( `-d "raise with top-priority"` ) from being read as a
 * definition of one. `-f`/`--force` and `--yes` are boolean and must NOT be
 * listed — skipping a token after them would hide the real positional.
 */ const LABEL_CMD_VALUE_FLAGS = new Set([
  "-c",
  "--color",
  "-d",
  "--description",
  "-R",
  "--repo"
]);
/**
 * Label names a `gh label create|edit|delete` invocation would define, rename
 * to, or destroy (Issue #2518).
 *
 * {@link extractLabelValues} reads flag values only, because that is what
 * `gh issue`/`gh pr` use — but `gh label`'s name is POSITIONAL, so the
 * reserved-label denylist saw an empty list and `gh label delete top-priority`
 * fell through to the write-repo allowlist, which waves a cwd-scoped write
 * through. Deleting or renaming a scheduling label is a strictly worse outcome
 * than the label *application* that denylist was written to stop.
 *
 * Both name-bearing positions are collected: the positional `<name>` and
 * `gh label edit`'s `-n`/`--name` rename target. `normaliseGhArgs` normalises
 * only `R,l,X,f,F`, so the attached `-ntop-priority` / `-n=top-priority`
 * spellings arrive unexpanded and are expanded here rather than by widening
 * that set, which would rewrite unrelated commands (`gh release create -nNotes`).
 * Only index 1 of a shorthand group needs the `-n` treatment: every other
 * shorthand `gh label edit` accepts takes a value, so it would swallow an `n`
 * behind it as part of its own value — exactly as pflag does.
 *
 * @param rawArgs - Arguments passed to the `gh` binary.
 * @returns Candidate label names, in argv order.
 */ function labelDefinitionNames(rawArgs) {
  const args = normaliseGhArgs(rawArgs);
  let i = 0;
  while(args[i]?.startsWith("-"))i++;
  if (args[i] !== "label") return [];
  i++;
  while(args[i]?.startsWith("-"))i++;
  const verb = args[i];
  if (verb === undefined || !LABEL_DEFINITION_VERBS.has(verb)) return [];
  const names = [];
  let endOfFlags = false;
  for(let j = i + 1; j < args.length; j++){
    const token = args[j];
    if (token === undefined) continue;
    if (endOfFlags || !token.startsWith("-") || token === "-") {
      names.push(token);
      continue;
    }
    if (token === "--") {
      endOfFlags = true;
      continue;
    }
    if (token === "-n" || token === "--name") {
      const value = args[j + 1];
      if (value !== undefined) {
        names.push(value);
        j++;
      }
      continue;
    }
    if (token.startsWith("--name=")) {
      names.push(token.slice("--name=".length));
      continue;
    }
    if (token.startsWith("-n") && !token.startsWith("--")) {
      const rest = token.slice(2);
      names.push(rest.startsWith("=") ? rest.slice(1) : rest);
      continue;
    }
    if (LABEL_CMD_VALUE_FLAGS.has(token)) {
      j++;
      continue;
    }
  // An unrecognised flag's separated value may be read as a positional on
  // the next pass. That direction fails closed — a false refusal, never a
  // waved-through definition.
  }
  return names;
}
/** `gh api` label-endpoint body fields that carry a label NAME. */ const LABEL_NAME_FIELDS = new Set([
  "name",
  "new_name"
]);
/**
 * `repos/{owner}/{repo}/labels[/{name}]`, with any origin or leading slash
 * tolerated — the shape `gh api` accepts.
 *
 * Anchored at the end so the issue/PR label *application* sub-resources
 * (`repos/o/r/issues/5/labels`) do not match: those apply a label and are
 * already covered by {@link extractLabelValues}. A leading `/` rather than the
 * string start is accepted so a full URL matches; the cost of that looseness is
 * at worst a false refusal of a path that merely ends this way.
 */ const API_LABEL_ENDPOINT = /(?:^|\/)repos\/[^/]+\/[^/]+\/labels(?:\/([^/?#]*))?\/?$/;
/** REST methods that could define, rename or destroy a label definition. */ const API_LABEL_WRITE_METHODS = new Set([
  "post",
  "patch",
  "put",
  "delete"
]);
/**
 * Values of the named `gh api` body fields (`-f name=x`, `--field=name=x`).
 *
 * An `@`-prefixed value on a `-F`/`--field` flag is read from a file by `gh`
 * and never reaches the argv, so it is skipped here for the same reason
 * {@link labelsFromField} skips it — the `unreadableBody` backstop refuses that
 * command rather than this scan pretending to have read it.
 *
 * @param rawArgs - Arguments passed to the `gh` binary.
 * @param keys - Field names to collect, lower-case.
 * @returns The matching field values, in argv order.
 */ function apiFieldValuesFor(rawArgs, keys) {
  const args = normaliseGhArgs(rawArgs);
  const values = [];
  const take = (field, expandsAtFile)=>{
    const eq = field.indexOf("=");
    if (eq <= 0) return;
    if (!keys.has(field.slice(0, eq).trim().toLowerCase())) return;
    const value = field.slice(eq + 1);
    if (expandsAtFile && value.startsWith("@")) return;
    values.push(value);
  };
  for(let i = 0; i < args.length; i++){
    const token = args[i];
    if (token === undefined) continue;
    if (FIELD_FLAGS.has(token)) {
      const value = args[i + 1];
      if (value !== undefined) {
        take(value, FIELD_FILE_FLAGS.has(token));
        i++;
      }
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0 && FIELD_FLAGS.has(token.slice(0, eq))) {
      take(token.slice(eq + 1), FIELD_FILE_FLAGS.has(token.slice(0, eq)));
    }
  }
  return values;
}
/**
 * Label names a `gh api` call would define, rename to, or destroy (Issue
 * #2518).
 *
 * The REST spelling is the same capability as `gh label delete top-priority`
 * with a different argv, and the guard already treats REST spellings as
 * in-scope elsewhere (`gh api -X PATCH …/issues/N -f state=closed` is refused
 * as a lifecycle change). Closing only the `gh label` route would leave
 * `gh api -X DELETE repos/o/r/labels/top-priority` as a one-line rewrite of the
 * same attack, so both routes share this denylist.
 *
 * Three name-bearing positions: the `{name}` path segment a PATCH or DELETE
 * targets, `name=` on a create, and `new_name=` on a rename. A percent-encoded
 * segment is decoded, and a malformed encoding is compared raw rather than
 * throwing — an undecodable name cannot match the denylist, and the endpoint
 * would not resolve to a reserved label either.
 *
 * @param rawArgs - Arguments passed to the `gh` binary.
 * @param info - Mutation classification for the same argv.
 * @returns Candidate label names, path segment first.
 */ function apiLabelDefinitionNames(rawArgs, info) {
  if (!info.verb.startsWith("api-")) return [];
  if (!API_LABEL_WRITE_METHODS.has(info.verb.slice("api-".length))) return [];
  const match = (info.target ?? "").match(API_LABEL_ENDPOINT);
  if (!match) return [];
  const names = [];
  const segment = match[1];
  if (segment !== undefined && segment !== "") {
    try {
      names.push(decodeURIComponent(segment));
    } catch  {
      names.push(segment);
    }
  }
  names.push(...apiFieldValuesFor(rawArgs, LABEL_NAME_FIELDS));
  return names;
}
/**
 * Label names from a `["a", {"name":"b"}]` array, or `null` if any element is
 * a shape the extractor does not understand (fail closed on the unknown).
 *
 * A string or `{name}` whose {@link normaliseLabelName} form is empty
 * (all-whitespace, including Unicode whitespace the helper folds) is
 * `null` — fail closed, never silently dropped.
 */ function labelNamesFromArray(arr) {
  const names = [];
  for (const el of arr){
    if (typeof el === "string") {
      if (normaliseLabelName(el).length === 0) return null;
      names.push(el);
    } else if (el !== null && typeof el === "object" && typeof el.name === "string") {
      const name = el.name;
      if (normaliseLabelName(name).length === 0) return null;
      names.push(name);
    } else {
      return null;
    }
  }
  return names;
}
/**
 * Scan a `gh api --input` body for reserved workflow labels (Issues #91, #195).
 *
 * Understands the three shapes GitHub's REST API accepts for labels — the bare
 * array `["a"]`, `{"labels": ["a"]}`, and `{"labels": [{"name":"a"}]}` — plus
 * a body carrying no `labels` field at all (an issue create/edit). Anything
 * else — invalid JSON, a non-object/array top level, a `labels` field that is
 * not an array, an array element that is neither a string nor `{name}`, or a
 * string/`{name}` that normalises to empty — is reported `unreadable` so the
 * caller fails closed, never allowed unscanned.
 *
 * Extracted names are compared via {@link normaliseLabelName} against
 * {@link FORBIDDEN_LABELS} — the same helper the argv path uses
 * (`splitLabels` / denylist lookup). Trim, case-fold, and Unicode whitespace
 * folding therefore cannot drift between the two paths. GitHub's REST/GUI
 * trim label names (cli/cli#11898), so a padded reserved label is a real
 * bypass if this path skips the trim.
 */ function scanBodyForForbiddenLabel(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch  {
    return {
      kind: "unreadable"
    };
  }
  let names;
  if (Array.isArray(doc)) {
    names = labelNamesFromArray(doc);
  } else if (doc !== null && typeof doc === "object") {
    const labels = doc.labels;
    if (labels === undefined) {
      names = [];
    } else if (Array.isArray(labels)) {
      names = labelNamesFromArray(labels);
    } else {
      names = null;
    }
  } else {
    return {
      kind: "unreadable"
    };
  }
  if (names === null) return {
    kind: "unreadable"
  };
  const forbidden = names.find((l)=>FORBIDDEN_LABELS.has(normaliseLabelName(l)));
  if (forbidden !== undefined) return {
    kind: "forbidden",
    label: forbidden
  };
  return {
    kind: "clean"
  };
}
/** The #90 fail-closed refusal for an unscannable REST body. */ function unreadableBodyRefusal(verb) {
  return {
    allowed: false,
    marker: "GH_BODY_UNREADABLE",
    reason: `Refused ${verb} from the agent subprocess — the request body ` + `is supplied by \`--input\` and this guard cannot scan it for reserved ` + `workflow labels (stdin, an unreadable path, or a body whose shape it ` + `does not understand). Pass the fields inline with \`-f\`/\`--field\`, ` + `or supply a readable JSON file.`
  };
}
/**
 * Labels the agent legitimately applies to an EXISTING issue (Issue #1422).
 *
 * `needs-human` is the hand-off the prompts prescribe verbatim —
 * `prompts/issue/prompt.md:179` gives the exact `gh issue edit … --add-label
 * needs-human` call, and `prompts/coding_guidelines/prompt.md:531` states that
 * call "keeps working". It is also suppression-only: applying it removes the
 * issue from the work pool, so it can only ever cost the applier throughput
 * and never gain them anything (`isSuppressionOnlyLabel`, PR #1321). It is
 * therefore not a privilege escalation and must not be denied outright — doing
 * so removes the agent's only way to say "a human is needed", which has been
 * reported as a regression before.
 *
 * What #1422 actually describes is narrower: the agent applying such a label
 * to an UNRELATED sibling issue in the claimed repo, parking it out of
 * discovery with nothing downstream able to strip it. So the control is
 * scope, not prohibition.
 */ const AGENT_ESCALATION_LABELS = new Set([
  "needs-human"
]);
/**
 * Whether this forbidden label is the run's own escalation on its own issue.
 *
 * @returns True when the label may proceed despite being on the denylist.
 */ function isPermittedEscalation(label, args, info, ctx) {
  if (!AGENT_ESCALATION_LABELS.has(normaliseLabelName(label))) return false;
  const claim = ctx.claimedIssue;
  // No claim seeded: the run has no "own issue" to scope to, and this is the
  // behaviour that has always applied. Unchanged.
  if (!claim) return true;
  const attempt = classifyIssueLifecycle(args, info);
  if (!attempt) return true;
  // A different repo is the write-repo allowlist's decision, not this one.
  const targetRepo = attempt.repo ?? claim.repo;
  if (!sameRepo(targetRepo, claim.repo)) return true;
  // No issue number is `gh`'s cwd form; during a coding run the clone is the
  // claimed repo, so it is treated as naming the claim — as the lifecycle
  // guard above already does.
  if (attempt.issueNumber === undefined) return true;
  return attempt.issueNumber === claim.issueNumber;
}
/** Case-insensitive `owner/repo` comparison. */ function sameRepo(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
/**
 * Refuse an issue-lifecycle change in the claimed repo (Issue #222).
 *
 * The implementing agent decides what the *code* should be; it does not decide
 * that an issue is closed, reopened, moved or locked. A run that has seeded a
 * claim therefore refuses those verbs for every issue in its claimed repo —
 * not only the claimed issue, because closing a "duplicate" or reopening a
 * sibling is the same lifecycle call the agent is not making — unless the run
 * explicitly permits the verb (`allowedVerbs`, `edit` by default so the
 * `needs-human` escalation the prompts prescribe keeps working).
 *
 * A command naming a *different* repo is left to the write-repo allowlist,
 * which refuses it already. A command naming no repo is `gh`'s cwd form, and
 * during a coding run the clone is the claimed repo — so it is treated as
 * naming the claim, the fail-closed direction.
 */ function refuseClaimedIssueLifecycle(args, info, ctx) {
  const claim = ctx.claimedIssue;
  if (!claim) return undefined;
  const attempt = classifyIssueLifecycle(args, info);
  if (!attempt) return undefined;
  const allowed = new Set(claim.allowedVerbs.map((v)=>v.trim().toLowerCase()));
  if (allowed.has(attempt.verb)) return undefined;
  const targetRepo = attempt.repo ?? claim.repo;
  if (!sameRepo(targetRepo, claim.repo)) return undefined;
  const target = attempt.issueNumber === undefined ? targetRepo : `${targetRepo}#${attempt.issueNumber}`;
  const isClaim = attempt.issueNumber === claim.issueNumber;
  return {
    allowed: false,
    marker: "ISSUE_LIFECYCLE_REFUSED",
    reason: `Refused 'gh ${info.verb}' on ${target} from the agent ` + `subprocess — issue lifecycle changes (` + `${ISSUE_LIFECYCLE_VERBS.join(", ")}) on ${claim.repo} are the ` + `worker's or a human's decision, not the implementing agent's` + (isClaim ? ` (this run's claimed issue)` : "") + `. Post your findings as a comment instead: a run that is blocked on ` + `another issue should say so in a section beginning "## Blocked:" and ` + `name the dependency as "Depends on owner/repo#N", and the worker ` + `defers the issue rather than closing it.`
  };
}
/**
 * Refuse a PR-lifecycle decision in the claimed repo (Issue #1462).
 *
 * The sibling of {@link refuseClaimedIssueLifecycle}, and the same principle:
 * the agent decides what the *code* should be, not that the pull request
 * carrying it is merged, closed, reopened, marked ready or approved. Those are
 * the worker's calls, and the worker makes them through `direct_merge.ts` —
 * inside its own Deno process, which never traverses this guard — where CI
 * freshness and the default-branch human-approval gate are applied. A
 * prompt-injected agent running `gh pr merge` skips all of it.
 *
 * Scoped exactly as the issue-lifecycle refusal is, and for the same reasons:
 * a command naming a *different* repo is left to the write-repo allowlist,
 * which refuses it already, and a command naming no repo is `gh`'s cwd form,
 * which during a coding run is the claimed repo — so it is treated as naming
 * the claim, the fail-closed direction.
 *
 * `ClaimedIssue.allowedVerbs` is deliberately NOT consulted. It is an
 * *issue*-verb allowance — the shim spells it `--allow-issue-verb`, and it
 * defaults to `edit` so the `needs-human` escalation keeps working. Reading it
 * here would mean a future route that permitted `close` on its planning issue
 * silently permitted `gh pr close` too. No route grants a PR verb, so there is
 * nothing to read.
 */ function refuseClaimedPrLifecycle(args, info, ctx) {
  const claim = ctx.claimedIssue;
  if (!claim) return undefined;
  const attempt = classifyPrLifecycle(args, info);
  if (!attempt) return undefined;
  const targetRepo = attempt.repo ?? claim.repo;
  if (!sameRepo(targetRepo, claim.repo)) return undefined;
  const target = attempt.prNumber === undefined ? targetRepo : `${targetRepo}#${attempt.prNumber}`;
  return {
    allowed: false,
    marker: "PR_LIFECYCLE_REFUSED",
    reason: `Refused 'gh ${info.verb}' on ${target} from the agent ` + `subprocess — pull request lifecycle decisions (` + `${PR_LIFECYCLE_VERBS.join(", ")}) on ${claim.repo} are the worker's ` + `or a human's, not the implementing agent's. The worker merges through ` + `its own path, which re-checks CI status, branch freshness and the ` + `default-branch approval gate; a merge issued here has none of them. ` + `'gh pr create', 'gh pr view', 'gh pr list', 'gh pr comment' and ` + `'gh pr edit' (other than ` + `--base) are unaffected. If the ` + `PR should not land, say so in a comment rather than closing it.`
  };
}
/**
 * Decide whether one agent `gh` invocation may proceed.
 *
 * @param args - Arguments about to be passed to the `gh` binary.
 * @param ctx - The run's write-repo allowlist state.
 * @returns The verdict; `allowed: false` carries a marker and a reason.
 */ export function evaluateGhCommand(rawArgs, ctx) {
  // Issue #3568: every check below reads one canonical spelling of the
  // command — a `gh api` call with its flags after the root, an explicit
  // method and its endpoint as GitHub routes it — so a rule written against
  // one spelling holds for every spelling gh and GitHub treat the same.
  const args = canonicaliseGhArgs(rawArgs);
  const info = classifyGhMutation(args);
  if (info) {
    // Every forbidden label is checked, not just the first: a command adding
    // `needs-human,failed` must still be refused for `failed` even though the
    // escalation label beside it is permitted (Issue #1422).
    const forbidden = extractLabelValues(args).filter((l)=>FORBIDDEN_LABELS.has(normaliseLabelName(l))).find((l)=>!isPermittedEscalation(l, args, info, ctx));
    if (forbidden !== undefined) {
      return {
        allowed: false,
        marker: "WORKER_LABEL_REFUSED",
        reason: `label=${forbidden} verb=${info.verb} ` + `caller=agent-subprocess reason=reserved_workflow_label`
      };
    }
    // Issue #2518: the same denylist on the label DEFINITION path — the
    // `gh label` positional and the `gh api …/labels` REST spelling of it.
    // `isPermittedEscalation` deliberately does not apply: applying
    // `needs-human` to the run's own issue is the sanctioned ask for a human,
    // but deleting or renaming the label itself withdraws that route from
    // every later run.
    const defined = [
      ...labelDefinitionNames(args),
      ...apiLabelDefinitionNames(args, info)
    ].find((l)=>FORBIDDEN_LABELS.has(normaliseLabelName(l)));
    if (defined !== undefined) {
      return {
        allowed: false,
        marker: "WORKER_LABEL_REFUSED",
        reason: `label=${defined} verb=${info.verb} ` + `caller=agent-subprocess reason=reserved_workflow_label_definition`
      };
    }
    const lifecycleRefusal = refuseClaimedIssueLifecycle(args, info, ctx);
    if (lifecycleRefusal) return lifecycleRefusal;
    // Issue #1462: the same reasoning one step further along the workflow.
    // `classifyIssueLifecycle` returns `undefined` for a PR operation by
    // design, so `gh pr merge` on the claimed repo reached the write-repo
    // allowlist — which allows it, the claimed repo being on the allowlist by
    // construction — and merged the agent's own PR with none of the checks
    // `direct_merge.ts` applies.
    const prRefusal = refuseClaimedPrLifecycle(args, info, ctx);
    if (prRefusal) return prRefusal;
    // Issue #3433: retargeting a PR is the worker's call. Moving a
    // milestone-fix or milestone child PR to the default branch bypasses the
    // milestone's final review. Pure guard, so it cannot read the PR's
    // head/base: every base change from the agent is refused.
    if (classifyPrBaseChange(args, ctx.readBodyFile)) {
      return {
        allowed: false,
        marker: "PR_BASE_CHANGE_REFUSED",
        reason: `Refused 'gh ${info.verb}' from the agent subprocess — ` + `changing a pull request's base branch is the worker's call: ` + `moving a milestone-fix or milestone child PR to the default ` + `branch bypasses the milestone's final review (Issue #3433). ` + `'gh pr edit' for the title, body or labels is unaffected; a ` + `GraphQL request that may carry an 'updatePullRequest' mutation, or ` + `whose document cannot be read, is refused whole, since the ` + `mutation can carry the base. If a ` + `PR's base looks wrong, say so in a comment.`
      };
    }
    // Issue #11/#90/#91: a REST mutation whose body is supplied by `--input`
    // (or an `@file`-sourced query) is argv-invisible, so `extractLabelValues`
    // above saw nothing to reject — a prompt-injected agent could hide a
    // reserved label in the file. #90 failed closed on every such body; #91
    // restores the legitimate case: when the argv names a *readable file* and
    // a reader is supplied, read it and scan for reserved labels. Only a body
    // that is successfully parsed and fully understood is allowed through;
    // stdin (`--input -`), a `@file` field value, an unreadable path, invalid
    // JSON, or an unrecognised shape all carry no readable `bodyFilePath` (or
    // fail the scan) and stay refused. This sits WITH the reserved-label
    // check, before the `ctx.active` early return, so the backstop is as
    // unconditional as the denylist it guards. TOCTOU: the agent could rewrite
    // the file between this read and `gh`'s — not closable from a PATH shim,
    // and no worse than #90; the argv-visible path has no such window.
    if (info.unreadableBody) {
      if (info.bodyFilePath !== undefined && ctx.readBodyFile) {
        let text;
        try {
          text = ctx.readBodyFile(info.bodyFilePath);
        } catch  {
          return unreadableBodyRefusal(info.verb);
        }
        const scan = scanBodyForForbiddenLabel(text);
        if (scan.kind === "forbidden") {
          return {
            allowed: false,
            marker: "WORKER_LABEL_REFUSED",
            reason: `label=${scan.label} verb=${info.verb} ` + `caller=agent-subprocess ` + `reason=reserved_workflow_label_in_input_body`
          };
        }
        if (scan.kind === "unreadable") return unreadableBodyRefusal(info.verb);
      // scan.kind === "clean": the body carries no reserved label — fall
      // through to the write-repo allowlist checks below, which still apply.
      } else {
        return unreadableBodyRefusal(info.verb);
      }
    }
  }
  // Issue #187: a command that rewrites the local `gh` installation —
  // credentials, config, aliases, extensions — changes nothing on GitHub, so
  // `classifyGhMutation` reports no repo write and it reached here as a
  // "read" (or, since Issue #1396, as a `non-repo` extension mutation the
  // write-repo allowlist has nothing to compare).
  // It is not one: the wrapper pins `GH_CONFIG_DIR` to the worker's own
  // persistent identity directory, so a credential written there re-points
  // every later `gh` call, the worker's included. Refused unconditionally,
  // like the unknown-root check below — credentials are provisioned once by
  // `setup.sh` and consumed read-only, so no run has a legitimate use for one.
  // Ahead of that check so the more specific refusal wins when both apply.
  const localState = classifyGhLocalStateChange(args);
  if (localState) {
    return {
      allowed: false,
      marker: "GH_LOCAL_STATE_REFUSED",
      reason: `Refused 'gh ${localState.root} ${localState.verb}' from the ` + `agent subprocess — it rewrites ${localState.target} of this run's ` + `gh installation, which every later gh call (the worker's included) ` + `then uses. Credentials are provisioned non-interactively by setup.sh ` + `and consumed read-only; the read verbs ('gh auth status', ` + `'gh config get', 'gh extension list') are unaffected.`
    };
  }
  // Issue #1371: the guard classifies argv, so everything above holds only
  // while the guarded channel is the agent's only route to GitHub. `gh auth
  // token` and `gh auth status --show-token` print the run's credential, which
  // is the one value that makes every later call unguarded — the guard was
  // handing out its own bypass on request. They change nothing, on GitHub or
  // locally, so neither the mutation classifier nor the local-state check saw
  // them. Refused unconditionally: nothing in a run needs to *see* the token
  // to use it, and plain `gh auth status` stays allowed for the health checks.
  const disclosure = classifyGhCredentialDisclosure(args);
  if (disclosure) {
    return {
      allowed: false,
      marker: "GH_CREDENTIAL_DISCLOSURE_REFUSED",
      reason: `Refused 'gh ${disclosure.root} ${disclosure.verb}' from the ` + `agent subprocess — it prints ${disclosure.disclosed} in plaintext, ` + `and a credential the agent holds directly is one this guard can no ` + `longer mediate. gh authenticates itself from the pinned ` + `GH_CONFIG_DIR, so no run needs to read the token; plain ` + `'gh auth status' is unaffected.`
    };
  }
  // Issue #3866: a root the real binary does not implement is expanded from
  // the `gh` config aliases (or an extension) before it runs, so the write it
  // performs appears nowhere in this argv. Fail closed — including when the
  // allowlist is inert, because the reserved-label check above is unconditional
  // and an alias hides its labels just as effectively as its repo.
  const root = ghRootCommand(args);
  if (root !== undefined && !GH_KNOWN_ROOT_COMMANDS.has(root)) {
    return {
      allowed: false,
      marker: "GH_UNKNOWN_COMMAND",
      reason: `Refused 'gh ${root}' from the agent subprocess — not a known ` + `gh command, so it is an alias or an extension whose real command ` + `this guard cannot see. Run the underlying gh command directly.`
    };
  }
  // Reads change nothing on GitHub and are never the exfiltration sink — the
  // worker's own chokepoint takes the same view.
  if (!info) return {
    allowed: true
  };
  if (!ctx.active) return {
    allowed: true
  };
  // Issue #3703: fail closed on an undeterminable target — a GraphQL
  // mutation, a `gh gist create`, an endpoint that names no repo. Mirrors
  // `enforceGhWriteAllowlist`.
  if (info.scope === "unknown") {
    return {
      allowed: false,
      marker: "WRITE_TARGET_UNDETERMINABLE",
      reason: `Refused ${info.verb} from the agent subprocess — target repo ` + `not derivable${info.target ? ` (${info.target})` : ""}, ` + `failing closed`
    };
  }
  if (!info.repo) return {
    allowed: true
  };
  const allowed = new Set(ctx.allowedRepos.map((r)=>r.trim().toLowerCase()).filter((r)=>r.length > 0));
  if (allowed.has(info.repo.trim().toLowerCase())) return {
    allowed: true
  };
  return {
    allowed: false,
    marker: "WRITE_REPO_BLOCKED",
    reason: `Refused ${info.verb} to ${info.repo} from the agent subprocess ` + `— not on run allowlist [${[
      ...allowed
    ].sort().join(", ")}]`
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9ndWFyZF9kZWNpc2lvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIERlY2lzaW9uIGxvZ2ljIGZvciB0aGUgYWdlbnQtc2lkZSBgZ2hgIGd1YXJkIChJc3N1ZSAjMzY0MykuXG4gKlxuICogVGhlIHdvcmtlcidzIGVncmVzcyBjb250cm9scyDigJQgdGhlIHBlci1ydW4gd3JpdGUtcmVwbyBhbGxvd2xpc3RcbiAqIChgd3JpdGVfcmVwb19hbGxvd2xpc3QudHNgKSBhbmQgdGhlIHdvcmtlciBsYWJlbCBndWFyZFxuICogKGB3b3JrZXJfbGFiZWxfZ3VhcmQudHNgKSDigJQgZW5mb3JjZSBpbnNpZGUgdGhlIHdvcmtlcidzIG93biBEZW5vIHByb2Nlc3MsXG4gKiBhdCBgcnVuR2hDb21tYW5kUmF3YC4gVGhlIHBhcnR5IHRob3NlIGNvbnRyb2xzIG5hbWUgYXMgdGhlIGluamVjdGVkIG9uZSBpc1xuICogdGhlICoqYWdlbnQgc3VicHJvY2VzcyoqLCB3aGljaCBydW5zIHVucmVzdHJpY3RlZCBCYXNoIHdpdGggYW4gaW5oZXJpdGVkXG4gKiBgR0hfVE9LRU5gOyBpdHMgb3duIGBnaGAgY2FsbHMgbmV2ZXIgdHJhdmVyc2UgYHJ1bkdoQ29tbWFuZFJhd2AsIHNvIG5laXRoZXJcbiAqIGNvbnRyb2wgc2F3IHRoZW0uXG4gKlxuICogVGhpcyBtb2R1bGUgaXMgdGhlIHNpbmdsZSBkZWNpc2lvbiB0aGUgYGdoYCBzaGltIChgZ2hfZ3VhcmRfc2hpbS50c2ApXG4gKiByZS1lbnRlcnMgZm9yIGV2ZXJ5IGFnZW50IGBnaGAgaW52b2NhdGlvbiwgYmVmb3JlIHRoZSByZWFsIGJpbmFyeSBydW5zLiBJdFxuICogaXMgcHVyZSDigJQgdGhlIGNhbGxlciBzdXBwbGllcyB0aGUgcnVuJ3MgYWxsb3dsaXN0IHN0YXRlIOKAlCBzbyBpdCBjYW4gYmVcbiAqIGV2YWx1YXRlZCBpbiBhIHNob3J0LWxpdmVkIGNoaWxkIHByb2Nlc3Mgd2l0aCBubyBwZXJtaXNzaW9ucyBhdCBhbGwuXG4gKlxuICogU2l4IGNoZWNrcywgaW4gb3JkZXI6XG4gKiAgIDEuICoqUmVzZXJ2ZWQgd29ya2Zsb3cgbGFiZWxzLioqIEEgKm11dGF0aW9uKiB0aGF0IGFkZHMgYHRvcC1wcmlvcml0eWAsXG4gKiAgICAgIGB3b3JrLW9uYCwgYHF1ZXN0aW9uYCwg4oCmIGlzIHJlZnVzZWQuIFRoZSBjaGVjayBpcyBhIGRlbnlsaXN0IG9mIHRoZVxuICogICAgICByZXNlcnZlZCBuYW1lcyAoYFdPUktFUl9GT1JCSURERU5fTEFCRUxfTElURVJBTFNgKSwgbm90IHRoZSB3b3JrZXInc1xuICogICAgICBwb3NpdGl2ZSBhbGxvd2xpc3QsIGJlY2F1c2UgdGhlIGFnZW50J3MgbGVnaXRpbWF0ZSBsYWJlbCBzdXJmYWNlIGlzXG4gKiAgICAgIGdlbnVpbmVseSB3aWRlciB0aGFuIHRoZSB3b3JrZXIncyBlbnVtZXJhYmxlIGNhbGwgc2l0ZXMgKHRoZSBzY2FuXG4gKiAgICAgIHRlbXBsYXRlcyBmaWxlIGZpbmRpbmdzIHdpdGggY29udGVudCBsYWJlbHMgc3VjaCBhcyBgY29uZmlkZW5jZTpoaWdoYCkuXG4gKiAgICAgIFJlYWRzIChgZ2ggaXNzdWUgbGlzdCAtLWxhYmVsIHdvcmstb25gKSBhcmUgdW50b3VjaGVkLlxuICogICAyLiAqKlJlY29nbmlzZWQgcm9vdCBjb21tYW5kKiogKElzc3VlICMzODY2KS4gVGhlIGd1YXJkIGNsYXNzaWZpZXMgdGhlXG4gKiAgICAgICpwcmUtZXhwYW5zaW9uKiBhcmd2LCBidXQgdGhlIHJlYWwgYmluYXJ5IGV4cGFuZHMgYSBjb25maWcgYWxpYXNcbiAqICAgICAgKGB+Ly5jb25maWcvZ2gvY29uZmlnLnltbGApIG9yIGhhbmRzIGFuIHVua25vd24gbmFtZSB0byBhbiBleHRlbnNpb24g4oCUXG4gKiAgICAgIHdoYXRldmVyIHRoZSBhbGlhcyBuYW1lcyBpcyBhIHdyaXRlIHRoZSBndWFyZCBuZXZlciBzYXcuIEEgcm9vdCB0aGVcbiAqICAgICAgZ3VhcmQgZG9lcyBub3QgcmVjb2duaXNlIGFzIGEgZ2VudWluZSBgZ2hgIGNvbW1hbmQgaXMgdGhlcmVmb3JlXG4gKiAgICAgIHJlZnVzZWQgcmF0aGVyIHRoYW4gY2xhc3NpZmllZCBhcyBhIHJlYWQuXG4gKiAgIDMuICoqTG9jYWwgYGdoYCBzdGF0ZSoqIChJc3N1ZSAjMTg3KS4gYGdoIGF1dGggbG9naW58c3dpdGNofHNldHVwLWdpdGAsXG4gKiAgICAgIGBnaCBjb25maWcgc2V0YCwgYGdoIGFsaWFzIHNldGAgYW5kIGBnaCBleHRlbnNpb24gaW5zdGFsbGAgcmV3cml0ZSB0aGVcbiAqICAgICAgcGlubmVkIGBHSF9DT05GSUdfRElSYCByYXRoZXIgdGhhbiBhbnl0aGluZyBvbiBHaXRIdWIsIHNvIHRoZSBtdXRhdGlvblxuICogICAgICBjbGFzc2lmaWVyIHJlcG9ydGVkIG5vIG11dGF0aW9uIGFuZCB0aGV5IHBhc3NlZCBhcyByZWFkcy4gVGhleSBhcmVcbiAqICAgICAgcmVmdXNlZCB1bmNvbmRpdGlvbmFsbHkg4oCUIHNlZSBgZ2hfbG9jYWxfc3RhdGVfZ3VhcmQudHNgLlxuICogICA0LiAqKkNyZWRlbnRpYWwgZGlzY2xvc3VyZSoqIChJc3N1ZSAjMTM3MSkuIGBnaCBhdXRoIHRva2VuYCBhbmRcbiAqICAgICAgYGdoIGF1dGggc3RhdHVzIC0tc2hvdy10b2tlbmAgY2hhbmdlIG5vdGhpbmcsIHNvIHRoZXkgcGFzc2VkIGFzXG4gKiAgICAgIHJlYWRzIOKAlCBidXQgdGhleSBwcmludCB0aGUgcnVuJ3MgR2l0SHViIHRva2VuLCBhbmQgYW4gYWdlbnQgaG9sZGluZ1xuICogICAgICBpdCBjYW4gY2FsbCB0aGUgUkVTVCBBUEkgZGlyZWN0bHksIHdoZXJlIG5vbmUgb2YgdGhlIGFib3ZlIGFwcGxpZXMuXG4gKiAgICAgIFJlZnVzZWQgdW5jb25kaXRpb25hbGx5IOKAlCBzZWUgYGdoX2NyZWRlbnRpYWxfZGlzY2xvc3VyZV9ndWFyZC50c2AuXG4gKiAgIDUuICoqUFIgYmFzZSBjaGFuZ2UqKiAoSXNzdWUgIzM0MzMpLiBgZ2ggcHIgZWRpdCAtLWJhc2VgIGFuZCB0aGUgUkVTVFxuICogICAgICBgUEFUQ0hgL2BQT1NUIOKApi9wdWxscy9OYCB3aXRoIGBiYXNlYCBhcmUgcmVmdXNlZCB1bmNvbmRpdGlvbmFsbHkgKGFsb25nc2lkZVxuICogICAgICB0aGUgUFItbGlmZWN5Y2xlIHJlZnVzYWwpOiBtb3ZpbmcgYSBtaWxlc3RvbmUgUFIgdG8gdGhlIGRlZmF1bHQgYnJhbmNoXG4gKiAgICAgIHNraXBzIHRoZSBtaWxlc3RvbmUncyBmaW5hbCByZXZpZXcuXG4gKiAgIDYuICoqV3JpdGUtcmVwbyBhbGxvd2xpc3QuKiogTWlycm9ycyBgZW5mb3JjZUdoV3JpdGVBbGxvd2xpc3RgOiBpbmVydFxuICogICAgICB1bnRpbCB0aGUgcnVuIHNlZWRzIGFuIGFsbG93bGlzdCwgYSBuby1vcCBmb3IgcmVhZHMgYW5kIGZvciBjd2QtcmVwb1xuICogICAgICB3cml0ZXMgd2l0aCBubyBleHBsaWNpdCByZXBvLCBhbmQgYSByZWZ1c2FsIGZvciBhIG11dGF0aW9uIHRoYXRcbiAqICAgICAgZXhwbGljaXRseSBuYW1lcyBhbiBvZmYtYWxsb3dsaXN0IHJlcG8uXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHtcbiAgY2xhc3NpZnlHaE11dGF0aW9uLFxuICB0eXBlIE11dGF0aW9uSW5mbyxcbn0gZnJvbSBcIi4vYXVkaXRfbXV0YXRpb25fY2xhc3NpZmllci50c1wiO1xuaW1wb3J0IHsgbm9ybWFsaXNlR2hBcmdzIH0gZnJvbSBcIi4vZ2hfZmxhZ19wYXJzZXIudHNcIjtcbmltcG9ydCB7IFdPUktFUl9GT1JCSURERU5fTEFCRUxfTElURVJBTFMgfSBmcm9tIFwiLi93b3JrZXJfbGFiZWxfZ3VhcmQudHNcIjtcbmltcG9ydCB7IFJFU0VSVkVEX0xBQkVMUyB9IGZyb20gXCIuL2NvbmZpZ19kZWZhdWx0cy50c1wiO1xuaW1wb3J0IHtcbiAgY2xhc3NpZnlJc3N1ZUxpZmVjeWNsZSxcbiAgSVNTVUVfTElGRUNZQ0xFX1ZFUkJTLFxufSBmcm9tIFwiLi9naF9pc3N1ZV9saWZlY3ljbGUudHNcIjtcbmltcG9ydCB7IGNsYXNzaWZ5UHJMaWZlY3ljbGUsIFBSX0xJRkVDWUNMRV9WRVJCUyB9IGZyb20gXCIuL2doX3ByX2xpZmVjeWNsZS50c1wiO1xuaW1wb3J0IHsgY2Fub25pY2FsaXNlR2hBcmdzIH0gZnJvbSBcIi4vZ2hfYXJndl9jYW5vbmljYWwudHNcIjtcbmltcG9ydCB7IGNsYXNzaWZ5UHJCYXNlQ2hhbmdlIH0gZnJvbSBcIi4vcHJfYmFzZV9jaGFuZ2VfZ3VhcmQudHNcIjtcbmltcG9ydCB7IGNsYXNzaWZ5R2hDcmVkZW50aWFsRGlzY2xvc3VyZSB9IGZyb20gXCIuL2doX2NyZWRlbnRpYWxfZGlzY2xvc3VyZV9ndWFyZC50c1wiO1xuaW1wb3J0IHsgY2xhc3NpZnlHaExvY2FsU3RhdGVDaGFuZ2UgfSBmcm9tIFwiLi9naF9sb2NhbF9zdGF0ZV9ndWFyZC50c1wiO1xuaW1wb3J0IHR5cGUgeyBDbGFpbWVkSXNzdWUgfSBmcm9tIFwiLi9jbGFpbWVkX2lzc3VlX2d1YXJkLnRzXCI7XG5pbXBvcnQgdHlwZSB7IEJvZHlGaWxlUmVhZGVyIH0gZnJvbSBcIi4vZ2hfYm9keV9yZWRhY3Rpb24udHNcIjtcblxuLyoqIFRoZSBjdXJyZW50IHJ1bidzIGVncmVzcyBzdGF0ZSwgYXMgcGFzc2VkIHRvIHRoZSBndWFyZCBjaGlsZCBwcm9jZXNzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBHaEd1YXJkQ29udGV4dCB7XG4gIC8qKiBXaGV0aGVyIHRoZSBydW4gc2VlZGVkIGEgd3JpdGUtcmVwbyBhbGxvd2xpc3QgKGluZXJ0IHdoZW4gZmFsc2UpLiAqL1xuICBhY3RpdmU6IGJvb2xlYW47XG4gIC8qKiBgb3duZXIvcmVwb2Agc2x1Z3MgdGhlIHJ1biBtYXkgd3JpdGUgdG8uICovXG4gIGFsbG93ZWRSZXBvczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKlxuICAgKiBUaGUgaXNzdWUgdGhpcyBydW4gY2xhaW1lZCwgd2hlbiBpdCBzZWVkZWQgb25lIChJc3N1ZSAjMjIyKS5cbiAgICpcbiAgICogUHJlc2VudCDihpIgaXNzdWUtbGlmZWN5Y2xlIHZlcmJzIChgY2xvc2VgLCBgcmVvcGVuYCwgYGRlbGV0ZWAsIOKApikgYXJlXG4gICAqIHJlZnVzZWQgZm9yIGV2ZXJ5IGlzc3VlIGluIHRoZSBjbGFpbWVkIHJlcG8gdW5sZXNzIHRoZSB2ZXJiIGlzIG9uXG4gICAqIHtAbGluayBDbGFpbWVkSXNzdWUuYWxsb3dlZFZlcmJzfS4gQWJzZW50IOKGkiBpbmVydCwgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAqL1xuICBjbGFpbWVkSXNzdWU/OiBDbGFpbWVkSXNzdWU7XG4gIC8qKlxuICAgKiBGaWxlc3lzdGVtIHJlYWRlciBmb3IgYSBgLS1pbnB1dCA8ZmlsZT5gIGJvZHkgKElzc3VlICM5MSkuIEluamVjdGVkIHJhdGhlclxuICAgKiB0aGFuIGNhbGxlZCBkaXJlY3RseSBzbyB0aGlzIG1vZHVsZSBzdGF5cyBwdXJlIOKAlCBpdCBjYW4gcnVuIGluIGEgY2hpbGRcbiAgICogcHJvY2VzcyB3aXRoIG5vIGAtLWFsbG93LXJlYWRgLCBhbmQgYSBjYWxsZXIgd2l0aCBubyByZWFkZXIgKHRoZSBzYWZlXG4gICAqIGRlZmF1bHQpIHNpbXBseSBmYWlscyBjbG9zZWQgb24gZXZlcnkgdW5yZWFkYWJsZSBib2R5LCBtYXRjaGluZyAjOTAuXG4gICAqIGBnaF9ndWFyZF9jbGkudHNgIHN1cHBsaWVzIGBkZW5vQm9keUZpbGVSZWFkZXJgLlxuICAgKi9cbiAgcmVhZEJvZHlGaWxlPzogQm9keUZpbGVSZWFkZXI7XG59XG5cbi8qKiBXaGljaCBjb250cm9sIHJlZnVzZWQgdGhlIGNvbW1hbmQg4oCUIG1hdGNoZXMgdGhlIHdvcmtlcidzIGxvZyBtYXJrZXJzLiAqL1xuZXhwb3J0IHR5cGUgR2hHdWFyZE1hcmtlciA9XG4gIHwgXCJXUklURV9SRVBPX0JMT0NLRURcIlxuICB8IFwiV1JJVEVfVEFSR0VUX1VOREVURVJNSU5BQkxFXCJcbiAgfCBcIldPUktFUl9MQUJFTF9SRUZVU0VEXCJcbiAgfCBcIkdIX0JPRFlfVU5SRUFEQUJMRVwiXG4gIHwgXCJHSF9VTktOT1dOX0NPTU1BTkRcIlxuICB8IFwiR0hfTE9DQUxfU1RBVEVfUkVGVVNFRFwiXG4gIHwgXCJHSF9DUkVERU5USUFMX0RJU0NMT1NVUkVfUkVGVVNFRFwiXG4gIHwgXCJJU1NVRV9MSUZFQ1lDTEVfUkVGVVNFRFwiXG4gIHwgXCJQUl9MSUZFQ1lDTEVfUkVGVVNFRFwiXG4gIHwgXCJQUl9CQVNFX0NIQU5HRV9SRUZVU0VEXCI7XG5cbi8qKiBUaGUgZ3VhcmQncyB2ZXJkaWN0IGZvciBvbmUgYGdoYCBhcmd1bWVudCB2ZWN0b3IuICovXG5leHBvcnQgaW50ZXJmYWNlIEdoR3VhcmREZWNpc2lvbiB7XG4gIC8qKiBXaGV0aGVyIHRoZSBjb21tYW5kIG1heSBwcm9jZWVkIHRvIHRoZSByZWFsIGBnaGAgYmluYXJ5LiAqL1xuICBhbGxvd2VkOiBib29sZWFuO1xuICAvKiogV2hpY2ggY29udHJvbCByZWZ1c2VkIGl0LCB3aGVuIHJlZnVzZWQuICovXG4gIG1hcmtlcj86IEdoR3VhcmRNYXJrZXI7XG4gIC8qKiBMb2ctcmVhZHkgZXhwbGFuYXRpb24gb2YgdGhlIHJlZnVzYWwuICovXG4gIHJlYXNvbj86IHN0cmluZztcbn1cblxuLyoqXG4gKiBSb290IGNvbW1hbmRzIHRoZSByZWFsIGBnaGAgYmluYXJ5IGltcGxlbWVudHMgaXRzZWxmIChJc3N1ZSAjMzg2NikuXG4gKlxuICogYGdoYCBvbmx5IGV4cGFuZHMgYSBjb25maWcgYWxpYXMsIG9yIGRpc3BhdGNoZXMgdG8gYW4gZXh0ZW5zaW9uLCBmb3IgYSBuYW1lXG4gKiB0aGF0IGlzICpub3QqIG9uZSBvZiB0aGVzZSDigJQgYSBjb3JlIGNvbW1hbmQgY2Fubm90IGJlIHNoYWRvd2VkLiBTbyBhblxuICogYXJndW1lbnQgdmVjdG9yIHdob3NlIHJvb3QgaXMgYWJzZW50IGZyb20gdGhpcyBzZXQgaXMgcHJlY2lzZWx5IHRoZSBjYXNlIHRoZVxuICogYXJndi1vbmx5IGd1YXJkIGNhbm5vdCBjbGFzc2lmeTogdGhlIHdyaXRlIGl0IHBlcmZvcm1zIGlzIG5hbWVkIHNvbWV3aGVyZVxuICogdGhlIGd1YXJkIG5ldmVyIHJlYWRzLiBTdWNoIGEgY2FsbCBpcyByZWZ1c2VkLCBub3Qgd2F2ZWQgdGhyb3VnaCBhcyBhIHJlYWQuXG4gKlxuICogVGFrZW4gZnJvbSBgZ2ggLS1oZWxwYCAoY29yZSwgQWN0aW9ucywgYWRkaXRpb25hbCBjb21tYW5kcyBhbmQgaGVscCB0b3BpY3MpXG4gKiBwbHVzIGBnaGAncyBvd24gYnVpbHQtaW4gY29tbWFuZCBhbGlhc2VzIChgY3NgLCBgZXh0YCwgYGF0YCwg4oCmKS4gQSBnZW51aW5lbHlcbiAqIG5ldyB1cHN0cmVhbSBjb21tYW5kIGlzIHJlZnVzZWQgdW50aWwgaXQgaXMgbGlzdGVkIGhlcmUg4oCUIHRoZSBmYWlsLWNsb3NlZFxuICogZGlyZWN0aW9uLCBhbmQgdGhlIHJlZnVzYWwgc2F5cyBleGFjdGx5IHdoYXQgdG8gZG8uXG4gKi9cbmV4cG9ydCBjb25zdCBHSF9LTk9XTl9ST09UX0NPTU1BTkRTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIC8vIENvcmVcbiAgXCJhdXRoXCIsXG4gIFwiYnJvd3NlXCIsXG4gIFwiY29kZXNwYWNlXCIsXG4gIFwiY3NcIixcbiAgXCJkaXNjdXNzaW9uXCIsXG4gIFwiZ2lzdFwiLFxuICBcImlzc3VlXCIsXG4gIFwib3JnXCIsXG4gIFwicHJcIixcbiAgXCJwcm9qZWN0XCIsXG4gIFwicmVsZWFzZVwiLFxuICBcInJlcG9cIixcbiAgXCJza2lsbFwiLFxuICBcInNraWxsc1wiLFxuICAvLyBHaXRIdWIgQWN0aW9uc1xuICBcImNhY2hlXCIsXG4gIFwicnVuXCIsXG4gIFwid29ya2Zsb3dcIixcbiAgLy8gQWRkaXRpb25hbFxuICBcImFnZW50LXRhc2tcIixcbiAgXCJhZ2VudC10YXNrc1wiLFxuICBcImFsaWFzXCIsXG4gIFwiYXBpXCIsXG4gIFwiYXR0ZXN0YXRpb25cIixcbiAgXCJhdFwiLFxuICBcImNvbXBsZXRpb25cIixcbiAgXCJjb25maWdcIixcbiAgXCJjb3BpbG90XCIsXG4gIFwiZXh0ZW5zaW9uXCIsXG4gIFwiZXh0ZW5zaW9uc1wiLFxuICBcImV4dFwiLFxuICBcImdwZy1rZXlcIixcbiAgXCJsYWJlbFwiLFxuICBcImxpY2Vuc2VzXCIsXG4gIFwicHJldmlld1wiLFxuICBcInJ1bGVzZXRcIixcbiAgXCJzZWFyY2hcIixcbiAgXCJzZWNyZXRcIixcbiAgXCJzc2gta2V5XCIsXG4gIFwic3RhdHVzXCIsXG4gIFwidmFyaWFibGVcIixcbiAgLy8gSGVscCB0b3BpY3MgYW5kIHRoZSBidWlsdC1pbiBoZWxwL3ZlcnNpb24gdmVyYnNcbiAgXCJhY2Nlc3NpYmlsaXR5XCIsXG4gIFwiYWN0aW9uc1wiLFxuICBcImVudmlyb25tZW50XCIsXG4gIFwiZXhpdC1jb2Rlc1wiLFxuICBcImZvcm1hdHRpbmdcIixcbiAgXCJoZWxwXCIsXG4gIFwibWludHR5XCIsXG4gIFwicmVmZXJlbmNlXCIsXG4gIFwidGVsZW1ldHJ5XCIsXG4gIFwidmVyc2lvblwiLFxuXSk7XG5cbi8qKlxuICogVGhlIHJvb3QgY29tbWFuZCBvZiBhIGBnaGAgYXJndW1lbnQgdmVjdG9yLCBpZiBpdCBuYW1lcyBvbmUuXG4gKlxuICogTWlycm9ycyB0aGUgY2xhc3NpZmllcidzIG93biByZWFkaW5nOiB0aGUgZmlyc3QgYXJndW1lbnQgdGhhdCBpcyBub3QgYSBmbGFnLlxuICogYHVuZGVmaW5lZGAgZm9yIGBnaGAsIGBnaCAtLXZlcnNpb25gIGFuZCBmcmllbmRzLCB3aGljaCBuYW1lIG5vIGNvbW1hbmQuXG4gKlxuICogQHBhcmFtIGFyZ3MgLSBBcmd1bWVudHMgcGFzc2VkIHRvIHRoZSBgZ2hgIGJpbmFyeS5cbiAqIEByZXR1cm5zIFRoZSByb290IGNvbW1hbmQgdG9rZW4sIG9yIHVuZGVmaW5lZCB3aGVuIG5vbmUgaXMgcHJlc2VudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdoUm9vdENvbW1hbmQoXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgbGV0IGkgPSAwO1xuICB3aGlsZSAoYXJnc1tpXT8uc3RhcnRzV2l0aChcIi1cIikpIGkrKztcbiAgcmV0dXJuIGFyZ3NbaV07XG59XG5cbi8qKiBGbGFncyB3aG9zZSB2YWx1ZSBpcyBvbmUgb3IgbW9yZSBjb21tYS1zZXBhcmF0ZWQgbGFiZWwgbmFtZXMuICovXG5jb25zdCBMQUJFTF9GTEFHUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1xuICBcIi0tYWRkLWxhYmVsXCIsXG4gIFwiLS1sYWJlbFwiLFxuICBcIi1sXCIsXG5dKTtcblxuLyoqIGBnaCBhcGlgIGZpZWxkIGZsYWdzIHdob3NlIHZhbHVlIG1heSBjYXJyeSBgbGFiZWxzW109PG5hbWU+YC4gKi9cbmNvbnN0IEZJRUxEX0ZMQUdTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiLWZcIixcbiAgXCItRlwiLFxuICBcIi0tZmllbGRcIixcbiAgXCItLXJhdy1maWVsZFwiLFxuXSk7XG5cbi8qKlxuICogVGhlIHN1YnNldCBvZiBmaWVsZCBmbGFncyB3aG9zZSBgQGAtcHJlZml4ZWQgdmFsdWUgYGdoYCByZWFkcyBmcm9tIGEgZmlsZVxuICogKGBALWAgZnJvbSBzdGRpbikg4oCUIHZlcmlmaWVkIGFnYWluc3QgZ2ggMi45Ny4wIChJc3N1ZSAjOTMpLiBgLWZgL1xuICogYC0tcmF3LWZpZWxkYCBhZGQgYSBzdGF0aWMgc3RyaW5nIGFuZCBuZXZlciBleHBhbmQgYEBgLCBzbyBhIGxpdGVyYWxcbiAqIGBAbmFtZWAgdGhlcmUgaXMgYSByZWFsIGxhYmVsIG5hbWUsIG5vdCBhIGZpbGUuXG4gKi9cbmNvbnN0IEZJRUxEX0ZJTEVfRkxBR1M6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcIi1GXCIsIFwiLS1maWVsZFwiXSk7XG5cbi8qKlxuICogTm9ybWFsaXNlIGEgbGFiZWwgbmFtZSBmb3IgcmVzZXJ2ZWQtbGFiZWwgY29tcGFyaXNvbiAoSXNzdWUgIzE5NSkuXG4gKlxuICogVHJpbXMgbGVhZGluZy90cmFpbGluZyB3aGl0ZXNwYWNlIHRoZW4gbG93ZXItY2FzZXMuIGBTdHJpbmcucHJvdG90eXBlLnRyaW0oKWBcbiAqIGFscmVhZHkgZm9sZHMgQVNDSUkgd2hpdGVzcGFjZSAoc3BhY2UsIHRhYiwgbmV3bGluZSwgQ1IpIGFuZCBVbmljb2RlIFpzXG4gKiBjaGFyYWN0ZXJzIChOQlNQIGFuZCBmcmllbmRzKS4gVGhpcyBoZWxwZXIgYWxzbyBzdHJpcHMgdGhlIHplcm8td2lkdGggc3BhY2VcbiAqIChgVSsyMDBCYCksIHdoaWNoIGB0cmltKClgIGRvZXMgbm90IHRyZWF0IGFzIHdoaXRlc3BhY2UuIEZvbGRpbmcgbW9yZSB0aGFuXG4gKiBHaXRIdWIncyBSRVNUIEFQSSBpcyBzYWZlIGZvciBhIGRlbnlsaXN0OiBpdCBjYW4gb25seSBjYXVzZSBhIGZhbHNlIHJlZnVzYWxcbiAqIG9mIGEgd2VpcmQtYnV0LWxlZ2l0aW1hdGUgbGFiZWwsIG5ldmVyIGEgYnlwYXNzLiBCb3RoIHRoZSBhcmd2IHBhdGhcbiAqICh7QGxpbmsgc3BsaXRMYWJlbHN9IC8ge0BsaW5rIEZPUkJJRERFTl9MQUJFTFN9IGNvbXBhcmlzb24pIGFuZCB0aGUgSlNPTlxuICogYC0taW5wdXRgIHBhdGggKHtAbGluayBzY2FuQm9keUZvckZvcmJpZGRlbkxhYmVsfSkgZ28gdGhyb3VnaCB0aGlzIGhlbHBlciBzb1xuICogdGhlIHR3byBjYW5ub3QgZHJpZnQuXG4gKi9cbmZ1bmN0aW9uIG5vcm1hbGlzZUxhYmVsTmFtZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gbmFtZS5yZXBsYWNlQWxsKFwiXFx1MjAwQlwiLCBcIlwiKS50cmltKCkudG9Mb3dlckNhc2UoKTtcbn1cblxuLyoqXG4gKiBSZXNlcnZlZCB3b3JrZmxvdyBsYWJlbHMgdGhlIGFnZW50IHN1YnByb2Nlc3MgbWF5IG5vdCBhcHBseSwgbm9ybWFsaXNlZCBmb3JcbiAqIGNhc2UtaW5zZW5zaXRpdmUgbWF0Y2hpbmcuXG4gKlxuICogVGhlIFVOSU9OIG9mIHR3byBsaXN0cywgZGVsaWJlcmF0ZWx5LCBiZWNhdXNlIGVhY2ggaG9sZHMgc29tZXRoaW5nIHRoZSBvdGhlclxuICogZG9lcyBub3QgKElzc3VlICMxNDIyKTpcbiAqXG4gKiAtIGBSRVNFUlZFRF9MQUJFTFNgIChgY29uZmlnX2RlZmF1bHRzLnRzYCkgaXMgdGhlIGNhbm9uaWNhbCBzZXQgdGhlIHdvcmtlclxuICogICBtYXkgbmV2ZXIgc2VsZi1hcHBseS4gSXQgaXMgbW9zdGx5IGNvbXB1dGVkIGZyb20gYExBQkVMX0RFRkFVTFRTYCwgc28gYVxuICogICBsYWJlbCByZW5hbWVkIHRoZXJlIHN0YXlzIGNvdmVyZWQgaGVyZSB3aXRoIG5vIHNlY29uZCBlZGl0LlxuICogLSBgV09SS0VSX0ZPUkJJRERFTl9MQUJFTF9MSVRFUkFMU2AgKGB3b3JrZXJfbGFiZWxfZ3VhcmQudHNgKSBjYXJyaWVzXG4gKiAgIGBiZXN0LW1vZGVsYCwgd2hpY2ggaXMgTk9UIGluIGBSRVNFUlZFRF9MQUJFTFNgLiBEZXJpdmluZyBmcm9tIHRoZVxuICogICBjYW5vbmljYWwgc2V0IGFsb25lIOKAlCB0aGUgb2J2aW91cyByZWFkaW5nIG9mIHRoaXMgZGVmZWN0IOKAlCB3b3VsZCBoYXZlXG4gKiAgIHNpbGVudGx5IERST1BQRUQgdGhhdCBsYWJlbCBmcm9tIHRoZSBhZ2VudCBkZW55bGlzdCB3aGlsZSBhcHBlYXJpbmcgdG9cbiAqICAgc3RyZW5ndGhlbiBpdC5cbiAqXG4gKiBUaGUgZGVmZWN0IHdhcyBub3Qgb25lIHN0YWxlIGxpc3QuIEl0IHdhcyB0d28gaGFuZC1tYWludGFpbmVkIGxpc3RzIHRoYXQgaGFkXG4gKiBkcmlmdGVkIGluIGJvdGggZGlyZWN0aW9ucywgd2l0aCBvbmx5IHRoZSBzaG9ydGVyIG9uZSByZWFjaGluZyB0aGUgYWdlbnRcbiAqIGd1YXJkOiBgY2xhdWRlYCwgYGhlbHAgd2FudGVkYCwgYGZhaWxlZGAsIGBmYWlsZWQtb25jZWAsXG4gKiBgbmVlZHMtY2xhcmlmaWNhdGlvbmAsIGBuZWVkcy1odW1hbmAsIGBncmlsbC1tZWAgYW5kXG4gKiBgbmVlZHMtZmFpbHVyZS1kZXRlY3Rpb24tcmVwYWlyYCB3ZXJlIGFsbCByZXNlcnZlZCBhbmQgbm9uZSB3ZXJlIGVuZm9yY2VkXG4gKiBoZXJlLiBgZmFpbGVkYCBhbmQgYG5lZWRzLWh1bWFuYCBnYXRlIHRoZSBmbGVldCdzIG93biBlc2NhbGF0aW9uLCBzbyBhblxuICogYWdlbnQgYWJsZSB0byBhcHBseSB0aGVtIGNvdWxkIHBhcmsgYW4gdW5yZWxhdGVkIGlzc3VlIG91dCBvZiBkaXNjb3ZlcnksXG4gKiBhbmQgYGxhYmVsX3NlY3VyaXR5LnRzYCBjb3VsZCBub3Qgc3RyaXAgdGhlbSDigJQgaXQgdHJ1c3RzIHRoZSBpZGVudGl0eSB0aGVcbiAqIGFnZW50IHN1YnByb2Nlc3MgYXV0aGVudGljYXRlcyBhcy5cbiAqXG4gKiBgbGFiZWxfZGVueWxpc3RfdW5pb25fdGVzdC50c2AgYXNzZXJ0cyBjb250YWlubWVudCBpbiBCT1RIIGRpcmVjdGlvbnMsIHNvXG4gKiBuZWl0aGVyIGxpc3QgY2FuIGdhaW4gYW4gZW50cnkgdGhpcyBndWFyZCBtaXNzZXMuXG4gKi9cbmNvbnN0IEZPUkJJRERFTl9MQUJFTFM6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFxuICBbLi4uUkVTRVJWRURfTEFCRUxTLCAuLi5XT1JLRVJfRk9SQklEREVOX0xBQkVMX0xJVEVSQUxTXS5tYXAoKGwpID0+XG4gICAgbm9ybWFsaXNlTGFiZWxOYW1lKGwpXG4gICksXG4pO1xuXG4vKipcbiAqIFNwbGl0IGEgY29tbWEtc2VwYXJhdGVkIGxhYmVsIHZhbHVlIGludG8gdHJpbW1lZCwgbm9uLWVtcHR5IG5hbWVzLlxuICpcbiAqIEVtcHRpZXMgKGluY2x1ZGluZyBhbGwtd2hpdGVzcGFjZSB0b2tlbnMpIGFyZSBkcm9wcGVkIOKAlCBhcmd2J3MgaGlzdG9yaWNhbFxuICogYmVoYXZpb3VyLiBUaGUgSlNPTiBgLS1pbnB1dGAgcGF0aCBtdXN0IG5vdCBjb3B5IHRoaXM6IGEgd2hpdGVzcGFjZS1vbmx5XG4gKiBlbGVtZW50IHRoZXJlIGlzIGB1bnJlYWRhYmxlYCAoZmFpbCBjbG9zZWQpLiBDb21wYXJpc29uIHN0aWxsIHVzZXNcbiAqIHtAbGluayBub3JtYWxpc2VMYWJlbE5hbWV9IHNvIHRoZSB0d28gcGF0aHMgc2hhcmUgb25lIG5vcm1hbGlzYXRpb24uXG4gKi9cbmZ1bmN0aW9uIHNwbGl0TGFiZWxzKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIHJldHVybiB2YWx1ZS5zcGxpdChcIixcIikubWFwKChzKSA9PiBzLnRyaW0oKSkuZmlsdGVyKChzKSA9PlxuICAgIG5vcm1hbGlzZUxhYmVsTmFtZShzKS5sZW5ndGggPiAwXG4gICk7XG59XG5cbi8qKlxuICogTGFiZWwgbmFtZXMgY2FycmllZCBieSBhIGBnaCBhcGlgIGZpZWxkIHZhbHVlIHN1Y2ggYXMgYGxhYmVsc1tdPXhgLlxuICpcbiAqIEFuIGBAYC1wcmVmaXhlZCB2YWx1ZSBvbiBhIGAtRmAvYC0tZmllbGRgIGZsYWcgaXMgcmVhZCBmcm9tIGEgZmlsZSBieSBgZ2hgLFxuICogc28gdGhlIGxhYmVsIG5hbWVzIG5ldmVyIHJlYWNoIHRoZSBhcmd2IChJc3N1ZSAjOTMpLiBFbWl0dGluZyB0aGUgbGl0ZXJhbFxuICogYEBwYXRoYCBhcyBhIGxhYmVsIHdvdWxkIGJlIHdvcnNlIHRoYW4gZW1pdHRpbmcgbm90aGluZyDigJQgaXQgd291bGQgbG9vayBhc1xuICogaWYgdGhlIGd1YXJkIGluc3BlY3RlZCB0aGUgdmFsdWUgd2hlbiBpdCBkaWQgbm90IOKAlCBzbyByZXR1cm4gbm8gbmFtZXMgYW5kXG4gKiBsZXQgdGhlIGB1bnJlYWRhYmxlQm9keWAgYmFja3N0b3AgcmVmdXNlIHRoZSBjb21tYW5kLiBgZXhwYW5kc0F0RmlsZWAgaXNcbiAqIGZhbHNlIGZvciBgLWZgL2AtLXJhdy1maWVsZGAsIHdoZXJlIGBAbGl0ZXJhbGAgcmVhbGx5IGlzIHRoZSBsYWJlbCBuYW1lLlxuICovXG5mdW5jdGlvbiBsYWJlbHNGcm9tRmllbGQoZmllbGQ6IHN0cmluZywgZXhwYW5kc0F0RmlsZTogYm9vbGVhbik6IHN0cmluZ1tdIHtcbiAgY29uc3QgbWF0Y2ggPSBmaWVsZC5tYXRjaCgvXmxhYmVscyg/OlxcW1xcXSk/PShbXFxzXFxTXSopJC8pO1xuICBpZiAoIW1hdGNoKSByZXR1cm4gW107XG4gIGNvbnN0IHZhbHVlID0gbWF0Y2hbMV0gPz8gXCJcIjtcbiAgaWYgKGV4cGFuZHNBdEZpbGUgJiYgdmFsdWUuc3RhcnRzV2l0aChcIkBcIikpIHJldHVybiBbXTtcbiAgcmV0dXJuIHNwbGl0TGFiZWxzKHZhbHVlKTtcbn1cblxuLyoqXG4gKiBDb2xsZWN0IGV2ZXJ5IGxhYmVsIG5hbWUgbmFtZWQgYnkgYSBgZ2hgIGFyZ3VtZW50IHZlY3Rvci5cbiAqXG4gKiBDb3ZlcnMgdGhlIHNwYWNlIGZvcm0gKGAtLWFkZC1sYWJlbCB4YCksIHRoZSBlcXVhbHMgZm9ybSAoYC0tbGFiZWw9eGApLCB0aGVcbiAqIHNob3J0IGZvcm0gKGAtbCB4YCksIHRoZSBhdHRhY2hlZCBzaG9ydGhhbmQgZm9ybSAoYC1seGAsIGAtbD14YCDigJQgcGZsYWdcbiAqIHNwZWxsaW5ncyBub3JtYWxpc2VkIGJ5IHtAbGluayBub3JtYWxpc2VHaEFyZ3N9LCBJc3N1ZSAjMzg2NyksXG4gKiBjb21tYS1zZXBhcmF0ZWQgbGlzdHMsIGFuZCBgZ2ggYXBpYCBsYWJlbCBmaWVsZHMuIEV2ZXJ5IG9jY3VycmVuY2VcbiAqIGNvbnRyaWJ1dGVzLCBiZWNhdXNlIGAtLWxhYmVsYCBpcyBhIHBmbGFnIHN0cmluZyAqc2xpY2UqOiByZXBlYXRpbmcgaXRcbiAqIGFjY3VtdWxhdGVzIHJhdGhlciB0aGFuIHJlcGxhY2VzLlxuICpcbiAqIEBwYXJhbSBhcmdzIC0gQXJndW1lbnRzIHBhc3NlZCB0byB0aGUgYGdoYCBiaW5hcnkuXG4gKiBAcmV0dXJucyBMYWJlbCBuYW1lcyBpbiB0aGUgb3JkZXIgdGhleSBhcHBlYXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0TGFiZWxWYWx1ZXMocmF3QXJnczogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGFyZ3MgPSBub3JtYWxpc2VHaEFyZ3MocmF3QXJncyk7XG4gIGNvbnN0IGxhYmVsczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgdG9rZW4gPSBhcmdzW2ldO1xuICAgIGlmICh0b2tlbiA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcblxuICAgIGlmIChMQUJFTF9GTEFHUy5oYXModG9rZW4pKSB7XG4gICAgICAvLyBwZmxhZyB0YWtlcyB0aGUgZm9sbG93aW5nIHRva2VuIGFzIHRoZSB2YWx1ZSB3aGF0ZXZlciBpdCBsb29rcyBsaWtlLlxuICAgICAgY29uc3QgdmFsdWUgPSBhcmdzW2kgKyAxXTtcbiAgICAgIGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGxhYmVscy5wdXNoKC4uLnNwbGl0TGFiZWxzKHZhbHVlKSk7XG4gICAgICAgIGkrKztcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodG9rZW4uc3RhcnRzV2l0aChcIi0tYWRkLWxhYmVsPVwiKSkge1xuICAgICAgbGFiZWxzLnB1c2goLi4uc3BsaXRMYWJlbHModG9rZW4uc2xpY2UoXCItLWFkZC1sYWJlbD1cIi5sZW5ndGgpKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRva2VuLnN0YXJ0c1dpdGgoXCItLWxhYmVsPVwiKSkge1xuICAgICAgbGFiZWxzLnB1c2goLi4uc3BsaXRMYWJlbHModG9rZW4uc2xpY2UoXCItLWxhYmVsPVwiLmxlbmd0aCkpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoRklFTERfRkxBR1MuaGFzKHRva2VuKSkge1xuICAgICAgY29uc3QgdmFsdWUgPSBhcmdzW2kgKyAxXTtcbiAgICAgIGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGxhYmVscy5wdXNoKC4uLmxhYmVsc0Zyb21GaWVsZCh2YWx1ZSwgRklFTERfRklMRV9GTEFHUy5oYXModG9rZW4pKSk7XG4gICAgICAgIGkrKztcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBlcSA9IHRva2VuLmluZGV4T2YoXCI9XCIpO1xuICAgIGlmIChlcSA+IDAgJiYgRklFTERfRkxBR1MuaGFzKHRva2VuLnNsaWNlKDAsIGVxKSkpIHtcbiAgICAgIGxhYmVscy5wdXNoKFxuICAgICAgICAuLi5sYWJlbHNGcm9tRmllbGQoXG4gICAgICAgICAgdG9rZW4uc2xpY2UoZXEgKyAxKSxcbiAgICAgICAgICBGSUVMRF9GSUxFX0ZMQUdTLmhhcyh0b2tlbi5zbGljZSgwLCBlcSkpLFxuICAgICAgICApLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGxhYmVscztcbn1cblxuLyoqXG4gKiBgZ2ggbGFiZWxgIHZlcmJzIHdob3NlIHBvc2l0aW9uYWwgYXJndW1lbnQgaXMgYSBsYWJlbCBOQU1FIChJc3N1ZSAjMjUxOCkuXG4gKlxuICogYGNsb25lYCBpcyBkZWxpYmVyYXRlbHkgYWJzZW50OiBpdHMgcG9zaXRpb25hbCBpcyBhXG4gKiBgPHNvdXJjZS1yZXBvc2l0b3J5PmAsIG5ldmVyIGEgbGFiZWwgbmFtZSwgYW5kIGl0IG9ubHkgY3JlYXRlcyBsYWJlbHMgdGhlXG4gKiBkZXN0aW5hdGlvbiBsYWNrcyDigJQgbGFiZWxzIGFic2VudCBmcm9tIHRoZSBzb3VyY2UgXCJ3aWxsIG5vdCBiZSBkZWxldGVkIG9yXG4gKiBtb2RpZmllZFwiLCBzbyBpdCBjYW4gbmVpdGhlciByZW5hbWUgbm9yIGRlc3Ryb3kgYSByZXNlcnZlZCBsYWJlbC4gQ29tcGFyaW5nXG4gKiBhIHJlcG8gc2x1ZyBhZ2FpbnN0IHRoZSBkZW55bGlzdCB3b3VsZCByZWZ1c2UgbGVnaXRpbWF0ZSBjbG9uZXMgYW5kIHByb3RlY3RcbiAqIG5vdGhpbmcuXG4gKi9cbmNvbnN0IExBQkVMX0RFRklOSVRJT05fVkVSQlM6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgXCJjcmVhdGVcIixcbiAgXCJlZGl0XCIsXG4gIFwiZGVsZXRlXCIsXG5dKTtcblxuLyoqXG4gKiBWYWx1ZS10YWtpbmcgZmxhZ3Mgb2YgYGdoIGxhYmVsIGNyZWF0ZXxlZGl0fGRlbGV0ZWAgaW4gc2VwYXJhdGVkIHNwZWxsaW5nLlxuICpcbiAqIFNraXBwaW5nIHRoZWlyIHZhbHVlcyBpcyB3aGF0IGtlZXBzIGEgKmRlc2NyaXB0aW9uKiB0aGF0IG1lcmVseSBtZW50aW9ucyBhXG4gKiByZXNlcnZlZCBsYWJlbCAoIGAtZCBcInJhaXNlIHdpdGggdG9wLXByaW9yaXR5XCJgICkgZnJvbSBiZWluZyByZWFkIGFzIGFcbiAqIGRlZmluaXRpb24gb2Ygb25lLiBgLWZgL2AtLWZvcmNlYCBhbmQgYC0teWVzYCBhcmUgYm9vbGVhbiBhbmQgbXVzdCBOT1QgYmVcbiAqIGxpc3RlZCDigJQgc2tpcHBpbmcgYSB0b2tlbiBhZnRlciB0aGVtIHdvdWxkIGhpZGUgdGhlIHJlYWwgcG9zaXRpb25hbC5cbiAqL1xuY29uc3QgTEFCRUxfQ01EX1ZBTFVFX0ZMQUdTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiLWNcIixcbiAgXCItLWNvbG9yXCIsXG4gIFwiLWRcIixcbiAgXCItLWRlc2NyaXB0aW9uXCIsXG4gIFwiLVJcIixcbiAgXCItLXJlcG9cIixcbl0pO1xuXG4vKipcbiAqIExhYmVsIG5hbWVzIGEgYGdoIGxhYmVsIGNyZWF0ZXxlZGl0fGRlbGV0ZWAgaW52b2NhdGlvbiB3b3VsZCBkZWZpbmUsIHJlbmFtZVxuICogdG8sIG9yIGRlc3Ryb3kgKElzc3VlICMyNTE4KS5cbiAqXG4gKiB7QGxpbmsgZXh0cmFjdExhYmVsVmFsdWVzfSByZWFkcyBmbGFnIHZhbHVlcyBvbmx5LCBiZWNhdXNlIHRoYXQgaXMgd2hhdFxuICogYGdoIGlzc3VlYC9gZ2ggcHJgIHVzZSDigJQgYnV0IGBnaCBsYWJlbGAncyBuYW1lIGlzIFBPU0lUSU9OQUwsIHNvIHRoZVxuICogcmVzZXJ2ZWQtbGFiZWwgZGVueWxpc3Qgc2F3IGFuIGVtcHR5IGxpc3QgYW5kIGBnaCBsYWJlbCBkZWxldGUgdG9wLXByaW9yaXR5YFxuICogZmVsbCB0aHJvdWdoIHRvIHRoZSB3cml0ZS1yZXBvIGFsbG93bGlzdCwgd2hpY2ggd2F2ZXMgYSBjd2Qtc2NvcGVkIHdyaXRlXG4gKiB0aHJvdWdoLiBEZWxldGluZyBvciByZW5hbWluZyBhIHNjaGVkdWxpbmcgbGFiZWwgaXMgYSBzdHJpY3RseSB3b3JzZSBvdXRjb21lXG4gKiB0aGFuIHRoZSBsYWJlbCAqYXBwbGljYXRpb24qIHRoYXQgZGVueWxpc3Qgd2FzIHdyaXR0ZW4gdG8gc3RvcC5cbiAqXG4gKiBCb3RoIG5hbWUtYmVhcmluZyBwb3NpdGlvbnMgYXJlIGNvbGxlY3RlZDogdGhlIHBvc2l0aW9uYWwgYDxuYW1lPmAgYW5kXG4gKiBgZ2ggbGFiZWwgZWRpdGAncyBgLW5gL2AtLW5hbWVgIHJlbmFtZSB0YXJnZXQuIGBub3JtYWxpc2VHaEFyZ3NgIG5vcm1hbGlzZXNcbiAqIG9ubHkgYFIsbCxYLGYsRmAsIHNvIHRoZSBhdHRhY2hlZCBgLW50b3AtcHJpb3JpdHlgIC8gYC1uPXRvcC1wcmlvcml0eWBcbiAqIHNwZWxsaW5ncyBhcnJpdmUgdW5leHBhbmRlZCBhbmQgYXJlIGV4cGFuZGVkIGhlcmUgcmF0aGVyIHRoYW4gYnkgd2lkZW5pbmdcbiAqIHRoYXQgc2V0LCB3aGljaCB3b3VsZCByZXdyaXRlIHVucmVsYXRlZCBjb21tYW5kcyAoYGdoIHJlbGVhc2UgY3JlYXRlIC1uTm90ZXNgKS5cbiAqIE9ubHkgaW5kZXggMSBvZiBhIHNob3J0aGFuZCBncm91cCBuZWVkcyB0aGUgYC1uYCB0cmVhdG1lbnQ6IGV2ZXJ5IG90aGVyXG4gKiBzaG9ydGhhbmQgYGdoIGxhYmVsIGVkaXRgIGFjY2VwdHMgdGFrZXMgYSB2YWx1ZSwgc28gaXQgd291bGQgc3dhbGxvdyBhbiBgbmBcbiAqIGJlaGluZCBpdCBhcyBwYXJ0IG9mIGl0cyBvd24gdmFsdWUg4oCUIGV4YWN0bHkgYXMgcGZsYWcgZG9lcy5cbiAqXG4gKiBAcGFyYW0gcmF3QXJncyAtIEFyZ3VtZW50cyBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICogQHJldHVybnMgQ2FuZGlkYXRlIGxhYmVsIG5hbWVzLCBpbiBhcmd2IG9yZGVyLlxuICovXG5mdW5jdGlvbiBsYWJlbERlZmluaXRpb25OYW1lcyhyYXdBcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgYXJncyA9IG5vcm1hbGlzZUdoQXJncyhyYXdBcmdzKTtcbiAgbGV0IGkgPSAwO1xuICB3aGlsZSAoYXJnc1tpXT8uc3RhcnRzV2l0aChcIi1cIikpIGkrKztcbiAgaWYgKGFyZ3NbaV0gIT09IFwibGFiZWxcIikgcmV0dXJuIFtdO1xuICBpKys7XG4gIHdoaWxlIChhcmdzW2ldPy5zdGFydHNXaXRoKFwiLVwiKSkgaSsrO1xuICBjb25zdCB2ZXJiID0gYXJnc1tpXTtcbiAgaWYgKHZlcmIgPT09IHVuZGVmaW5lZCB8fCAhTEFCRUxfREVGSU5JVElPTl9WRVJCUy5oYXModmVyYikpIHJldHVybiBbXTtcblxuICBjb25zdCBuYW1lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGVuZE9mRmxhZ3MgPSBmYWxzZTtcbiAgZm9yIChsZXQgaiA9IGkgKyAxOyBqIDwgYXJncy5sZW5ndGg7IGorKykge1xuICAgIGNvbnN0IHRva2VuID0gYXJnc1tqXTtcbiAgICBpZiAodG9rZW4gPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgaWYgKGVuZE9mRmxhZ3MgfHwgIXRva2VuLnN0YXJ0c1dpdGgoXCItXCIpIHx8IHRva2VuID09PSBcIi1cIikge1xuICAgICAgbmFtZXMucHVzaCh0b2tlbik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRva2VuID09PSBcIi0tXCIpIHtcbiAgICAgIGVuZE9mRmxhZ3MgPSB0cnVlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICh0b2tlbiA9PT0gXCItblwiIHx8IHRva2VuID09PSBcIi0tbmFtZVwiKSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGFyZ3NbaiArIDFdO1xuICAgICAgaWYgKHZhbHVlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgbmFtZXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIGorKztcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodG9rZW4uc3RhcnRzV2l0aChcIi0tbmFtZT1cIikpIHtcbiAgICAgIG5hbWVzLnB1c2godG9rZW4uc2xpY2UoXCItLW5hbWU9XCIubGVuZ3RoKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHRva2VuLnN0YXJ0c1dpdGgoXCItblwiKSAmJiAhdG9rZW4uc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICBjb25zdCByZXN0ID0gdG9rZW4uc2xpY2UoMik7XG4gICAgICBuYW1lcy5wdXNoKHJlc3Quc3RhcnRzV2l0aChcIj1cIikgPyByZXN0LnNsaWNlKDEpIDogcmVzdCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKExBQkVMX0NNRF9WQUxVRV9GTEFHUy5oYXModG9rZW4pKSB7XG4gICAgICBqKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gQW4gdW5yZWNvZ25pc2VkIGZsYWcncyBzZXBhcmF0ZWQgdmFsdWUgbWF5IGJlIHJlYWQgYXMgYSBwb3NpdGlvbmFsIG9uXG4gICAgLy8gdGhlIG5leHQgcGFzcy4gVGhhdCBkaXJlY3Rpb24gZmFpbHMgY2xvc2VkIOKAlCBhIGZhbHNlIHJlZnVzYWwsIG5ldmVyIGFcbiAgICAvLyB3YXZlZC10aHJvdWdoIGRlZmluaXRpb24uXG4gIH1cbiAgcmV0dXJuIG5hbWVzO1xufVxuXG4vKiogYGdoIGFwaWAgbGFiZWwtZW5kcG9pbnQgYm9keSBmaWVsZHMgdGhhdCBjYXJyeSBhIGxhYmVsIE5BTUUuICovXG5jb25zdCBMQUJFTF9OQU1FX0ZJRUxEUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1wibmFtZVwiLCBcIm5ld19uYW1lXCJdKTtcblxuLyoqXG4gKiBgcmVwb3Mve293bmVyfS97cmVwb30vbGFiZWxzWy97bmFtZX1dYCwgd2l0aCBhbnkgb3JpZ2luIG9yIGxlYWRpbmcgc2xhc2hcbiAqIHRvbGVyYXRlZCDigJQgdGhlIHNoYXBlIGBnaCBhcGlgIGFjY2VwdHMuXG4gKlxuICogQW5jaG9yZWQgYXQgdGhlIGVuZCBzbyB0aGUgaXNzdWUvUFIgbGFiZWwgKmFwcGxpY2F0aW9uKiBzdWItcmVzb3VyY2VzXG4gKiAoYHJlcG9zL28vci9pc3N1ZXMvNS9sYWJlbHNgKSBkbyBub3QgbWF0Y2g6IHRob3NlIGFwcGx5IGEgbGFiZWwgYW5kIGFyZVxuICogYWxyZWFkeSBjb3ZlcmVkIGJ5IHtAbGluayBleHRyYWN0TGFiZWxWYWx1ZXN9LiBBIGxlYWRpbmcgYC9gIHJhdGhlciB0aGFuIHRoZVxuICogc3RyaW5nIHN0YXJ0IGlzIGFjY2VwdGVkIHNvIGEgZnVsbCBVUkwgbWF0Y2hlczsgdGhlIGNvc3Qgb2YgdGhhdCBsb29zZW5lc3MgaXNcbiAqIGF0IHdvcnN0IGEgZmFsc2UgcmVmdXNhbCBvZiBhIHBhdGggdGhhdCBtZXJlbHkgZW5kcyB0aGlzIHdheS5cbiAqL1xuY29uc3QgQVBJX0xBQkVMX0VORFBPSU5UID1cbiAgLyg/Ol58XFwvKXJlcG9zXFwvW14vXStcXC9bXi9dK1xcL2xhYmVscyg/OlxcLyhbXi8/I10qKSk/XFwvPyQvO1xuXG4vKiogUkVTVCBtZXRob2RzIHRoYXQgY291bGQgZGVmaW5lLCByZW5hbWUgb3IgZGVzdHJveSBhIGxhYmVsIGRlZmluaXRpb24uICovXG5jb25zdCBBUElfTEFCRUxfV1JJVEVfTUVUSE9EUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1xuICBcInBvc3RcIixcbiAgXCJwYXRjaFwiLFxuICBcInB1dFwiLFxuICBcImRlbGV0ZVwiLFxuXSk7XG5cbi8qKlxuICogVmFsdWVzIG9mIHRoZSBuYW1lZCBgZ2ggYXBpYCBib2R5IGZpZWxkcyAoYC1mIG5hbWU9eGAsIGAtLWZpZWxkPW5hbWU9eGApLlxuICpcbiAqIEFuIGBAYC1wcmVmaXhlZCB2YWx1ZSBvbiBhIGAtRmAvYC0tZmllbGRgIGZsYWcgaXMgcmVhZCBmcm9tIGEgZmlsZSBieSBgZ2hgXG4gKiBhbmQgbmV2ZXIgcmVhY2hlcyB0aGUgYXJndiwgc28gaXQgaXMgc2tpcHBlZCBoZXJlIGZvciB0aGUgc2FtZSByZWFzb25cbiAqIHtAbGluayBsYWJlbHNGcm9tRmllbGR9IHNraXBzIGl0IOKAlCB0aGUgYHVucmVhZGFibGVCb2R5YCBiYWNrc3RvcCByZWZ1c2VzIHRoYXRcbiAqIGNvbW1hbmQgcmF0aGVyIHRoYW4gdGhpcyBzY2FuIHByZXRlbmRpbmcgdG8gaGF2ZSByZWFkIGl0LlxuICpcbiAqIEBwYXJhbSByYXdBcmdzIC0gQXJndW1lbnRzIHBhc3NlZCB0byB0aGUgYGdoYCBiaW5hcnkuXG4gKiBAcGFyYW0ga2V5cyAtIEZpZWxkIG5hbWVzIHRvIGNvbGxlY3QsIGxvd2VyLWNhc2UuXG4gKiBAcmV0dXJucyBUaGUgbWF0Y2hpbmcgZmllbGQgdmFsdWVzLCBpbiBhcmd2IG9yZGVyLlxuICovXG5mdW5jdGlvbiBhcGlGaWVsZFZhbHVlc0ZvcihcbiAgcmF3QXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGtleXM6IFJlYWRvbmx5U2V0PHN0cmluZz4sXG4pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGFyZ3MgPSBub3JtYWxpc2VHaEFyZ3MocmF3QXJncyk7XG4gIGNvbnN0IHZhbHVlczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgdGFrZSA9IChmaWVsZDogc3RyaW5nLCBleHBhbmRzQXRGaWxlOiBib29sZWFuKTogdm9pZCA9PiB7XG4gICAgY29uc3QgZXEgPSBmaWVsZC5pbmRleE9mKFwiPVwiKTtcbiAgICBpZiAoZXEgPD0gMCkgcmV0dXJuO1xuICAgIGlmICgha2V5cy5oYXMoZmllbGQuc2xpY2UoMCwgZXEpLnRyaW0oKS50b0xvd2VyQ2FzZSgpKSkgcmV0dXJuO1xuICAgIGNvbnN0IHZhbHVlID0gZmllbGQuc2xpY2UoZXEgKyAxKTtcbiAgICBpZiAoZXhwYW5kc0F0RmlsZSAmJiB2YWx1ZS5zdGFydHNXaXRoKFwiQFwiKSkgcmV0dXJuO1xuICAgIHZhbHVlcy5wdXNoKHZhbHVlKTtcbiAgfTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgdG9rZW4gPSBhcmdzW2ldO1xuICAgIGlmICh0b2tlbiA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBpZiAoRklFTERfRkxBR1MuaGFzKHRva2VuKSkge1xuICAgICAgY29uc3QgdmFsdWUgPSBhcmdzW2kgKyAxXTtcbiAgICAgIGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRha2UodmFsdWUsIEZJRUxEX0ZJTEVfRkxBR1MuaGFzKHRva2VuKSk7XG4gICAgICAgIGkrKztcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBlcSA9IHRva2VuLmluZGV4T2YoXCI9XCIpO1xuICAgIGlmIChlcSA+IDAgJiYgRklFTERfRkxBR1MuaGFzKHRva2VuLnNsaWNlKDAsIGVxKSkpIHtcbiAgICAgIHRha2UodG9rZW4uc2xpY2UoZXEgKyAxKSwgRklFTERfRklMRV9GTEFHUy5oYXModG9rZW4uc2xpY2UoMCwgZXEpKSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB2YWx1ZXM7XG59XG5cbi8qKlxuICogTGFiZWwgbmFtZXMgYSBgZ2ggYXBpYCBjYWxsIHdvdWxkIGRlZmluZSwgcmVuYW1lIHRvLCBvciBkZXN0cm95IChJc3N1ZVxuICogIzI1MTgpLlxuICpcbiAqIFRoZSBSRVNUIHNwZWxsaW5nIGlzIHRoZSBzYW1lIGNhcGFiaWxpdHkgYXMgYGdoIGxhYmVsIGRlbGV0ZSB0b3AtcHJpb3JpdHlgXG4gKiB3aXRoIGEgZGlmZmVyZW50IGFyZ3YsIGFuZCB0aGUgZ3VhcmQgYWxyZWFkeSB0cmVhdHMgUkVTVCBzcGVsbGluZ3MgYXNcbiAqIGluLXNjb3BlIGVsc2V3aGVyZSAoYGdoIGFwaSAtWCBQQVRDSCDigKYvaXNzdWVzL04gLWYgc3RhdGU9Y2xvc2VkYCBpcyByZWZ1c2VkXG4gKiBhcyBhIGxpZmVjeWNsZSBjaGFuZ2UpLiBDbG9zaW5nIG9ubHkgdGhlIGBnaCBsYWJlbGAgcm91dGUgd291bGQgbGVhdmVcbiAqIGBnaCBhcGkgLVggREVMRVRFIHJlcG9zL28vci9sYWJlbHMvdG9wLXByaW9yaXR5YCBhcyBhIG9uZS1saW5lIHJld3JpdGUgb2YgdGhlXG4gKiBzYW1lIGF0dGFjaywgc28gYm90aCByb3V0ZXMgc2hhcmUgdGhpcyBkZW55bGlzdC5cbiAqXG4gKiBUaHJlZSBuYW1lLWJlYXJpbmcgcG9zaXRpb25zOiB0aGUgYHtuYW1lfWAgcGF0aCBzZWdtZW50IGEgUEFUQ0ggb3IgREVMRVRFXG4gKiB0YXJnZXRzLCBgbmFtZT1gIG9uIGEgY3JlYXRlLCBhbmQgYG5ld19uYW1lPWAgb24gYSByZW5hbWUuIEEgcGVyY2VudC1lbmNvZGVkXG4gKiBzZWdtZW50IGlzIGRlY29kZWQsIGFuZCBhIG1hbGZvcm1lZCBlbmNvZGluZyBpcyBjb21wYXJlZCByYXcgcmF0aGVyIHRoYW5cbiAqIHRocm93aW5nIOKAlCBhbiB1bmRlY29kYWJsZSBuYW1lIGNhbm5vdCBtYXRjaCB0aGUgZGVueWxpc3QsIGFuZCB0aGUgZW5kcG9pbnRcbiAqIHdvdWxkIG5vdCByZXNvbHZlIHRvIGEgcmVzZXJ2ZWQgbGFiZWwgZWl0aGVyLlxuICpcbiAqIEBwYXJhbSByYXdBcmdzIC0gQXJndW1lbnRzIHBhc3NlZCB0byB0aGUgYGdoYCBiaW5hcnkuXG4gKiBAcGFyYW0gaW5mbyAtIE11dGF0aW9uIGNsYXNzaWZpY2F0aW9uIGZvciB0aGUgc2FtZSBhcmd2LlxuICogQHJldHVybnMgQ2FuZGlkYXRlIGxhYmVsIG5hbWVzLCBwYXRoIHNlZ21lbnQgZmlyc3QuXG4gKi9cbmZ1bmN0aW9uIGFwaUxhYmVsRGVmaW5pdGlvbk5hbWVzKFxuICByYXdBcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgaW5mbzogTXV0YXRpb25JbmZvLFxuKTogc3RyaW5nW10ge1xuICBpZiAoIWluZm8udmVyYi5zdGFydHNXaXRoKFwiYXBpLVwiKSkgcmV0dXJuIFtdO1xuICBpZiAoIUFQSV9MQUJFTF9XUklURV9NRVRIT0RTLmhhcyhpbmZvLnZlcmIuc2xpY2UoXCJhcGktXCIubGVuZ3RoKSkpIHJldHVybiBbXTtcbiAgY29uc3QgbWF0Y2ggPSAoaW5mby50YXJnZXQgPz8gXCJcIikubWF0Y2goQVBJX0xBQkVMX0VORFBPSU5UKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIFtdO1xuXG4gIGNvbnN0IG5hbWVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBzZWdtZW50ID0gbWF0Y2hbMV07XG4gIGlmIChzZWdtZW50ICE9PSB1bmRlZmluZWQgJiYgc2VnbWVudCAhPT0gXCJcIikge1xuICAgIHRyeSB7XG4gICAgICBuYW1lcy5wdXNoKGRlY29kZVVSSUNvbXBvbmVudChzZWdtZW50KSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBuYW1lcy5wdXNoKHNlZ21lbnQpO1xuICAgIH1cbiAgfVxuICBuYW1lcy5wdXNoKC4uLmFwaUZpZWxkVmFsdWVzRm9yKHJhd0FyZ3MsIExBQkVMX05BTUVfRklFTERTKSk7XG4gIHJldHVybiBuYW1lcztcbn1cblxuLyoqIE91dGNvbWUgb2Ygc2Nhbm5pbmcgYSBgLS1pbnB1dGAgYm9keSBmaWxlIGZvciByZXNlcnZlZCB3b3JrZmxvdyBsYWJlbHMuICovXG50eXBlIEJvZHlTY2FuID1cbiAgfCB7IGtpbmQ6IFwiY2xlYW5cIiB9XG4gIHwgeyBraW5kOiBcImZvcmJpZGRlblwiOyBsYWJlbDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwidW5yZWFkYWJsZVwiIH07XG5cbi8qKlxuICogTGFiZWwgbmFtZXMgZnJvbSBhIGBbXCJhXCIsIHtcIm5hbWVcIjpcImJcIn1dYCBhcnJheSwgb3IgYG51bGxgIGlmIGFueSBlbGVtZW50IGlzXG4gKiBhIHNoYXBlIHRoZSBleHRyYWN0b3IgZG9lcyBub3QgdW5kZXJzdGFuZCAoZmFpbCBjbG9zZWQgb24gdGhlIHVua25vd24pLlxuICpcbiAqIEEgc3RyaW5nIG9yIGB7bmFtZX1gIHdob3NlIHtAbGluayBub3JtYWxpc2VMYWJlbE5hbWV9IGZvcm0gaXMgZW1wdHlcbiAqIChhbGwtd2hpdGVzcGFjZSwgaW5jbHVkaW5nIFVuaWNvZGUgd2hpdGVzcGFjZSB0aGUgaGVscGVyIGZvbGRzKSBpc1xuICogYG51bGxgIOKAlCBmYWlsIGNsb3NlZCwgbmV2ZXIgc2lsZW50bHkgZHJvcHBlZC5cbiAqL1xuZnVuY3Rpb24gbGFiZWxOYW1lc0Zyb21BcnJheShhcnI6IHJlYWRvbmx5IHVua25vd25bXSk6IHN0cmluZ1tdIHwgbnVsbCB7XG4gIGNvbnN0IG5hbWVzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGVsIG9mIGFycikge1xuICAgIGlmICh0eXBlb2YgZWwgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIGlmIChub3JtYWxpc2VMYWJlbE5hbWUoZWwpLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gICAgICBuYW1lcy5wdXNoKGVsKTtcbiAgICB9IGVsc2UgaWYgKFxuICAgICAgZWwgIT09IG51bGwgJiYgdHlwZW9mIGVsID09PSBcIm9iamVjdFwiICYmXG4gICAgICB0eXBlb2YgKGVsIGFzIHsgbmFtZT86IHVua25vd24gfSkubmFtZSA9PT0gXCJzdHJpbmdcIlxuICAgICkge1xuICAgICAgY29uc3QgbmFtZSA9IChlbCBhcyB7IG5hbWU6IHN0cmluZyB9KS5uYW1lO1xuICAgICAgaWYgKG5vcm1hbGlzZUxhYmVsTmFtZShuYW1lKS5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICAgICAgbmFtZXMucHVzaChuYW1lKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9XG4gIHJldHVybiBuYW1lcztcbn1cblxuLyoqXG4gKiBTY2FuIGEgYGdoIGFwaSAtLWlucHV0YCBib2R5IGZvciByZXNlcnZlZCB3b3JrZmxvdyBsYWJlbHMgKElzc3VlcyAjOTEsICMxOTUpLlxuICpcbiAqIFVuZGVyc3RhbmRzIHRoZSB0aHJlZSBzaGFwZXMgR2l0SHViJ3MgUkVTVCBBUEkgYWNjZXB0cyBmb3IgbGFiZWxzIOKAlCB0aGUgYmFyZVxuICogYXJyYXkgYFtcImFcIl1gLCBge1wibGFiZWxzXCI6IFtcImFcIl19YCwgYW5kIGB7XCJsYWJlbHNcIjogW3tcIm5hbWVcIjpcImFcIn1dfWAg4oCUIHBsdXNcbiAqIGEgYm9keSBjYXJyeWluZyBubyBgbGFiZWxzYCBmaWVsZCBhdCBhbGwgKGFuIGlzc3VlIGNyZWF0ZS9lZGl0KS4gQW55dGhpbmdcbiAqIGVsc2Ug4oCUIGludmFsaWQgSlNPTiwgYSBub24tb2JqZWN0L2FycmF5IHRvcCBsZXZlbCwgYSBgbGFiZWxzYCBmaWVsZCB0aGF0IGlzXG4gKiBub3QgYW4gYXJyYXksIGFuIGFycmF5IGVsZW1lbnQgdGhhdCBpcyBuZWl0aGVyIGEgc3RyaW5nIG5vciBge25hbWV9YCwgb3IgYVxuICogc3RyaW5nL2B7bmFtZX1gIHRoYXQgbm9ybWFsaXNlcyB0byBlbXB0eSDigJQgaXMgcmVwb3J0ZWQgYHVucmVhZGFibGVgIHNvIHRoZVxuICogY2FsbGVyIGZhaWxzIGNsb3NlZCwgbmV2ZXIgYWxsb3dlZCB1bnNjYW5uZWQuXG4gKlxuICogRXh0cmFjdGVkIG5hbWVzIGFyZSBjb21wYXJlZCB2aWEge0BsaW5rIG5vcm1hbGlzZUxhYmVsTmFtZX0gYWdhaW5zdFxuICoge0BsaW5rIEZPUkJJRERFTl9MQUJFTFN9IOKAlCB0aGUgc2FtZSBoZWxwZXIgdGhlIGFyZ3YgcGF0aCB1c2VzXG4gKiAoYHNwbGl0TGFiZWxzYCAvIGRlbnlsaXN0IGxvb2t1cCkuIFRyaW0sIGNhc2UtZm9sZCwgYW5kIFVuaWNvZGUgd2hpdGVzcGFjZVxuICogZm9sZGluZyB0aGVyZWZvcmUgY2Fubm90IGRyaWZ0IGJldHdlZW4gdGhlIHR3byBwYXRocy4gR2l0SHViJ3MgUkVTVC9HVUlcbiAqIHRyaW0gbGFiZWwgbmFtZXMgKGNsaS9jbGkjMTE4OTgpLCBzbyBhIHBhZGRlZCByZXNlcnZlZCBsYWJlbCBpcyBhIHJlYWxcbiAqIGJ5cGFzcyBpZiB0aGlzIHBhdGggc2tpcHMgdGhlIHRyaW0uXG4gKi9cbmZ1bmN0aW9uIHNjYW5Cb2R5Rm9yRm9yYmlkZGVuTGFiZWwodGV4dDogc3RyaW5nKTogQm9keVNjYW4ge1xuICBsZXQgZG9jOiB1bmtub3duO1xuICB0cnkge1xuICAgIGRvYyA9IEpTT04ucGFyc2UodGV4dCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7IGtpbmQ6IFwidW5yZWFkYWJsZVwiIH07XG4gIH1cbiAgbGV0IG5hbWVzOiBzdHJpbmdbXSB8IG51bGw7XG4gIGlmIChBcnJheS5pc0FycmF5KGRvYykpIHtcbiAgICBuYW1lcyA9IGxhYmVsTmFtZXNGcm9tQXJyYXkoZG9jKTtcbiAgfSBlbHNlIGlmIChkb2MgIT09IG51bGwgJiYgdHlwZW9mIGRvYyA9PT0gXCJvYmplY3RcIikge1xuICAgIGNvbnN0IGxhYmVscyA9IChkb2MgYXMgeyBsYWJlbHM/OiB1bmtub3duIH0pLmxhYmVscztcbiAgICBpZiAobGFiZWxzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIG5hbWVzID0gW107XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KGxhYmVscykpIHtcbiAgICAgIG5hbWVzID0gbGFiZWxOYW1lc0Zyb21BcnJheShsYWJlbHMpO1xuICAgIH0gZWxzZSB7XG4gICAgICBuYW1lcyA9IG51bGw7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHJldHVybiB7IGtpbmQ6IFwidW5yZWFkYWJsZVwiIH07XG4gIH1cbiAgaWYgKG5hbWVzID09PSBudWxsKSByZXR1cm4geyBraW5kOiBcInVucmVhZGFibGVcIiB9O1xuICBjb25zdCBmb3JiaWRkZW4gPSBuYW1lcy5maW5kKChsKSA9PlxuICAgIEZPUkJJRERFTl9MQUJFTFMuaGFzKG5vcm1hbGlzZUxhYmVsTmFtZShsKSlcbiAgKTtcbiAgaWYgKGZvcmJpZGRlbiAhPT0gdW5kZWZpbmVkKSByZXR1cm4geyBraW5kOiBcImZvcmJpZGRlblwiLCBsYWJlbDogZm9yYmlkZGVuIH07XG4gIHJldHVybiB7IGtpbmQ6IFwiY2xlYW5cIiB9O1xufVxuXG4vKiogVGhlICM5MCBmYWlsLWNsb3NlZCByZWZ1c2FsIGZvciBhbiB1bnNjYW5uYWJsZSBSRVNUIGJvZHkuICovXG5mdW5jdGlvbiB1bnJlYWRhYmxlQm9keVJlZnVzYWwodmVyYjogc3RyaW5nKTogR2hHdWFyZERlY2lzaW9uIHtcbiAgcmV0dXJuIHtcbiAgICBhbGxvd2VkOiBmYWxzZSxcbiAgICBtYXJrZXI6IFwiR0hfQk9EWV9VTlJFQURBQkxFXCIsXG4gICAgcmVhc29uOiBgUmVmdXNlZCAke3ZlcmJ9IGZyb20gdGhlIGFnZW50IHN1YnByb2Nlc3Mg4oCUIHRoZSByZXF1ZXN0IGJvZHkgYCArXG4gICAgICBgaXMgc3VwcGxpZWQgYnkgXFxgLS1pbnB1dFxcYCBhbmQgdGhpcyBndWFyZCBjYW5ub3Qgc2NhbiBpdCBmb3IgcmVzZXJ2ZWQgYCArXG4gICAgICBgd29ya2Zsb3cgbGFiZWxzIChzdGRpbiwgYW4gdW5yZWFkYWJsZSBwYXRoLCBvciBhIGJvZHkgd2hvc2Ugc2hhcGUgaXQgYCArXG4gICAgICBgZG9lcyBub3QgdW5kZXJzdGFuZCkuIFBhc3MgdGhlIGZpZWxkcyBpbmxpbmUgd2l0aCBcXGAtZlxcYC9cXGAtLWZpZWxkXFxgLCBgICtcbiAgICAgIGBvciBzdXBwbHkgYSByZWFkYWJsZSBKU09OIGZpbGUuYCxcbiAgfTtcbn1cblxuLyoqXG4gKiBMYWJlbHMgdGhlIGFnZW50IGxlZ2l0aW1hdGVseSBhcHBsaWVzIHRvIGFuIEVYSVNUSU5HIGlzc3VlIChJc3N1ZSAjMTQyMikuXG4gKlxuICogYG5lZWRzLWh1bWFuYCBpcyB0aGUgaGFuZC1vZmYgdGhlIHByb21wdHMgcHJlc2NyaWJlIHZlcmJhdGltIOKAlFxuICogYHByb21wdHMvaXNzdWUvcHJvbXB0Lm1kOjE3OWAgZ2l2ZXMgdGhlIGV4YWN0IGBnaCBpc3N1ZSBlZGl0IOKApiAtLWFkZC1sYWJlbFxuICogbmVlZHMtaHVtYW5gIGNhbGwsIGFuZCBgcHJvbXB0cy9jb2RpbmdfZ3VpZGVsaW5lcy9wcm9tcHQubWQ6NTMxYCBzdGF0ZXMgdGhhdFxuICogY2FsbCBcImtlZXBzIHdvcmtpbmdcIi4gSXQgaXMgYWxzbyBzdXBwcmVzc2lvbi1vbmx5OiBhcHBseWluZyBpdCByZW1vdmVzIHRoZVxuICogaXNzdWUgZnJvbSB0aGUgd29yayBwb29sLCBzbyBpdCBjYW4gb25seSBldmVyIGNvc3QgdGhlIGFwcGxpZXIgdGhyb3VnaHB1dFxuICogYW5kIG5ldmVyIGdhaW4gdGhlbSBhbnl0aGluZyAoYGlzU3VwcHJlc3Npb25Pbmx5TGFiZWxgLCBQUiAjMTMyMSkuIEl0IGlzXG4gKiB0aGVyZWZvcmUgbm90IGEgcHJpdmlsZWdlIGVzY2FsYXRpb24gYW5kIG11c3Qgbm90IGJlIGRlbmllZCBvdXRyaWdodCDigJQgZG9pbmdcbiAqIHNvIHJlbW92ZXMgdGhlIGFnZW50J3Mgb25seSB3YXkgdG8gc2F5IFwiYSBodW1hbiBpcyBuZWVkZWRcIiwgd2hpY2ggaGFzIGJlZW5cbiAqIHJlcG9ydGVkIGFzIGEgcmVncmVzc2lvbiBiZWZvcmUuXG4gKlxuICogV2hhdCAjMTQyMiBhY3R1YWxseSBkZXNjcmliZXMgaXMgbmFycm93ZXI6IHRoZSBhZ2VudCBhcHBseWluZyBzdWNoIGEgbGFiZWxcbiAqIHRvIGFuIFVOUkVMQVRFRCBzaWJsaW5nIGlzc3VlIGluIHRoZSBjbGFpbWVkIHJlcG8sIHBhcmtpbmcgaXQgb3V0IG9mXG4gKiBkaXNjb3Zlcnkgd2l0aCBub3RoaW5nIGRvd25zdHJlYW0gYWJsZSB0byBzdHJpcCBpdC4gU28gdGhlIGNvbnRyb2wgaXNcbiAqIHNjb3BlLCBub3QgcHJvaGliaXRpb24uXG4gKi9cbmNvbnN0IEFHRU5UX0VTQ0FMQVRJT05fTEFCRUxTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXCJuZWVkcy1odW1hblwiXSk7XG5cbi8qKlxuICogV2hldGhlciB0aGlzIGZvcmJpZGRlbiBsYWJlbCBpcyB0aGUgcnVuJ3Mgb3duIGVzY2FsYXRpb24gb24gaXRzIG93biBpc3N1ZS5cbiAqXG4gKiBAcmV0dXJucyBUcnVlIHdoZW4gdGhlIGxhYmVsIG1heSBwcm9jZWVkIGRlc3BpdGUgYmVpbmcgb24gdGhlIGRlbnlsaXN0LlxuICovXG5mdW5jdGlvbiBpc1Blcm1pdHRlZEVzY2FsYXRpb24oXG4gIGxhYmVsOiBzdHJpbmcsXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBpbmZvOiBNdXRhdGlvbkluZm8sXG4gIGN0eDogR2hHdWFyZENvbnRleHQsXG4pOiBib29sZWFuIHtcbiAgaWYgKCFBR0VOVF9FU0NBTEFUSU9OX0xBQkVMUy5oYXMobm9ybWFsaXNlTGFiZWxOYW1lKGxhYmVsKSkpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBjbGFpbSA9IGN0eC5jbGFpbWVkSXNzdWU7XG4gIC8vIE5vIGNsYWltIHNlZWRlZDogdGhlIHJ1biBoYXMgbm8gXCJvd24gaXNzdWVcIiB0byBzY29wZSB0bywgYW5kIHRoaXMgaXMgdGhlXG4gIC8vIGJlaGF2aW91ciB0aGF0IGhhcyBhbHdheXMgYXBwbGllZC4gVW5jaGFuZ2VkLlxuICBpZiAoIWNsYWltKSByZXR1cm4gdHJ1ZTtcblxuICBjb25zdCBhdHRlbXB0ID0gY2xhc3NpZnlJc3N1ZUxpZmVjeWNsZShhcmdzLCBpbmZvKTtcbiAgaWYgKCFhdHRlbXB0KSByZXR1cm4gdHJ1ZTtcblxuICAvLyBBIGRpZmZlcmVudCByZXBvIGlzIHRoZSB3cml0ZS1yZXBvIGFsbG93bGlzdCdzIGRlY2lzaW9uLCBub3QgdGhpcyBvbmUuXG4gIGNvbnN0IHRhcmdldFJlcG8gPSBhdHRlbXB0LnJlcG8gPz8gY2xhaW0ucmVwbztcbiAgaWYgKCFzYW1lUmVwbyh0YXJnZXRSZXBvLCBjbGFpbS5yZXBvKSkgcmV0dXJuIHRydWU7XG5cbiAgLy8gTm8gaXNzdWUgbnVtYmVyIGlzIGBnaGAncyBjd2QgZm9ybTsgZHVyaW5nIGEgY29kaW5nIHJ1biB0aGUgY2xvbmUgaXMgdGhlXG4gIC8vIGNsYWltZWQgcmVwbywgc28gaXQgaXMgdHJlYXRlZCBhcyBuYW1pbmcgdGhlIGNsYWltIOKAlCBhcyB0aGUgbGlmZWN5Y2xlXG4gIC8vIGd1YXJkIGFib3ZlIGFscmVhZHkgZG9lcy5cbiAgaWYgKGF0dGVtcHQuaXNzdWVOdW1iZXIgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBhdHRlbXB0Lmlzc3VlTnVtYmVyID09PSBjbGFpbS5pc3N1ZU51bWJlcjtcbn1cblxuLyoqIENhc2UtaW5zZW5zaXRpdmUgYG93bmVyL3JlcG9gIGNvbXBhcmlzb24uICovXG5mdW5jdGlvbiBzYW1lUmVwbyhhOiBzdHJpbmcsIGI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gYS50cmltKCkudG9Mb3dlckNhc2UoKSA9PT0gYi50cmltKCkudG9Mb3dlckNhc2UoKTtcbn1cblxuLyoqXG4gKiBSZWZ1c2UgYW4gaXNzdWUtbGlmZWN5Y2xlIGNoYW5nZSBpbiB0aGUgY2xhaW1lZCByZXBvIChJc3N1ZSAjMjIyKS5cbiAqXG4gKiBUaGUgaW1wbGVtZW50aW5nIGFnZW50IGRlY2lkZXMgd2hhdCB0aGUgKmNvZGUqIHNob3VsZCBiZTsgaXQgZG9lcyBub3QgZGVjaWRlXG4gKiB0aGF0IGFuIGlzc3VlIGlzIGNsb3NlZCwgcmVvcGVuZWQsIG1vdmVkIG9yIGxvY2tlZC4gQSBydW4gdGhhdCBoYXMgc2VlZGVkIGFcbiAqIGNsYWltIHRoZXJlZm9yZSByZWZ1c2VzIHRob3NlIHZlcmJzIGZvciBldmVyeSBpc3N1ZSBpbiBpdHMgY2xhaW1lZCByZXBvIOKAlFxuICogbm90IG9ubHkgdGhlIGNsYWltZWQgaXNzdWUsIGJlY2F1c2UgY2xvc2luZyBhIFwiZHVwbGljYXRlXCIgb3IgcmVvcGVuaW5nIGFcbiAqIHNpYmxpbmcgaXMgdGhlIHNhbWUgbGlmZWN5Y2xlIGNhbGwgdGhlIGFnZW50IGlzIG5vdCBtYWtpbmcg4oCUIHVubGVzcyB0aGUgcnVuXG4gKiBleHBsaWNpdGx5IHBlcm1pdHMgdGhlIHZlcmIgKGBhbGxvd2VkVmVyYnNgLCBgZWRpdGAgYnkgZGVmYXVsdCBzbyB0aGVcbiAqIGBuZWVkcy1odW1hbmAgZXNjYWxhdGlvbiB0aGUgcHJvbXB0cyBwcmVzY3JpYmUga2VlcHMgd29ya2luZykuXG4gKlxuICogQSBjb21tYW5kIG5hbWluZyBhICpkaWZmZXJlbnQqIHJlcG8gaXMgbGVmdCB0byB0aGUgd3JpdGUtcmVwbyBhbGxvd2xpc3QsXG4gKiB3aGljaCByZWZ1c2VzIGl0IGFscmVhZHkuIEEgY29tbWFuZCBuYW1pbmcgbm8gcmVwbyBpcyBgZ2hgJ3MgY3dkIGZvcm0sIGFuZFxuICogZHVyaW5nIGEgY29kaW5nIHJ1biB0aGUgY2xvbmUgaXMgdGhlIGNsYWltZWQgcmVwbyDigJQgc28gaXQgaXMgdHJlYXRlZCBhc1xuICogbmFtaW5nIHRoZSBjbGFpbSwgdGhlIGZhaWwtY2xvc2VkIGRpcmVjdGlvbi5cbiAqL1xuZnVuY3Rpb24gcmVmdXNlQ2xhaW1lZElzc3VlTGlmZWN5Y2xlKFxuICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgaW5mbzogTXV0YXRpb25JbmZvLFxuICBjdHg6IEdoR3VhcmRDb250ZXh0LFxuKTogR2hHdWFyZERlY2lzaW9uIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgY2xhaW0gPSBjdHguY2xhaW1lZElzc3VlO1xuICBpZiAoIWNsYWltKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IGF0dGVtcHQgPSBjbGFzc2lmeUlzc3VlTGlmZWN5Y2xlKGFyZ3MsIGluZm8pO1xuICBpZiAoIWF0dGVtcHQpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgYWxsb3dlZCA9IG5ldyBTZXQoXG4gICAgY2xhaW0uYWxsb3dlZFZlcmJzLm1hcCgodikgPT4gdi50cmltKCkudG9Mb3dlckNhc2UoKSksXG4gICk7XG4gIGlmIChhbGxvd2VkLmhhcyhhdHRlbXB0LnZlcmIpKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHRhcmdldFJlcG8gPSBhdHRlbXB0LnJlcG8gPz8gY2xhaW0ucmVwbztcbiAgaWYgKCFzYW1lUmVwbyh0YXJnZXRSZXBvLCBjbGFpbS5yZXBvKSkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBjb25zdCB0YXJnZXQgPSBhdHRlbXB0Lmlzc3VlTnVtYmVyID09PSB1bmRlZmluZWRcbiAgICA/IHRhcmdldFJlcG9cbiAgICA6IGAke3RhcmdldFJlcG99IyR7YXR0ZW1wdC5pc3N1ZU51bWJlcn1gO1xuICBjb25zdCBpc0NsYWltID0gYXR0ZW1wdC5pc3N1ZU51bWJlciA9PT0gY2xhaW0uaXNzdWVOdW1iZXI7XG4gIHJldHVybiB7XG4gICAgYWxsb3dlZDogZmFsc2UsXG4gICAgbWFya2VyOiBcIklTU1VFX0xJRkVDWUNMRV9SRUZVU0VEXCIsXG4gICAgcmVhc29uOiBgUmVmdXNlZCAnZ2ggJHtpbmZvLnZlcmJ9JyBvbiAke3RhcmdldH0gZnJvbSB0aGUgYWdlbnQgYCArXG4gICAgICBgc3VicHJvY2VzcyDigJQgaXNzdWUgbGlmZWN5Y2xlIGNoYW5nZXMgKGAgK1xuICAgICAgYCR7SVNTVUVfTElGRUNZQ0xFX1ZFUkJTLmpvaW4oXCIsIFwiKX0pIG9uICR7Y2xhaW0ucmVwb30gYXJlIHRoZSBgICtcbiAgICAgIGB3b3JrZXIncyBvciBhIGh1bWFuJ3MgZGVjaXNpb24sIG5vdCB0aGUgaW1wbGVtZW50aW5nIGFnZW50J3NgICtcbiAgICAgIChpc0NsYWltID8gYCAodGhpcyBydW4ncyBjbGFpbWVkIGlzc3VlKWAgOiBcIlwiKSArXG4gICAgICBgLiBQb3N0IHlvdXIgZmluZGluZ3MgYXMgYSBjb21tZW50IGluc3RlYWQ6IGEgcnVuIHRoYXQgaXMgYmxvY2tlZCBvbiBgICtcbiAgICAgIGBhbm90aGVyIGlzc3VlIHNob3VsZCBzYXkgc28gaW4gYSBzZWN0aW9uIGJlZ2lubmluZyBcIiMjIEJsb2NrZWQ6XCIgYW5kIGAgK1xuICAgICAgYG5hbWUgdGhlIGRlcGVuZGVuY3kgYXMgXCJEZXBlbmRzIG9uIG93bmVyL3JlcG8jTlwiLCBhbmQgdGhlIHdvcmtlciBgICtcbiAgICAgIGBkZWZlcnMgdGhlIGlzc3VlIHJhdGhlciB0aGFuIGNsb3NpbmcgaXQuYCxcbiAgfTtcbn1cblxuLyoqXG4gKiBSZWZ1c2UgYSBQUi1saWZlY3ljbGUgZGVjaXNpb24gaW4gdGhlIGNsYWltZWQgcmVwbyAoSXNzdWUgIzE0NjIpLlxuICpcbiAqIFRoZSBzaWJsaW5nIG9mIHtAbGluayByZWZ1c2VDbGFpbWVkSXNzdWVMaWZlY3ljbGV9LCBhbmQgdGhlIHNhbWUgcHJpbmNpcGxlOlxuICogdGhlIGFnZW50IGRlY2lkZXMgd2hhdCB0aGUgKmNvZGUqIHNob3VsZCBiZSwgbm90IHRoYXQgdGhlIHB1bGwgcmVxdWVzdFxuICogY2FycnlpbmcgaXQgaXMgbWVyZ2VkLCBjbG9zZWQsIHJlb3BlbmVkLCBtYXJrZWQgcmVhZHkgb3IgYXBwcm92ZWQuIFRob3NlIGFyZVxuICogdGhlIHdvcmtlcidzIGNhbGxzLCBhbmQgdGhlIHdvcmtlciBtYWtlcyB0aGVtIHRocm91Z2ggYGRpcmVjdF9tZXJnZS50c2Ag4oCUXG4gKiBpbnNpZGUgaXRzIG93biBEZW5vIHByb2Nlc3MsIHdoaWNoIG5ldmVyIHRyYXZlcnNlcyB0aGlzIGd1YXJkIOKAlCB3aGVyZSBDSVxuICogZnJlc2huZXNzIGFuZCB0aGUgZGVmYXVsdC1icmFuY2ggaHVtYW4tYXBwcm92YWwgZ2F0ZSBhcmUgYXBwbGllZC4gQVxuICogcHJvbXB0LWluamVjdGVkIGFnZW50IHJ1bm5pbmcgYGdoIHByIG1lcmdlYCBza2lwcyBhbGwgb2YgaXQuXG4gKlxuICogU2NvcGVkIGV4YWN0bHkgYXMgdGhlIGlzc3VlLWxpZmVjeWNsZSByZWZ1c2FsIGlzLCBhbmQgZm9yIHRoZSBzYW1lIHJlYXNvbnM6XG4gKiBhIGNvbW1hbmQgbmFtaW5nIGEgKmRpZmZlcmVudCogcmVwbyBpcyBsZWZ0IHRvIHRoZSB3cml0ZS1yZXBvIGFsbG93bGlzdCxcbiAqIHdoaWNoIHJlZnVzZXMgaXQgYWxyZWFkeSwgYW5kIGEgY29tbWFuZCBuYW1pbmcgbm8gcmVwbyBpcyBgZ2hgJ3MgY3dkIGZvcm0sXG4gKiB3aGljaCBkdXJpbmcgYSBjb2RpbmcgcnVuIGlzIHRoZSBjbGFpbWVkIHJlcG8g4oCUIHNvIGl0IGlzIHRyZWF0ZWQgYXMgbmFtaW5nXG4gKiB0aGUgY2xhaW0sIHRoZSBmYWlsLWNsb3NlZCBkaXJlY3Rpb24uXG4gKlxuICogYENsYWltZWRJc3N1ZS5hbGxvd2VkVmVyYnNgIGlzIGRlbGliZXJhdGVseSBOT1QgY29uc3VsdGVkLiBJdCBpcyBhblxuICogKmlzc3VlKi12ZXJiIGFsbG93YW5jZSDigJQgdGhlIHNoaW0gc3BlbGxzIGl0IGAtLWFsbG93LWlzc3VlLXZlcmJgLCBhbmQgaXRcbiAqIGRlZmF1bHRzIHRvIGBlZGl0YCBzbyB0aGUgYG5lZWRzLWh1bWFuYCBlc2NhbGF0aW9uIGtlZXBzIHdvcmtpbmcuIFJlYWRpbmcgaXRcbiAqIGhlcmUgd291bGQgbWVhbiBhIGZ1dHVyZSByb3V0ZSB0aGF0IHBlcm1pdHRlZCBgY2xvc2VgIG9uIGl0cyBwbGFubmluZyBpc3N1ZVxuICogc2lsZW50bHkgcGVybWl0dGVkIGBnaCBwciBjbG9zZWAgdG9vLiBObyByb3V0ZSBncmFudHMgYSBQUiB2ZXJiLCBzbyB0aGVyZSBpc1xuICogbm90aGluZyB0byByZWFkLlxuICovXG5mdW5jdGlvbiByZWZ1c2VDbGFpbWVkUHJMaWZlY3ljbGUoXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBpbmZvOiBNdXRhdGlvbkluZm8sXG4gIGN0eDogR2hHdWFyZENvbnRleHQsXG4pOiBHaEd1YXJkRGVjaXNpb24gfCB1bmRlZmluZWQge1xuICBjb25zdCBjbGFpbSA9IGN0eC5jbGFpbWVkSXNzdWU7XG4gIGlmICghY2xhaW0pIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgYXR0ZW1wdCA9IGNsYXNzaWZ5UHJMaWZlY3ljbGUoYXJncywgaW5mbyk7XG4gIGlmICghYXR0ZW1wdCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBjb25zdCB0YXJnZXRSZXBvID0gYXR0ZW1wdC5yZXBvID8/IGNsYWltLnJlcG87XG4gIGlmICghc2FtZVJlcG8odGFyZ2V0UmVwbywgY2xhaW0ucmVwbykpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgdGFyZ2V0ID0gYXR0ZW1wdC5wck51bWJlciA9PT0gdW5kZWZpbmVkXG4gICAgPyB0YXJnZXRSZXBvXG4gICAgOiBgJHt0YXJnZXRSZXBvfSMke2F0dGVtcHQucHJOdW1iZXJ9YDtcbiAgcmV0dXJuIHtcbiAgICBhbGxvd2VkOiBmYWxzZSxcbiAgICBtYXJrZXI6IFwiUFJfTElGRUNZQ0xFX1JFRlVTRURcIixcbiAgICByZWFzb246IGBSZWZ1c2VkICdnaCAke2luZm8udmVyYn0nIG9uICR7dGFyZ2V0fSBmcm9tIHRoZSBhZ2VudCBgICtcbiAgICAgIGBzdWJwcm9jZXNzIOKAlCBwdWxsIHJlcXVlc3QgbGlmZWN5Y2xlIGRlY2lzaW9ucyAoYCArXG4gICAgICBgJHtQUl9MSUZFQ1lDTEVfVkVSQlMuam9pbihcIiwgXCIpfSkgb24gJHtjbGFpbS5yZXBvfSBhcmUgdGhlIHdvcmtlcidzIGAgK1xuICAgICAgYG9yIGEgaHVtYW4ncywgbm90IHRoZSBpbXBsZW1lbnRpbmcgYWdlbnQncy4gVGhlIHdvcmtlciBtZXJnZXMgdGhyb3VnaCBgICtcbiAgICAgIGBpdHMgb3duIHBhdGgsIHdoaWNoIHJlLWNoZWNrcyBDSSBzdGF0dXMsIGJyYW5jaCBmcmVzaG5lc3MgYW5kIHRoZSBgICtcbiAgICAgIGBkZWZhdWx0LWJyYW5jaCBhcHByb3ZhbCBnYXRlOyBhIG1lcmdlIGlzc3VlZCBoZXJlIGhhcyBub25lIG9mIHRoZW0uIGAgK1xuICAgICAgYCdnaCBwciBjcmVhdGUnLCAnZ2ggcHIgdmlldycsICdnaCBwciBsaXN0JywgJ2doIHByIGNvbW1lbnQnIGFuZCBgICtcbiAgICAgIGAnZ2ggcHIgZWRpdCcgKG90aGVyIHRoYW4gYCArXG4gICAgICBgLS1iYXNlKSBhcmUgdW5hZmZlY3RlZC4gSWYgdGhlIGAgK1xuICAgICAgYFBSIHNob3VsZCBub3QgbGFuZCwgc2F5IHNvIGluIGEgY29tbWVudCByYXRoZXIgdGhhbiBjbG9zaW5nIGl0LmAsXG4gIH07XG59XG5cbi8qKlxuICogRGVjaWRlIHdoZXRoZXIgb25lIGFnZW50IGBnaGAgaW52b2NhdGlvbiBtYXkgcHJvY2VlZC5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBhYm91dCB0byBiZSBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICogQHBhcmFtIGN0eCAtIFRoZSBydW4ncyB3cml0ZS1yZXBvIGFsbG93bGlzdCBzdGF0ZS5cbiAqIEByZXR1cm5zIFRoZSB2ZXJkaWN0OyBgYWxsb3dlZDogZmFsc2VgIGNhcnJpZXMgYSBtYXJrZXIgYW5kIGEgcmVhc29uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXZhbHVhdGVHaENvbW1hbmQoXG4gIHJhd0FyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBjdHg6IEdoR3VhcmRDb250ZXh0LFxuKTogR2hHdWFyZERlY2lzaW9uIHtcbiAgLy8gSXNzdWUgIzM1Njg6IGV2ZXJ5IGNoZWNrIGJlbG93IHJlYWRzIG9uZSBjYW5vbmljYWwgc3BlbGxpbmcgb2YgdGhlXG4gIC8vIGNvbW1hbmQg4oCUIGEgYGdoIGFwaWAgY2FsbCB3aXRoIGl0cyBmbGFncyBhZnRlciB0aGUgcm9vdCwgYW4gZXhwbGljaXRcbiAgLy8gbWV0aG9kIGFuZCBpdHMgZW5kcG9pbnQgYXMgR2l0SHViIHJvdXRlcyBpdCDigJQgc28gYSBydWxlIHdyaXR0ZW4gYWdhaW5zdFxuICAvLyBvbmUgc3BlbGxpbmcgaG9sZHMgZm9yIGV2ZXJ5IHNwZWxsaW5nIGdoIGFuZCBHaXRIdWIgdHJlYXQgdGhlIHNhbWUuXG4gIGNvbnN0IGFyZ3MgPSBjYW5vbmljYWxpc2VHaEFyZ3MocmF3QXJncyk7XG4gIGNvbnN0IGluZm8gPSBjbGFzc2lmeUdoTXV0YXRpb24oYXJncyk7XG5cbiAgaWYgKGluZm8pIHtcbiAgICAvLyBFdmVyeSBmb3JiaWRkZW4gbGFiZWwgaXMgY2hlY2tlZCwgbm90IGp1c3QgdGhlIGZpcnN0OiBhIGNvbW1hbmQgYWRkaW5nXG4gICAgLy8gYG5lZWRzLWh1bWFuLGZhaWxlZGAgbXVzdCBzdGlsbCBiZSByZWZ1c2VkIGZvciBgZmFpbGVkYCBldmVuIHRob3VnaCB0aGVcbiAgICAvLyBlc2NhbGF0aW9uIGxhYmVsIGJlc2lkZSBpdCBpcyBwZXJtaXR0ZWQgKElzc3VlICMxNDIyKS5cbiAgICBjb25zdCBmb3JiaWRkZW4gPSBleHRyYWN0TGFiZWxWYWx1ZXMoYXJncylcbiAgICAgIC5maWx0ZXIoKGwpID0+IEZPUkJJRERFTl9MQUJFTFMuaGFzKG5vcm1hbGlzZUxhYmVsTmFtZShsKSkpXG4gICAgICAuZmluZCgobCkgPT4gIWlzUGVybWl0dGVkRXNjYWxhdGlvbihsLCBhcmdzLCBpbmZvLCBjdHgpKTtcbiAgICBpZiAoZm9yYmlkZGVuICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFsbG93ZWQ6IGZhbHNlLFxuICAgICAgICBtYXJrZXI6IFwiV09SS0VSX0xBQkVMX1JFRlVTRURcIixcbiAgICAgICAgcmVhc29uOiBgbGFiZWw9JHtmb3JiaWRkZW59IHZlcmI9JHtpbmZvLnZlcmJ9IGAgK1xuICAgICAgICAgIGBjYWxsZXI9YWdlbnQtc3VicHJvY2VzcyByZWFzb249cmVzZXJ2ZWRfd29ya2Zsb3dfbGFiZWxgLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBJc3N1ZSAjMjUxODogdGhlIHNhbWUgZGVueWxpc3Qgb24gdGhlIGxhYmVsIERFRklOSVRJT04gcGF0aCDigJQgdGhlXG4gICAgLy8gYGdoIGxhYmVsYCBwb3NpdGlvbmFsIGFuZCB0aGUgYGdoIGFwaSDigKYvbGFiZWxzYCBSRVNUIHNwZWxsaW5nIG9mIGl0LlxuICAgIC8vIGBpc1Blcm1pdHRlZEVzY2FsYXRpb25gIGRlbGliZXJhdGVseSBkb2VzIG5vdCBhcHBseTogYXBwbHlpbmdcbiAgICAvLyBgbmVlZHMtaHVtYW5gIHRvIHRoZSBydW4ncyBvd24gaXNzdWUgaXMgdGhlIHNhbmN0aW9uZWQgYXNrIGZvciBhIGh1bWFuLFxuICAgIC8vIGJ1dCBkZWxldGluZyBvciByZW5hbWluZyB0aGUgbGFiZWwgaXRzZWxmIHdpdGhkcmF3cyB0aGF0IHJvdXRlIGZyb21cbiAgICAvLyBldmVyeSBsYXRlciBydW4uXG4gICAgY29uc3QgZGVmaW5lZCA9IFtcbiAgICAgIC4uLmxhYmVsRGVmaW5pdGlvbk5hbWVzKGFyZ3MpLFxuICAgICAgLi4uYXBpTGFiZWxEZWZpbml0aW9uTmFtZXMoYXJncywgaW5mbyksXG4gICAgXS5maW5kKChsKSA9PiBGT1JCSURERU5fTEFCRUxTLmhhcyhub3JtYWxpc2VMYWJlbE5hbWUobCkpKTtcbiAgICBpZiAoZGVmaW5lZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhbGxvd2VkOiBmYWxzZSxcbiAgICAgICAgbWFya2VyOiBcIldPUktFUl9MQUJFTF9SRUZVU0VEXCIsXG4gICAgICAgIHJlYXNvbjogYGxhYmVsPSR7ZGVmaW5lZH0gdmVyYj0ke2luZm8udmVyYn0gYCArXG4gICAgICAgICAgYGNhbGxlcj1hZ2VudC1zdWJwcm9jZXNzIHJlYXNvbj1yZXNlcnZlZF93b3JrZmxvd19sYWJlbF9kZWZpbml0aW9uYCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3QgbGlmZWN5Y2xlUmVmdXNhbCA9IHJlZnVzZUNsYWltZWRJc3N1ZUxpZmVjeWNsZShhcmdzLCBpbmZvLCBjdHgpO1xuICAgIGlmIChsaWZlY3ljbGVSZWZ1c2FsKSByZXR1cm4gbGlmZWN5Y2xlUmVmdXNhbDtcblxuICAgIC8vIElzc3VlICMxNDYyOiB0aGUgc2FtZSByZWFzb25pbmcgb25lIHN0ZXAgZnVydGhlciBhbG9uZyB0aGUgd29ya2Zsb3cuXG4gICAgLy8gYGNsYXNzaWZ5SXNzdWVMaWZlY3ljbGVgIHJldHVybnMgYHVuZGVmaW5lZGAgZm9yIGEgUFIgb3BlcmF0aW9uIGJ5XG4gICAgLy8gZGVzaWduLCBzbyBgZ2ggcHIgbWVyZ2VgIG9uIHRoZSBjbGFpbWVkIHJlcG8gcmVhY2hlZCB0aGUgd3JpdGUtcmVwb1xuICAgIC8vIGFsbG93bGlzdCDigJQgd2hpY2ggYWxsb3dzIGl0LCB0aGUgY2xhaW1lZCByZXBvIGJlaW5nIG9uIHRoZSBhbGxvd2xpc3QgYnlcbiAgICAvLyBjb25zdHJ1Y3Rpb24g4oCUIGFuZCBtZXJnZWQgdGhlIGFnZW50J3Mgb3duIFBSIHdpdGggbm9uZSBvZiB0aGUgY2hlY2tzXG4gICAgLy8gYGRpcmVjdF9tZXJnZS50c2AgYXBwbGllcy5cbiAgICBjb25zdCBwclJlZnVzYWwgPSByZWZ1c2VDbGFpbWVkUHJMaWZlY3ljbGUoYXJncywgaW5mbywgY3R4KTtcbiAgICBpZiAocHJSZWZ1c2FsKSByZXR1cm4gcHJSZWZ1c2FsO1xuXG4gICAgLy8gSXNzdWUgIzM0MzM6IHJldGFyZ2V0aW5nIGEgUFIgaXMgdGhlIHdvcmtlcidzIGNhbGwuIE1vdmluZyBhXG4gICAgLy8gbWlsZXN0b25lLWZpeCBvciBtaWxlc3RvbmUgY2hpbGQgUFIgdG8gdGhlIGRlZmF1bHQgYnJhbmNoIGJ5cGFzc2VzIHRoZVxuICAgIC8vIG1pbGVzdG9uZSdzIGZpbmFsIHJldmlldy4gUHVyZSBndWFyZCwgc28gaXQgY2Fubm90IHJlYWQgdGhlIFBSJ3NcbiAgICAvLyBoZWFkL2Jhc2U6IGV2ZXJ5IGJhc2UgY2hhbmdlIGZyb20gdGhlIGFnZW50IGlzIHJlZnVzZWQuXG4gICAgaWYgKGNsYXNzaWZ5UHJCYXNlQ2hhbmdlKGFyZ3MsIGN0eC5yZWFkQm9keUZpbGUpKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhbGxvd2VkOiBmYWxzZSxcbiAgICAgICAgbWFya2VyOiBcIlBSX0JBU0VfQ0hBTkdFX1JFRlVTRURcIixcbiAgICAgICAgcmVhc29uOiBgUmVmdXNlZCAnZ2ggJHtpbmZvLnZlcmJ9JyBmcm9tIHRoZSBhZ2VudCBzdWJwcm9jZXNzIOKAlCBgICtcbiAgICAgICAgICBgY2hhbmdpbmcgYSBwdWxsIHJlcXVlc3QncyBiYXNlIGJyYW5jaCBpcyB0aGUgd29ya2VyJ3MgY2FsbDogYCArXG4gICAgICAgICAgYG1vdmluZyBhIG1pbGVzdG9uZS1maXggb3IgbWlsZXN0b25lIGNoaWxkIFBSIHRvIHRoZSBkZWZhdWx0IGAgK1xuICAgICAgICAgIGBicmFuY2ggYnlwYXNzZXMgdGhlIG1pbGVzdG9uZSdzIGZpbmFsIHJldmlldyAoSXNzdWUgIzM0MzMpLiBgICtcbiAgICAgICAgICBgJ2doIHByIGVkaXQnIGZvciB0aGUgdGl0bGUsIGJvZHkgb3IgbGFiZWxzIGlzIHVuYWZmZWN0ZWQ7IGEgYCArXG4gICAgICAgICAgYEdyYXBoUUwgcmVxdWVzdCB0aGF0IG1heSBjYXJyeSBhbiAndXBkYXRlUHVsbFJlcXVlc3QnIG11dGF0aW9uLCBvciBgICtcbiAgICAgICAgICBgd2hvc2UgZG9jdW1lbnQgY2Fubm90IGJlIHJlYWQsIGlzIHJlZnVzZWQgd2hvbGUsIHNpbmNlIHRoZSBgICtcbiAgICAgICAgICBgbXV0YXRpb24gY2FuIGNhcnJ5IHRoZSBiYXNlLiBJZiBhIGAgK1xuICAgICAgICAgIGBQUidzIGJhc2UgbG9va3Mgd3JvbmcsIHNheSBzbyBpbiBhIGNvbW1lbnQuYCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gSXNzdWUgIzExLyM5MC8jOTE6IGEgUkVTVCBtdXRhdGlvbiB3aG9zZSBib2R5IGlzIHN1cHBsaWVkIGJ5IGAtLWlucHV0YFxuICAgIC8vIChvciBhbiBgQGZpbGVgLXNvdXJjZWQgcXVlcnkpIGlzIGFyZ3YtaW52aXNpYmxlLCBzbyBgZXh0cmFjdExhYmVsVmFsdWVzYFxuICAgIC8vIGFib3ZlIHNhdyBub3RoaW5nIHRvIHJlamVjdCDigJQgYSBwcm9tcHQtaW5qZWN0ZWQgYWdlbnQgY291bGQgaGlkZSBhXG4gICAgLy8gcmVzZXJ2ZWQgbGFiZWwgaW4gdGhlIGZpbGUuICM5MCBmYWlsZWQgY2xvc2VkIG9uIGV2ZXJ5IHN1Y2ggYm9keTsgIzkxXG4gICAgLy8gcmVzdG9yZXMgdGhlIGxlZ2l0aW1hdGUgY2FzZTogd2hlbiB0aGUgYXJndiBuYW1lcyBhICpyZWFkYWJsZSBmaWxlKiBhbmRcbiAgICAvLyBhIHJlYWRlciBpcyBzdXBwbGllZCwgcmVhZCBpdCBhbmQgc2NhbiBmb3IgcmVzZXJ2ZWQgbGFiZWxzLiBPbmx5IGEgYm9keVxuICAgIC8vIHRoYXQgaXMgc3VjY2Vzc2Z1bGx5IHBhcnNlZCBhbmQgZnVsbHkgdW5kZXJzdG9vZCBpcyBhbGxvd2VkIHRocm91Z2g7XG4gICAgLy8gc3RkaW4gKGAtLWlucHV0IC1gKSwgYSBgQGZpbGVgIGZpZWxkIHZhbHVlLCBhbiB1bnJlYWRhYmxlIHBhdGgsIGludmFsaWRcbiAgICAvLyBKU09OLCBvciBhbiB1bnJlY29nbmlzZWQgc2hhcGUgYWxsIGNhcnJ5IG5vIHJlYWRhYmxlIGBib2R5RmlsZVBhdGhgIChvclxuICAgIC8vIGZhaWwgdGhlIHNjYW4pIGFuZCBzdGF5IHJlZnVzZWQuIFRoaXMgc2l0cyBXSVRIIHRoZSByZXNlcnZlZC1sYWJlbFxuICAgIC8vIGNoZWNrLCBiZWZvcmUgdGhlIGBjdHguYWN0aXZlYCBlYXJseSByZXR1cm4sIHNvIHRoZSBiYWNrc3RvcCBpcyBhc1xuICAgIC8vIHVuY29uZGl0aW9uYWwgYXMgdGhlIGRlbnlsaXN0IGl0IGd1YXJkcy4gVE9DVE9VOiB0aGUgYWdlbnQgY291bGQgcmV3cml0ZVxuICAgIC8vIHRoZSBmaWxlIGJldHdlZW4gdGhpcyByZWFkIGFuZCBgZ2hgJ3Mg4oCUIG5vdCBjbG9zYWJsZSBmcm9tIGEgUEFUSCBzaGltLFxuICAgIC8vIGFuZCBubyB3b3JzZSB0aGFuICM5MDsgdGhlIGFyZ3YtdmlzaWJsZSBwYXRoIGhhcyBubyBzdWNoIHdpbmRvdy5cbiAgICBpZiAoaW5mby51bnJlYWRhYmxlQm9keSkge1xuICAgICAgaWYgKGluZm8uYm9keUZpbGVQYXRoICE9PSB1bmRlZmluZWQgJiYgY3R4LnJlYWRCb2R5RmlsZSkge1xuICAgICAgICBsZXQgdGV4dDogc3RyaW5nO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHRleHQgPSBjdHgucmVhZEJvZHlGaWxlKGluZm8uYm9keUZpbGVQYXRoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgcmV0dXJuIHVucmVhZGFibGVCb2R5UmVmdXNhbChpbmZvLnZlcmIpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHNjYW4gPSBzY2FuQm9keUZvckZvcmJpZGRlbkxhYmVsKHRleHQpO1xuICAgICAgICBpZiAoc2Nhbi5raW5kID09PSBcImZvcmJpZGRlblwiKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGFsbG93ZWQ6IGZhbHNlLFxuICAgICAgICAgICAgbWFya2VyOiBcIldPUktFUl9MQUJFTF9SRUZVU0VEXCIsXG4gICAgICAgICAgICByZWFzb246IGBsYWJlbD0ke3NjYW4ubGFiZWx9IHZlcmI9JHtpbmZvLnZlcmJ9IGAgK1xuICAgICAgICAgICAgICBgY2FsbGVyPWFnZW50LXN1YnByb2Nlc3MgYCArXG4gICAgICAgICAgICAgIGByZWFzb249cmVzZXJ2ZWRfd29ya2Zsb3dfbGFiZWxfaW5faW5wdXRfYm9keWAsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2Nhbi5raW5kID09PSBcInVucmVhZGFibGVcIikgcmV0dXJuIHVucmVhZGFibGVCb2R5UmVmdXNhbChpbmZvLnZlcmIpO1xuICAgICAgICAvLyBzY2FuLmtpbmQgPT09IFwiY2xlYW5cIjogdGhlIGJvZHkgY2FycmllcyBubyByZXNlcnZlZCBsYWJlbCDigJQgZmFsbFxuICAgICAgICAvLyB0aHJvdWdoIHRvIHRoZSB3cml0ZS1yZXBvIGFsbG93bGlzdCBjaGVja3MgYmVsb3csIHdoaWNoIHN0aWxsIGFwcGx5LlxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIHVucmVhZGFibGVCb2R5UmVmdXNhbChpbmZvLnZlcmIpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIElzc3VlICMxODc6IGEgY29tbWFuZCB0aGF0IHJld3JpdGVzIHRoZSBsb2NhbCBgZ2hgIGluc3RhbGxhdGlvbiDigJRcbiAgLy8gY3JlZGVudGlhbHMsIGNvbmZpZywgYWxpYXNlcywgZXh0ZW5zaW9ucyDigJQgY2hhbmdlcyBub3RoaW5nIG9uIEdpdEh1Yiwgc29cbiAgLy8gYGNsYXNzaWZ5R2hNdXRhdGlvbmAgcmVwb3J0cyBubyByZXBvIHdyaXRlIGFuZCBpdCByZWFjaGVkIGhlcmUgYXMgYVxuICAvLyBcInJlYWRcIiAob3IsIHNpbmNlIElzc3VlICMxMzk2LCBhcyBhIGBub24tcmVwb2AgZXh0ZW5zaW9uIG11dGF0aW9uIHRoZVxuICAvLyB3cml0ZS1yZXBvIGFsbG93bGlzdCBoYXMgbm90aGluZyB0byBjb21wYXJlKS5cbiAgLy8gSXQgaXMgbm90IG9uZTogdGhlIHdyYXBwZXIgcGlucyBgR0hfQ09ORklHX0RJUmAgdG8gdGhlIHdvcmtlcidzIG93blxuICAvLyBwZXJzaXN0ZW50IGlkZW50aXR5IGRpcmVjdG9yeSwgc28gYSBjcmVkZW50aWFsIHdyaXR0ZW4gdGhlcmUgcmUtcG9pbnRzXG4gIC8vIGV2ZXJ5IGxhdGVyIGBnaGAgY2FsbCwgdGhlIHdvcmtlcidzIGluY2x1ZGVkLiBSZWZ1c2VkIHVuY29uZGl0aW9uYWxseSxcbiAgLy8gbGlrZSB0aGUgdW5rbm93bi1yb290IGNoZWNrIGJlbG93IOKAlCBjcmVkZW50aWFscyBhcmUgcHJvdmlzaW9uZWQgb25jZSBieVxuICAvLyBgc2V0dXAuc2hgIGFuZCBjb25zdW1lZCByZWFkLW9ubHksIHNvIG5vIHJ1biBoYXMgYSBsZWdpdGltYXRlIHVzZSBmb3Igb25lLlxuICAvLyBBaGVhZCBvZiB0aGF0IGNoZWNrIHNvIHRoZSBtb3JlIHNwZWNpZmljIHJlZnVzYWwgd2lucyB3aGVuIGJvdGggYXBwbHkuXG4gIGNvbnN0IGxvY2FsU3RhdGUgPSBjbGFzc2lmeUdoTG9jYWxTdGF0ZUNoYW5nZShhcmdzKTtcbiAgaWYgKGxvY2FsU3RhdGUpIHtcbiAgICByZXR1cm4ge1xuICAgICAgYWxsb3dlZDogZmFsc2UsXG4gICAgICBtYXJrZXI6IFwiR0hfTE9DQUxfU1RBVEVfUkVGVVNFRFwiLFxuICAgICAgcmVhc29uOiBgUmVmdXNlZCAnZ2ggJHtsb2NhbFN0YXRlLnJvb3R9ICR7bG9jYWxTdGF0ZS52ZXJifScgZnJvbSB0aGUgYCArXG4gICAgICAgIGBhZ2VudCBzdWJwcm9jZXNzIOKAlCBpdCByZXdyaXRlcyAke2xvY2FsU3RhdGUudGFyZ2V0fSBvZiB0aGlzIHJ1bidzIGAgK1xuICAgICAgICBgZ2ggaW5zdGFsbGF0aW9uLCB3aGljaCBldmVyeSBsYXRlciBnaCBjYWxsICh0aGUgd29ya2VyJ3MgaW5jbHVkZWQpIGAgK1xuICAgICAgICBgdGhlbiB1c2VzLiBDcmVkZW50aWFscyBhcmUgcHJvdmlzaW9uZWQgbm9uLWludGVyYWN0aXZlbHkgYnkgc2V0dXAuc2ggYCArXG4gICAgICAgIGBhbmQgY29uc3VtZWQgcmVhZC1vbmx5OyB0aGUgcmVhZCB2ZXJicyAoJ2doIGF1dGggc3RhdHVzJywgYCArXG4gICAgICAgIGAnZ2ggY29uZmlnIGdldCcsICdnaCBleHRlbnNpb24gbGlzdCcpIGFyZSB1bmFmZmVjdGVkLmAsXG4gICAgfTtcbiAgfVxuXG4gIC8vIElzc3VlICMxMzcxOiB0aGUgZ3VhcmQgY2xhc3NpZmllcyBhcmd2LCBzbyBldmVyeXRoaW5nIGFib3ZlIGhvbGRzIG9ubHlcbiAgLy8gd2hpbGUgdGhlIGd1YXJkZWQgY2hhbm5lbCBpcyB0aGUgYWdlbnQncyBvbmx5IHJvdXRlIHRvIEdpdEh1Yi4gYGdoIGF1dGhcbiAgLy8gdG9rZW5gIGFuZCBgZ2ggYXV0aCBzdGF0dXMgLS1zaG93LXRva2VuYCBwcmludCB0aGUgcnVuJ3MgY3JlZGVudGlhbCwgd2hpY2hcbiAgLy8gaXMgdGhlIG9uZSB2YWx1ZSB0aGF0IG1ha2VzIGV2ZXJ5IGxhdGVyIGNhbGwgdW5ndWFyZGVkIOKAlCB0aGUgZ3VhcmQgd2FzXG4gIC8vIGhhbmRpbmcgb3V0IGl0cyBvd24gYnlwYXNzIG9uIHJlcXVlc3QuIFRoZXkgY2hhbmdlIG5vdGhpbmcsIG9uIEdpdEh1YiBvclxuICAvLyBsb2NhbGx5LCBzbyBuZWl0aGVyIHRoZSBtdXRhdGlvbiBjbGFzc2lmaWVyIG5vciB0aGUgbG9jYWwtc3RhdGUgY2hlY2sgc2F3XG4gIC8vIHRoZW0uIFJlZnVzZWQgdW5jb25kaXRpb25hbGx5OiBub3RoaW5nIGluIGEgcnVuIG5lZWRzIHRvICpzZWUqIHRoZSB0b2tlblxuICAvLyB0byB1c2UgaXQsIGFuZCBwbGFpbiBgZ2ggYXV0aCBzdGF0dXNgIHN0YXlzIGFsbG93ZWQgZm9yIHRoZSBoZWFsdGggY2hlY2tzLlxuICBjb25zdCBkaXNjbG9zdXJlID0gY2xhc3NpZnlHaENyZWRlbnRpYWxEaXNjbG9zdXJlKGFyZ3MpO1xuICBpZiAoZGlzY2xvc3VyZSkge1xuICAgIHJldHVybiB7XG4gICAgICBhbGxvd2VkOiBmYWxzZSxcbiAgICAgIG1hcmtlcjogXCJHSF9DUkVERU5USUFMX0RJU0NMT1NVUkVfUkVGVVNFRFwiLFxuICAgICAgcmVhc29uOiBgUmVmdXNlZCAnZ2ggJHtkaXNjbG9zdXJlLnJvb3R9ICR7ZGlzY2xvc3VyZS52ZXJifScgZnJvbSB0aGUgYCArXG4gICAgICAgIGBhZ2VudCBzdWJwcm9jZXNzIOKAlCBpdCBwcmludHMgJHtkaXNjbG9zdXJlLmRpc2Nsb3NlZH0gaW4gcGxhaW50ZXh0LCBgICtcbiAgICAgICAgYGFuZCBhIGNyZWRlbnRpYWwgdGhlIGFnZW50IGhvbGRzIGRpcmVjdGx5IGlzIG9uZSB0aGlzIGd1YXJkIGNhbiBubyBgICtcbiAgICAgICAgYGxvbmdlciBtZWRpYXRlLiBnaCBhdXRoZW50aWNhdGVzIGl0c2VsZiBmcm9tIHRoZSBwaW5uZWQgYCArXG4gICAgICAgIGBHSF9DT05GSUdfRElSLCBzbyBubyBydW4gbmVlZHMgdG8gcmVhZCB0aGUgdG9rZW47IHBsYWluIGAgK1xuICAgICAgICBgJ2doIGF1dGggc3RhdHVzJyBpcyB1bmFmZmVjdGVkLmAsXG4gICAgfTtcbiAgfVxuXG4gIC8vIElzc3VlICMzODY2OiBhIHJvb3QgdGhlIHJlYWwgYmluYXJ5IGRvZXMgbm90IGltcGxlbWVudCBpcyBleHBhbmRlZCBmcm9tXG4gIC8vIHRoZSBgZ2hgIGNvbmZpZyBhbGlhc2VzIChvciBhbiBleHRlbnNpb24pIGJlZm9yZSBpdCBydW5zLCBzbyB0aGUgd3JpdGUgaXRcbiAgLy8gcGVyZm9ybXMgYXBwZWFycyBub3doZXJlIGluIHRoaXMgYXJndi4gRmFpbCBjbG9zZWQg4oCUIGluY2x1ZGluZyB3aGVuIHRoZVxuICAvLyBhbGxvd2xpc3QgaXMgaW5lcnQsIGJlY2F1c2UgdGhlIHJlc2VydmVkLWxhYmVsIGNoZWNrIGFib3ZlIGlzIHVuY29uZGl0aW9uYWxcbiAgLy8gYW5kIGFuIGFsaWFzIGhpZGVzIGl0cyBsYWJlbHMganVzdCBhcyBlZmZlY3RpdmVseSBhcyBpdHMgcmVwby5cbiAgY29uc3Qgcm9vdCA9IGdoUm9vdENvbW1hbmQoYXJncyk7XG4gIGlmIChyb290ICE9PSB1bmRlZmluZWQgJiYgIUdIX0tOT1dOX1JPT1RfQ09NTUFORFMuaGFzKHJvb3QpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFsbG93ZWQ6IGZhbHNlLFxuICAgICAgbWFya2VyOiBcIkdIX1VOS05PV05fQ09NTUFORFwiLFxuICAgICAgcmVhc29uOiBgUmVmdXNlZCAnZ2ggJHtyb290fScgZnJvbSB0aGUgYWdlbnQgc3VicHJvY2VzcyDigJQgbm90IGEga25vd24gYCArXG4gICAgICAgIGBnaCBjb21tYW5kLCBzbyBpdCBpcyBhbiBhbGlhcyBvciBhbiBleHRlbnNpb24gd2hvc2UgcmVhbCBjb21tYW5kIGAgK1xuICAgICAgICBgdGhpcyBndWFyZCBjYW5ub3Qgc2VlLiBSdW4gdGhlIHVuZGVybHlpbmcgZ2ggY29tbWFuZCBkaXJlY3RseS5gLFxuICAgIH07XG4gIH1cblxuICAvLyBSZWFkcyBjaGFuZ2Ugbm90aGluZyBvbiBHaXRIdWIgYW5kIGFyZSBuZXZlciB0aGUgZXhmaWx0cmF0aW9uIHNpbmsg4oCUIHRoZVxuICAvLyB3b3JrZXIncyBvd24gY2hva2Vwb2ludCB0YWtlcyB0aGUgc2FtZSB2aWV3LlxuICBpZiAoIWluZm8pIHJldHVybiB7IGFsbG93ZWQ6IHRydWUgfTtcblxuICBpZiAoIWN0eC5hY3RpdmUpIHJldHVybiB7IGFsbG93ZWQ6IHRydWUgfTtcblxuICAvLyBJc3N1ZSAjMzcwMzogZmFpbCBjbG9zZWQgb24gYW4gdW5kZXRlcm1pbmFibGUgdGFyZ2V0IOKAlCBhIEdyYXBoUUxcbiAgLy8gbXV0YXRpb24sIGEgYGdoIGdpc3QgY3JlYXRlYCwgYW4gZW5kcG9pbnQgdGhhdCBuYW1lcyBubyByZXBvLiBNaXJyb3JzXG4gIC8vIGBlbmZvcmNlR2hXcml0ZUFsbG93bGlzdGAuXG4gIGlmIChpbmZvLnNjb3BlID09PSBcInVua25vd25cIikge1xuICAgIHJldHVybiB7XG4gICAgICBhbGxvd2VkOiBmYWxzZSxcbiAgICAgIG1hcmtlcjogXCJXUklURV9UQVJHRVRfVU5ERVRFUk1JTkFCTEVcIixcbiAgICAgIHJlYXNvbjogYFJlZnVzZWQgJHtpbmZvLnZlcmJ9IGZyb20gdGhlIGFnZW50IHN1YnByb2Nlc3Mg4oCUIHRhcmdldCByZXBvIGAgK1xuICAgICAgICBgbm90IGRlcml2YWJsZSR7aW5mby50YXJnZXQgPyBgICgke2luZm8udGFyZ2V0fSlgIDogXCJcIn0sIGAgK1xuICAgICAgICBgZmFpbGluZyBjbG9zZWRgLFxuICAgIH07XG4gIH1cblxuICBpZiAoIWluZm8ucmVwbykgcmV0dXJuIHsgYWxsb3dlZDogdHJ1ZSB9O1xuXG4gIGNvbnN0IGFsbG93ZWQgPSBuZXcgU2V0KFxuICAgIGN0eC5hbGxvd2VkUmVwb3MubWFwKChyKSA9PiByLnRyaW0oKS50b0xvd2VyQ2FzZSgpKS5maWx0ZXIoKHIpID0+XG4gICAgICByLmxlbmd0aCA+IDBcbiAgICApLFxuICApO1xuICBpZiAoYWxsb3dlZC5oYXMoaW5mby5yZXBvLnRyaW0oKS50b0xvd2VyQ2FzZSgpKSkgcmV0dXJuIHsgYWxsb3dlZDogdHJ1ZSB9O1xuXG4gIHJldHVybiB7XG4gICAgYWxsb3dlZDogZmFsc2UsXG4gICAgbWFya2VyOiBcIldSSVRFX1JFUE9fQkxPQ0tFRFwiLFxuICAgIHJlYXNvbjogYFJlZnVzZWQgJHtpbmZvLnZlcmJ9IHRvICR7aW5mby5yZXBvfSBmcm9tIHRoZSBhZ2VudCBzdWJwcm9jZXNzIGAgK1xuICAgICAgYOKAlCBub3Qgb24gcnVuIGFsbG93bGlzdCBbJHtbLi4uYWxsb3dlZF0uc29ydCgpLmpvaW4oXCIsIFwiKX1dYCxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FrREMsR0FFRCxTQUNFLGtCQUFrQixRQUViLGlDQUFpQztBQUN4QyxTQUFTLGVBQWUsUUFBUSxzQkFBc0I7QUFDdEQsU0FBUywrQkFBK0IsUUFBUSwwQkFBMEI7QUFDMUUsU0FBUyxlQUFlLFFBQVEsdUJBQXVCO0FBQ3ZELFNBQ0Usc0JBQXNCLEVBQ3RCLHFCQUFxQixRQUNoQiwwQkFBMEI7QUFDakMsU0FBUyxtQkFBbUIsRUFBRSxrQkFBa0IsUUFBUSx1QkFBdUI7QUFDL0UsU0FBUyxrQkFBa0IsUUFBUSx5QkFBeUI7QUFDNUQsU0FBUyxvQkFBb0IsUUFBUSw0QkFBNEI7QUFDakUsU0FBUyw4QkFBOEIsUUFBUSxzQ0FBc0M7QUFDckYsU0FBUywwQkFBMEIsUUFBUSw0QkFBNEI7QUFtRHZFOzs7Ozs7Ozs7Ozs7O0NBYUMsR0FD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
// denoCacheMetadata=15535515240230801544,1662128641571002975