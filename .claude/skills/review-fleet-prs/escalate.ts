/**
 * Escalation for a failing review-fleet-prs runner (Issue #2892, part B).
 *
 * `run.sh` runs a pass every 5 minutes; a pass that fails (token mint fails,
 * gate fails) used to only get logged, so a broken runner could sit silent
 * for days. After ESCALATE_AFTER consecutive failed passes this files one
 * deduplicated GitHub issue and appends a host health line, and closes the
 * issue on the first successful pass after that.
 */

import { neutraliseAgentMarkers } from "../../../worker/deno/lib/agent_marker_neutralisation.ts";
import { redactSecrets } from "../../../worker/deno/lib/secret_redaction.ts";

export const ESCALATE_AFTER = 12;
export const ESCALATION_REPO = "stSoftwareAU/VibeCoder";

export type RunGh = (args: string[]) => Promise<string>;

/** What a redacted repo reference becomes in the public escalation issue. */
export const REPO_PLACEHOLDER = "<repo>";

const ESCALATION_OWNER = ESCALATION_REPO.split("/")[0] ?? "";

// GitHub's own limits: an owner is at most 39 characters, a repo name at
// most 100. Every quantifier is bounded so the scan stays linear over
// untrusted error text.
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const NAME = "[A-Za-z0-9._-]{1,100}";

// A github.com URL to a repo. Everything after the slug is part of the
// match, since a path can name private files or runs.
const REPO_URL = new RegExp(
  `https?://(?:www\\.|api\\.)?github\\.com/(?:repos/)?(${OWNER})/(${NAME})` +
    `[^\\s)\\]>"'\`]{0,500}`,
  "g",
);

// A slug where only a repo can appear (a `repos/` API path, a `-R` or
// `--repo` argument) or with a `#123` reference; or any other slug, kept
// unless its owner is the escalation repo's owner.
const REPO_SLUG = new RegExp(
  `(\\brepos/|(?:^|\\s)(?:-R|--repo)[= ]|)(${OWNER})/(${NAME})(#\\d{1,10})?`,
  "g",
);

// A bare `name#123` reference with no owner, e.g. a `<repo>#<n>` upkeep line.
const BARE_REF = new RegExp(`(^|[\\s(\\[])(${NAME})#(\\d{1,10})\\b`, "g");

const ESCALATION_NAME = ESCALATION_REPO.split("/")[1] ?? "";

function sameText(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// A repo name never ends in a dot, but a sentence can: "... in owner/name."
function splitTrailingDots(name: string): [string, string] {
  const bare = name.replace(/\.+$/, "");
  return [bare, name.slice(bare.length)];
}

function isEscalationRepo(owner: string, name: string): boolean {
  return sameText(owner, ESCALATION_OWNER) && sameText(name, ESCALATION_NAME);
}

/**
 * Replaces every repo reference other than the public escalation repo with
 * REPO_PLACEHOLDER. The escalation issue is public and many fleet repos are
 * not, so a `gh` error naming one of them must not carry the name into it.
 * Over-redacting a public repo costs nothing; leaking a private one cannot be
 * undone.
 */
export function redactRepoRefs(text: string): string {
  return text
    .replace(REPO_URL, (match, owner: string, name: string) => {
      const [bare] = splitTrailingDots(name);
      return isEscalationRepo(owner, bare) ? match : REPO_PLACEHOLDER;
    })
    .replace(
      REPO_SLUG,
      (match, prefix: string, owner: string, name: string, ref?: string) => {
        const [bare, dots] = splitTrailingDots(name);
        if (isEscalationRepo(owner, bare)) return match;
        const certain = prefix !== "" || ref !== undefined;
        if (!certain && !sameText(owner, ESCALATION_OWNER)) return match;
        return `${prefix}${REPO_PLACEHOLDER}${ref ?? dots}`;
      },
    )
    .replace(BARE_REF, (match, lead: string, name: string, n: string) => {
      if (sameText(name, ESCALATION_NAME)) return match;
      return `${lead}${REPO_PLACEHOLDER}#${n}`;
    });
}

/** Shows a path under the home directory as `~/...`, hiding the account. */
export function homeRelative(path: string, home: string | undefined): string {
  if (!home) return path;
  const trimmed = home.replace(/\/+$/, "");
  if (trimmed === "") return path;
  if (path === trimmed) return "~";
  if (path.startsWith(`${trimmed}/`)) return `~${path.slice(trimmed.length)}`;
  return path;
}

export interface PassResult {
  ok: boolean;
  error?: string;
}

export interface EscalateDeps {
  stateDir: string;
  host: string;
  runGh: RunGh;
  now?: () => Date;
  /** Home directory hidden from the public log path; defaults to `$HOME`. */
  home?: string;
}

interface FailureState {
  consecutive: number;
  error?: string;
  issue?: number;
}

const ZERO_STATE: FailureState = { consecutive: 0 };

function stateFile(stateDir: string): string {
  return `${stateDir}/failures.json`;
}

function healthFile(stateDir: string): string {
  return `${stateDir}/health.log`;
}

function logFile(stateDir: string): string {
  return `${stateDir}/runner.log`;
}

async function readState(stateDir: string): Promise<FailureState> {
  let text: string;
  try {
    text = await Deno.readTextFile(stateFile(stateDir));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return { ...ZERO_STATE };
    throw e;
  }
  try {
    return JSON.parse(text) as FailureState;
  } catch (e) {
    throw new Error(
      `escalate: corrupt state file ${stateFile(stateDir)}: ${
        (e as Error).message
      }`,
    );
  }
}

async function writeState(
  stateDir: string,
  state: FailureState,
): Promise<void> {
  await Deno.writeTextFile(
    stateFile(stateDir),
    JSON.stringify(state, null, 2) + "\n",
  );
}

// Single-lined and truncated so the title stays a GitHub-friendly length.
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function issueTitlePrefix(host: string): string {
  return `review-fleet-prs runner failing on ${host}:`;
}

function issueTitle(host: string, error: string): string {
  const prefix = issueTitlePrefix(host);
  const full = `${prefix} ${singleLine(error)}`;
  if (full.length <= 100) return full;
  return full.slice(0, 97) + "...";
}

function issueBody(
  deps: EscalateDeps,
  consecutive: number,
  error: string,
): string {
  const prefix = issueTitlePrefix(deps.host);
  return [
    `The review-fleet-prs runner on \`${deps.host}\` has failed ` +
    `${consecutive} consecutive passes.`,
    "",
    `Latest error: ${singleLine(error)}`,
    "",
    `Log: ${homeRelative(logFile(deps.stateDir), homeDir(deps))}`,
    "",
    "What to check:",
    "- The GitHub App's permissions (token mint failures usually mean the " +
    "App's installation was revoked or its permissions changed).",
    "- That `deno`, `gh` and `claude` are all on `PATH` for the account " +
    "running the runner.",
    "",
    `This issue was filed automatically because the title starts with ` +
    `\`${prefix}\`. The runner closes it itself once a pass succeeds — no ` +
    "need to close it by hand.",
  ].join("\n");
}

function homeDir(deps: EscalateDeps): string | undefined {
  if (deps.home !== undefined) return deps.home;
  try {
    return Deno.env.get("HOME");
  } catch {
    return undefined;
  }
}

async function findExistingIssue(
  deps: EscalateDeps,
): Promise<number | undefined> {
  const prefix = issueTitlePrefix(deps.host);
  const out = await deps.runGh([
    "issue",
    "list",
    "-R",
    ESCALATION_REPO,
    "--state",
    "open",
    "--search",
    `${prefix} in:title`,
    "--json",
    "number,title",
    "--limit",
    "20",
  ]);
  const parsed = JSON.parse(out) as { number: number; title: string }[];
  const match = parsed.find((i) => i.title.startsWith(prefix));
  return match?.number;
}

async function createIssue(
  deps: EscalateDeps,
  consecutive: number,
  error: string,
): Promise<number> {
  const title = issueTitle(deps.host, error);
  const body = issueBody(deps, consecutive, error);
  const out = await deps.runGh([
    "issue",
    "create",
    "-R",
    ESCALATION_REPO,
    "--title",
    title,
    "--body",
    body,
  ]);
  const match = out.trim().match(/(\d+)\s*$/);
  if (!match) {
    throw new Error(`escalate: could not parse issue number from: ${out}`);
  }
  return Number(match[1]);
}

async function appendHealthLine(
  deps: EscalateDeps,
  line: string,
): Promise<void> {
  await Deno.mkdir(deps.stateDir, { recursive: true });
  await Deno.writeTextFile(healthFile(deps.stateDir), line + "\n", {
    append: true,
    create: true,
  });
}

function nowIso(deps: EscalateDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function healthLine(
  deps: EscalateDeps,
  opts: {
    status: "unhealthy" | "recovered";
    consecutive: number;
    issue: number;
    error?: string;
  },
): string {
  const parts = [
    nowIso(deps),
    "[review-fleet-prs-health]",
    `host=${deps.host}`,
    `status=${opts.status}`,
  ];
  if (opts.status === "unhealthy") {
    parts.push(`consecutive=${opts.consecutive}`);
  }
  parts.push(`issue=#${opts.issue}`);
  if (opts.error !== undefined) {
    parts.push(`error=${singleLine(opts.error)}`);
  }
  return parts.join(" ");
}

export interface RecordPassResult {
  action: "none" | "opened" | "updated" | "closed";
  consecutive: number;
  healthLine?: string;
}

export async function recordPass(
  result: PassResult,
  deps: EscalateDeps,
): Promise<RecordPassResult> {
  await Deno.mkdir(deps.stateDir, { recursive: true });
  const state = await readState(deps.stateDir);

  if (!result.ok) {
    // The error lands in a public issue: redact secrets and private repo
    // references, and defuse agent markers, once, here.
    const error = neutraliseAgentMarkers(
      redactRepoRefs(redactSecrets(result.error || "unknown error")),
    ).text;
    const consecutive = state.consecutive + 1;
    const nextState: FailureState = { ...state, consecutive, error };
    await writeState(deps.stateDir, nextState);

    if (consecutive < ESCALATE_AFTER) {
      return { action: "none", consecutive };
    }

    if (nextState.issue === undefined) {
      const existing = await findExistingIssue(deps);
      let issue: number;
      let action: "opened" | "updated";
      if (existing !== undefined) {
        issue = existing;
        action = "updated";
      } else {
        issue = await createIssue(deps, consecutive, error);
        action = "opened";
      }
      nextState.issue = issue;
      await writeState(deps.stateDir, nextState);
      const line = healthLine(deps, {
        status: "unhealthy",
        consecutive,
        issue,
        error,
      });
      await appendHealthLine(deps, line);
      return { action, consecutive, healthLine: line };
    }

    if (state.error !== error) {
      await deps.runGh([
        "issue",
        "edit",
        String(nextState.issue),
        "-R",
        ESCALATION_REPO,
        "--title",
        issueTitle(deps.host, error),
      ]);
      await deps.runGh([
        "issue",
        "comment",
        String(nextState.issue),
        "-R",
        ESCALATION_REPO,
        "--body",
        `Still failing on ${deps.host} at ${nowIso(deps)}: ${
          singleLine(error)
        }`,
      ]);
      const line = healthLine(deps, {
        status: "unhealthy",
        consecutive,
        issue: nextState.issue,
        error,
      });
      await appendHealthLine(deps, line);
      return { action: "updated", consecutive, healthLine: line };
    }

    return { action: "none", consecutive };
  }

  // A successful pass.
  if (state.issue !== undefined) {
    await deps.runGh([
      "issue",
      "comment",
      String(state.issue),
      "-R",
      ESCALATION_REPO,
      "--body",
      `Recovered on ${deps.host} at ${nowIso(deps)}: the runner's next ` +
      "pass succeeded.",
    ]);
    await deps.runGh([
      "issue",
      "close",
      String(state.issue),
      "-R",
      ESCALATION_REPO,
    ]);
    const line = healthLine(deps, {
      status: "recovered",
      consecutive: 0,
      issue: state.issue,
    });
    await appendHealthLine(deps, line);
    await writeState(deps.stateDir, { ...ZERO_STATE });
    return { action: "closed", consecutive: 0, healthLine: line };
  }

  await writeState(deps.stateDir, { ...ZERO_STATE });
  return { action: "none", consecutive: 0 };
}

function usage(): string {
  return "usage: escalate.ts --state-dir=<dir> --host=<host> " +
    "--result=ok|fail [--error=<text>]";
}

function parseArgs(
  argv: string[],
): { stateDir: string; host: string; result: PassResult } | undefined {
  let stateDir: string | undefined;
  let host: string | undefined;
  let result: "ok" | "fail" | undefined;
  let error: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith("--state-dir=")) stateDir = arg.slice(12);
    else if (arg.startsWith("--host=")) host = arg.slice(7);
    else if (arg.startsWith("--result=")) {
      const v = arg.slice(9);
      if (v !== "ok" && v !== "fail") return undefined;
      result = v;
    } else if (arg.startsWith("--error=")) error = arg.slice(8);
    else return undefined;
  }
  if (!stateDir || !host || !result) return undefined;
  if (result === "fail" && !error) error = "unknown error";
  return { stateDir, host, result: { ok: result === "ok", error } };
}

async function realRunGh(args: string[]): Promise<string> {
  const command = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
}

if (import.meta.main) {
  const parsed = parseArgs(Deno.args);
  if (!parsed) {
    console.error(usage());
    Deno.exit(2);
  }
  try {
    const deps: EscalateDeps = {
      stateDir: parsed.stateDir,
      host: parsed.host,
      runGh: realRunGh,
    };
    const { healthLine: line } = await recordPass(parsed.result, deps);
    if (line) console.log(line);
  } catch (e) {
    console.error(`escalate: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
