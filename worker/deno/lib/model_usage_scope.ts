/**
 * Scope a CLI result's per-model usage to the invocation that produced it
 * (follow-up to Issue #3603).
 *
 * The Claude CLI's result `modelUsage` is a running total for the whole
 * session, not for one invocation: its SDK schema says "a resumed or forked
 * session continues from the totals its transcript saved … so the first
 * result already carries the earlier turns". The result's `usage` is this
 * invocation's main loop only. Issue runs resume their stream's session
 * (Issue #2333), so once #3603 began trusting `modelUsage`, every resumed
 * invocation re-billed the stream's whole history — earlier issues, retired
 * models and all — and a run of six invocations billed it six times.
 *
 * The fix is a baseline per session: after every invocation the session's
 * cumulative `modelUsage` is saved on the durable work volume, and a resumed
 * invocation reports the difference between its result and that baseline.
 * When there is no baseline to subtract (a session opened before this existed,
 * a forked session, no work volume) or the totals went backwards (a `/clear`
 * resets them), the breakdown is withheld: the caller then costs `usage` on
 * the main model and the stats comment flags `sub-agents: not costed`, rather
 * than reporting the history as this run's spend.
 *
 * Best-effort, like the resume store it sits beside: a filesystem failure
 * degrades to "breakdown withheld", never a failed invocation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { readModelUsageBreakdown } from "./cost_estimate.ts";
import {
  buildSessionResumeFlags,
  isValidSessionId,
  type SessionResumeState,
} from "./session_resume.ts";

/**
 * Baselines older than this are swept. A stream resumed after a longer gap
 * just has its sub-agents flagged not costed for one invocation.
 */
export const MODEL_USAGE_BASELINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Directory holding one baseline file per CLI session. */
export function modelUsageBaselineDir(workDir: string): string {
  return `${workDir}/.claude-sessions/model-usage`;
}

/**
 * This invocation's own per-model usage: `current` less `baseline`.
 *
 * Models whose counters did not move are dropped, so a model only the
 * session's history used never reaches this run's cost. Returns `undefined`
 * when either side is unreadable, or when any counter (or model) of the
 * baseline is missing from `current` — the totals were reset, so the
 * difference is not this invocation's spend.
 */
export function subtractModelUsage(
  current: Record<string, unknown>,
  baseline: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const now = readModelUsageBreakdown(current);
  const before = Object.keys(baseline).length === 0
    ? []
    : readModelUsageBreakdown(baseline);
  if (!now || !before) return undefined;
  const earlier = new Map(before.map((e) => [e.model, e.usage]));
  const own: Record<string, unknown> = {};
  for (const { model, usage } of now) {
    const base = earlier.get(model);
    earlier.delete(model);
    const delta = {
      inputTokens: usage.inputTokens - (base?.inputTokens ?? 0),
      outputTokens: usage.outputTokens - (base?.outputTokens ?? 0),
      cacheCreationInputTokens: usage.cacheCreationTokens -
        (base?.cacheCreationTokens ?? 0),
      cacheReadInputTokens: usage.cacheReadTokens -
        (base?.cacheReadTokens ?? 0),
    };
    const counters = Object.values(delta);
    if (counters.some((n) => n < 0)) return undefined;
    if (counters.some((n) => n > 0)) own[model] = delta;
  }
  if (earlier.size > 0) return undefined;
  return own;
}

/** Read a session's saved baseline, or `undefined` when there is none. */
async function loadBaseline(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    const usage = parsed?.modelUsage;
    return usage && typeof usage === "object" && !Array.isArray(usage)
      ? usage as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** Save a session's cumulative totals and sweep stale baselines. */
async function saveBaseline(
  dir: string,
  path: string,
  modelUsage: Record<string, unknown>,
  nowEpochMs: number,
): Promise<void> {
  try {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify({ modelUsage }) + "\n");
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const file = `${dir}/${entry.name}`;
      const mtime = (await Deno.stat(file)).mtime?.getTime();
      if (
        mtime !== undefined &&
        nowEpochMs - mtime > MODEL_USAGE_BASELINE_MAX_AGE_MS
      ) {
        await Deno.remove(file).catch(() => {});
      }
    }
  } catch {
    // Best-effort: the next resumed invocation withholds its breakdown.
  }
}

/**
 * The `modelUsage` to record for one invocation.
 *
 * A fresh session (or none) reports its result as it stands — that is the
 * whole session, so it is the invocation's own, sub-agents included
 * (Issue #3603). A resumed session reports the difference from its saved
 * baseline, or nothing when no baseline applies. Either way the result's
 * cumulative totals become the session's new baseline.
 *
 * @param args.modelUsage - The result line's `modelUsage`, as parsed
 * @param args.session - The session state the invocation was started with
 * @param args.workDir - The durable work volume, when there is one
 * @returns The invocation's own breakdown, or `undefined` to withhold it
 */
export async function scopeModelUsageToInvocation(args: {
  modelUsage: Record<string, unknown> | undefined;
  session: SessionResumeState | undefined;
  workDir: string | undefined;
  nowEpochMs?: number;
}): Promise<Record<string, unknown> | undefined> {
  const { modelUsage, session, workDir } = args;
  if (!modelUsage) return undefined;
  const resumed = buildSessionResumeFlags(session).resume;
  if (!session || !workDir || !isValidSessionId(session.sessionId)) {
    return resumed ? undefined : modelUsage;
  }
  const dir = modelUsageBaselineDir(workDir);
  const path = `${dir}/${session.sessionId}.json`;
  const baseline = resumed ? await loadBaseline(path) : undefined;
  await saveBaseline(dir, path, modelUsage, args.nowEpochMs ?? Date.now());
  if (!resumed) return modelUsage;
  return baseline ? subtractModelUsage(modelUsage, baseline) : undefined;
}
