/**
 * Provider-outage alert (Issue #2613).
 *
 * When the agent provider refuses every request — a spent balance (HTTP 402)
 * or a refused credential — each task it touches fails the same way. Without
 * one place that says so, the outage surfaces as dozens of misleading task
 * failures. This module keeps exactly **one** open issue per provider in the
 * VibeCoder repo while the outage lasts: filed on the first refusal, updated
 * in place on each later one (first-seen preserved), and closed with a
 * recovery comment on the first request that succeeds.
 *
 * Dedup follows the idle-starvation alert: search by a body marker, trust only
 * matches a fleet account authored, and never file when the search failed.
 * Every public entry point returns a decision and never throws — an alert is
 * a side channel and must not break the run that observed the outage.
 */
import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import { type AgentFailure, BALANCE_EXHAUSTED_RE } from "./agent_output.ts";
import { GATE_WEDGE_DIAGNOSTIC_REPO } from "./milestone_gate_wedge.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** Where the alert lives: the fleet's own repo, never a monitored one. */
export const PROVIDER_OUTAGE_TARGET_REPO = GATE_WEDGE_DIAGNOSTIC_REPO;

const MARKER_NAME = "vibe-provider-outage";
const MARKER_RE =
  /<!-- vibe-provider-outage provider="([^"]+)" first-seen="([^"]+)" -->/;
/** Provider ids are short slugs; anything else never reaches a gh argv. */
const PROVIDER_ID_RE = /^[a-z0-9._-]{1,40}$/i;
const MAX_ERROR_CHARS = 500;

type GhFn = (args: string[]) => Promise<string>;
type Log = (message: string) => void;

/**
 * Whether a run's failure means the provider is refusing this account
 * outright: a refused credential, or a spent balance (402).
 */
export function isProviderOutageAlertable(
  failure: AgentFailure | undefined,
): boolean {
  // SIMPLE-ON-PURPOSE: 429/5xx and routine windows self-clear, so never alert — upgrade when a sustained 429/5xx outage goes unnoticed for a day
  if (!failure) return false;
  if (failure.category === "authentication") return true;
  // The wording, not a parsed status: a stray "402" is not a spent balance.
  return failure.category === "quota-exhausted" &&
    BALANCE_EXHAUSTED_RE.test(failure.message);
}

/** Render the alert body. The error is redacted, truncated and fenced. */
export function formatProviderOutageBody(input: {
  provider: string;
  error: string;
  firstSeenMs: number;
  lastSeenMs: number;
}): string {
  const firstSeen = new Date(input.firstSeenMs).toISOString();
  const lastSeen = new Date(input.lastSeenMs).toISOString();
  // The alert is a public issue body: redact before it leaves the process.
  const redacted = redactSecrets(input.error);
  const clipped = redacted.length > MAX_ERROR_CHARS
    ? `${redacted.slice(0, MAX_ERROR_CHARS)}…`
    : redacted;
  // Break every backtick run so the provider's text cannot close the fence.
  const safeError = clipped.replace(/`/g, "ˋ");
  return [
    `<!-- ${MARKER_NAME} provider="${input.provider}" first-seen="${firstSeen}" -->`,
    `## Agent provider \`${input.provider}\` is refusing requests`,
    "",
    `- **First seen:** ${firstSeen}`,
    `- **Last seen:** ${lastSeen}`,
    "",
    "Latest error:",
    "",
    "```text",
    safeError,
    "```",
    "",
    "While this is open, runs that hit the refusal are parked rather than " +
    "failed: no failure streak, repo back-off or merge-conflict attempt is " +
    "charged, no merge-fallback issue is filed and no milestone roll-back is " +
    "attempted. Work retries once the provider answers.",
    "",
    "**What to do:** restore the account (top up the balance or fix the " +
    "credential). This issue closes itself on the first request that " +
    "succeeds.",
  ].join("\n");
}

interface CommonOptions {
  provider: string;
  nowMs: number;
  ghFn: GhFn;
  log?: Log;
  /** Fleet logins trusted to have written the marker; omitted reads config. */
  fleetAuthors?: readonly string[];
}

/** Open, fleet-authored alerts for `provider`, lowest number first. Throws on a failed search. */
async function findOpenAlerts(
  opts: CommonOptions,
  log: Log,
  unverifiedOutcome: string,
): Promise<AlertDedupRow[]> {
  const raw = await opts.ghFn([
    "issue",
    "list",
    "--repo",
    PROVIDER_OUTAGE_TARGET_REPO,
    "--state",
    "open",
    "--search",
    `"${MARKER_NAME}" in:body`,
    "--json",
    ALERT_DEDUP_JSON_FIELDS,
    "--limit",
    "20",
  ]);
  const rows = JSON.parse(raw) as AlertDedupRow[];
  const mine = rows.filter((row) =>
    MARKER_RE.exec(row.body ?? "")?.[1] === opts.provider
  );
  const verified = await selectFleetAuthoredMatches(
    mine,
    `provider-outage ${opts.provider}`,
    { fleetAuthors: opts.fleetAuthors },
    log,
    unverifiedOutcome,
  );
  return verified.sort((a, b) => a.number - b.number);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Outcome of {@link raiseProviderOutageAlert}. */
export type RaiseDecision =
  | { action: "filed"; issue: number }
  | { action: "updated"; issue: number }
  | { action: "gh-failed"; reason: string }
  | { action: "invalid"; reason: string };

/** File the provider's alert, or update the open one in place. Never throws. */
export async function raiseProviderOutageAlert(
  opts: CommonOptions & { error: string },
): Promise<RaiseDecision> {
  const log = opts.log ?? console.error;
  if (!PROVIDER_ID_RE.test(opts.provider)) {
    return { action: "invalid", reason: "provider id is not a plain slug" };
  }
  try {
    const [existing] = await findOpenAlerts(
      opts,
      log,
      "none is treated as the open alert and a new one is filed",
    );
    const parsedFirstSeen = existing
      ? Date.parse(MARKER_RE.exec(existing.body ?? "")?.[2] ?? "")
      : NaN;
    const body = formatProviderOutageBody({
      provider: opts.provider,
      error: opts.error,
      firstSeenMs: Number.isFinite(parsedFirstSeen)
        ? parsedFirstSeen
        : opts.nowMs,
      lastSeenMs: opts.nowMs,
    });
    if (existing) {
      await opts.ghFn([
        "issue",
        "edit",
        String(existing.number),
        "--repo",
        PROVIDER_OUTAGE_TARGET_REPO,
        "--body",
        body,
      ]);
      return { action: "updated", issue: existing.number };
    }
    const url = await opts.ghFn([
      "issue",
      "create",
      "--repo",
      PROVIDER_OUTAGE_TARGET_REPO,
      "--title",
      `Agent provider ${opts.provider} is refusing requests`,
      "--body",
      body,
    ]);
    const issue = Number(/\/issues\/(\d+)\s*$/.exec(url)?.[1]);
    if (!Number.isInteger(issue)) {
      throw new Error(`gh issue create returned no issue URL: ${url.trim()}`);
    }
    log(`[provider-outage] ${opts.provider}: filed alert #${issue}`);
    return { action: "filed", issue };
  } catch (err) {
    const reason = errorText(err);
    log(
      `[provider-outage] ${opts.provider}: could not raise alert — ${reason}`,
    );
    return { action: "gh-failed", reason };
  }
}

/** Outcome of {@link resolveProviderOutageAlert}. */
export type ResolveDecision =
  | { action: "none" }
  | { action: "closed"; issues: number[] }
  | { action: "gh-failed"; reason: string };

/** Close every open alert for `provider` with a recovery comment. Never throws. */
export async function resolveProviderOutageAlert(
  opts: CommonOptions,
): Promise<ResolveDecision> {
  const log = opts.log ?? console.error;
  if (!PROVIDER_ID_RE.test(opts.provider)) return { action: "none" };
  try {
    const open = await findOpenAlerts(
      opts,
      log,
      "none is closed — a human closes it once the provider is back",
    );
    if (open.length === 0) return { action: "none" };
    const recovered = new Date(opts.nowMs).toISOString();
    for (const alert of open) {
      await opts.ghFn([
        "issue",
        "close",
        String(alert.number),
        "--repo",
        PROVIDER_OUTAGE_TARGET_REPO,
        "--comment",
        `Recovered: a request to \`${opts.provider}\` succeeded at ${recovered}.`,
      ]);
    }
    const issues = open.map((a) => a.number);
    log(
      `[provider-outage] ${opts.provider}: closed alert(s) #${
        issues.join(", #")
      }`,
    );
    return { action: "closed", issues };
  } catch (err) {
    const reason = errorText(err);
    log(
      `[provider-outage] ${opts.provider}: could not close alert — ${reason}`,
    );
    return { action: "gh-failed", reason };
  }
}

/** What a finished agent run tells the alerter about its provider. */
export type ProviderRunOutcome =
  | { succeeded: true }
  | { succeeded: false; failure?: AgentFailure };

/** Process-wide tracker that turns run outcomes into alert calls. */
export interface ProviderOutageAlerter {
  observe(provider: string, outcome: ProviderRunOutcome): Promise<void>;
}

/**
 * Build an alerter. It remembers, per provider, whether this process last
 * saw an alert open or clear, so a healthy provider costs one search per
 * process and none after. Calls are serialised, so concurrent failures
 * cannot race into two alerts.
 */
export function createProviderOutageAlerter(deps: {
  ghFn: GhFn;
  log?: Log;
  fleetAuthors?: readonly string[];
  now?: () => number;
}): ProviderOutageAlerter {
  const state = new Map<string, "open" | "clear">();
  const now = deps.now ?? Date.now;
  let chain: Promise<void> = Promise.resolve();
  const step = async (provider: string, outcome: ProviderRunOutcome) => {
    const common = {
      provider,
      nowMs: now(),
      ghFn: deps.ghFn,
      log: deps.log,
      fleetAuthors: deps.fleetAuthors,
    };
    if (!outcome.succeeded) {
      if (!isProviderOutageAlertable(outcome.failure)) return;
      const d = await raiseProviderOutageAlert({
        ...common,
        error: outcome.failure!.message,
      });
      if (d.action === "filed" || d.action === "updated") {
        state.set(provider, "open");
      }
      return;
    }
    if (state.get(provider) === "clear") return;
    const d = await resolveProviderOutageAlert(common);
    if (d.action !== "gh-failed") state.set(provider, "clear");
  };
  return {
    observe(provider, outcome) {
      const next = chain.then(() => step(provider, outcome));
      // Both entry points never throw; the catch only keeps the chain alive.
      chain = next.catch((err) =>
        (deps.log ?? console.error)(
          `[provider-outage] ${provider}: alerter step failed — ${
            errorText(err)
          }`,
        )
      );
      return chain;
    },
  };
}

let installed: ProviderOutageAlerter | undefined;

/** Install (or with `undefined`, remove) the process-wide alerter. */
export function installProviderOutageAlerter(
  alerter: ProviderOutageAlerter | undefined,
): void {
  installed = alerter;
}

/** Report a run outcome to the installed alerter; a no-op when none is. */
export function noteProviderRunOutcome(
  provider: string,
  outcome: ProviderRunOutcome,
): Promise<void> {
  return installed ? installed.observe(provider, outcome) : Promise.resolve();
}
