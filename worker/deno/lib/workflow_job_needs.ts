/**
 * Recognise GitHub Actions **aggregator jobs** from `needs:` in a repo's
 * workflow YAML (Issue #1878, part of #1861).
 *
 * An aggregator is a job that exists only to gate on other jobs — the
 * NEAT-AI-Backpropagation `ci-required` job (`name: CI Required Checks`,
 * `needs: [validation, quality, …]`, `if: always()`) is the canonical
 * shape. When one of the jobs it needs goes red, the aggregator goes red
 * too, but it has no failure of its own: diagnosing it produces a
 * signature and a stock PR comment about a job that never ran a line of
 * the repo's code.
 *
 * This module is pure — it takes the already-parsed
 * {@link WorkflowFile}s from
 * `workflow_scan_common.ts::readWorkflowFiles` and answers one question:
 * is this failing check downstream of another check that is also red on
 * the same head?
 *
 * Australian English throughout (behaviour, recognised).
 */

import type { WorkflowFile } from "./workflow_scan_common.ts";

/**
 * Job dependency graph keyed by **display name** — a job's `name:` when
 * it has one, else its job id.
 *
 * Display names are used on both sides because that is what a GitHub
 * check-run is called: the check name equals the job's `name:` (or its
 * id when no `name:` is set), so a failing check can be looked up
 * directly and its needs compared against the other failing check names.
 */
export type JobNeedsMap = Map<string, string[]>;

/** Narrow an unknown YAML node to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a job's `needs:`, which GitHub Actions allows as either a single
 * job id or a list of them. Anything else contributes nothing.
 */
function readNeeds(job: Record<string, unknown>): string[] {
  const needs = job.needs;
  if (typeof needs === "string") return [needs];
  if (Array.isArray(needs)) {
    return needs.filter((n): n is string => typeof n === "string");
  }
  return [];
}

/** A job's display name: its `name:` when present, else its job id. */
function displayName(jobId: string, job: Record<string, unknown>): string {
  return typeof job.name === "string" && job.name.length > 0 ? job.name : jobId;
}

/**
 * Build the job dependency graph from a repo's workflow files.
 *
 * Both keys and values are display names (see {@link JobNeedsMap}), so a
 * `needs:` entry — always a job **id** in the YAML — is translated to the
 * needed job's display name. An id with no matching job (a typo, or a job
 * defined in another workflow) is kept verbatim rather than dropped, so
 * nothing silently disappears from the graph.
 *
 * Files whose `parsed` is `null` (unparseable YAML) contribute nothing,
 * as do files with no `jobs:` mapping. A display name defined in more
 * than one workflow contributes the **union** of its needs, so an
 * aggregator is recognised whichever workflow the check run came from.
 *
 * @param files Parsed workflow files from `readWorkflowFiles`.
 * @returns Display name → the display names it needs.
 */
export function buildJobNeedsMap(files: readonly WorkflowFile[]): JobNeedsMap {
  const map: JobNeedsMap = new Map();

  for (const file of files) {
    if (!isRecord(file.parsed)) continue;
    const jobs = file.parsed.jobs;
    if (!isRecord(jobs)) continue;

    // Resolve every id in this file first — `needs:` names ids, and the
    // graph is keyed by display names.
    const idToDisplay = new Map<string, string>();
    for (const [jobId, job] of Object.entries(jobs)) {
      if (!isRecord(job)) continue;
      idToDisplay.set(jobId, displayName(jobId, job));
    }

    for (const [jobId, job] of Object.entries(jobs)) {
      if (!isRecord(job)) continue;
      const from = idToDisplay.get(jobId) ?? jobId;
      const to = readNeeds(job).map((id) => idToDisplay.get(id) ?? id);
      const existing = map.get(from);
      if (existing === undefined) {
        map.set(from, to);
        continue;
      }
      for (const name of to) {
        if (!existing.includes(name)) existing.push(name);
      }
    }
  }

  return map;
}

/**
 * Is `checkName` an aggregator whose needed job is also red on this head?
 *
 * The walk is transitive: an aggregator that needs a gate job that needs
 * the failing job is still downstream of it. A check that matches no job
 * in the graph is a **non-aggregator** and returns `false` — that
 * deliberately covers matrix-suffixed check names such as
 * `build (ubuntu-latest)`, which never equal a job's display name, so a
 * matrix leg is always diagnosed on its own merits.
 *
 * @param checkName The failing check to judge.
 * @param failedCheckNames Every check name failing on the same head.
 * @param map Graph from {@link buildJobNeedsMap}.
 * @returns True when a job it (transitively) needs is itself failing.
 */
export function isDownstreamOfRedJob(
  checkName: string,
  failedCheckNames: readonly string[],
  map: JobNeedsMap,
): boolean {
  if (!map.has(checkName)) return false;

  const failed = new Set(failedCheckNames);
  const visited = new Set<string>([checkName]);
  const queue = [...(map.get(checkName) ?? [])];

  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (visited.has(next)) continue;
    visited.add(next);
    // The check's own redness is what we are explaining, so a cycle back
    // to it is never the explanation.
    if (failed.has(next)) return true;
    queue.push(...(map.get(next) ?? []));
  }

  return false;
}
