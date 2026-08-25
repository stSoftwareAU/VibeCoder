/**
 * Label colour reconciliation across monitored repositories (Issue #368).
 *
 * Creation-time consistency fixes nothing that already exists: a repo whose
 * `severity:critical` was painted grey by whichever call site created it
 * first stays grey forever. This pass reads the canonical table
 * ({@link ALL_LABEL_DEFINITIONS}) and repaints the labels that drifted,
 * reporting exactly what it changed.
 *
 * Two boundaries the pass never crosses:
 *   - It only touches labels the canonical table **names**. A label a human
 *     created in their own repo is left exactly as they set it.
 *   - It never **creates** a label. Seeding is `label-sync`'s job; this pass
 *     only corrects the colour of a label that is already there.
 *
 * Australian English throughout (colour, behaviour, organisation).
 */

import { getLabelByName } from "./label_definitions.ts";

/** Outcome of one command run. */
interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Options for a reconcile run. */
export interface LabelColourReconcileOptions {
  /** Override for command execution (testing). */
  runCommand?: (cmd: string[]) => Promise<CommandOutput>;
  /** Custom gh config directory (from `.config.json` `gh_config_dir`). */
  ghConfigDir?: string;
  /** Report drift without editing anything. */
  dryRun?: boolean;
}

/** One label whose colour differs from the canonical table. */
export interface LabelColourChange {
  /** Label name as it exists on the remote. */
  label: string;
  /** Colour on the remote before the pass, lower-case hex. */
  from: string;
  /** Canonical colour, lower-case hex. */
  to: string;
  /** True when the edit was applied (false in dry-run, or on failure). */
  applied: boolean;
  /** Failure detail when the edit was attempted and failed. */
  error?: string;
}

/** Result of reconciling one repository. */
export interface LabelColourReconcileResult {
  ok: boolean;
  repo: string;
  /** Labels present on the repo that the canonical table names. */
  inspected: number;
  /** Of those, how many carried a non-canonical colour. */
  drifted: number;
  /** Of those, how many were successfully repainted (0 in dry-run). */
  changed: number;
  /** Failed edits, plus 1 when the label list itself could not be read. */
  failures: number;
  dryRun: boolean;
  changes: LabelColourChange[];
  /** Set when the repo's label list could not be read or parsed. */
  error?: string;
}

/** Minimal shape of a `gh label list --json name,color` entry. */
interface RemoteLabel {
  name: string;
  color: string;
}

function createDefaultRunCommand(
  ghConfigDir?: string,
): (cmd: string[]) => Promise<CommandOutput> {
  return async (cmd: string[]): Promise<CommandOutput> => {
    const env = ghConfigDir
      ? { ...Deno.env.toObject(), GH_CONFIG_DIR: ghConfigDir }
      : undefined;
    const command = new Deno.Command(cmd[0]!, {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      env,
    });
    const output = await command.output();
    const decoder = new TextDecoder();
    return {
      success: output.success,
      stdout: decoder.decode(output.stdout).trim(),
      stderr: decoder.decode(output.stderr).trim(),
    };
  };
}

/**
 * Read every label on a repo.
 *
 * Returns an error rather than an empty list when the read fails — an
 * unreadable repo must not be reported as "nothing drifted".
 */
async function listRemoteLabels(
  repo: string,
  runner: (cmd: string[]) => Promise<CommandOutput>,
): Promise<{ ok: true; labels: RemoteLabel[] } | { ok: false; error: string }> {
  const result = await runner([
    "gh",
    "label",
    "list",
    "--repo",
    repo,
    "--limit",
    "500",
    "--json",
    "name,color",
  ]);
  if (!result.success) {
    return { ok: false, error: result.stderr || "gh label list failed" };
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout || "[]");
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "gh label list did not return a JSON array" };
    }
    return {
      ok: true,
      labels: parsed.filter((l): l is RemoteLabel =>
        typeof (l as RemoteLabel)?.name === "string" &&
        typeof (l as RemoteLabel)?.color === "string"
      ),
    };
  } catch (err) {
    return {
      ok: false,
      error: `could not parse gh label list output: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Reconcile the colours of the fleet-managed labels present on one repo.
 *
 * @param repo Repository in `owner/repo` form.
 */
export async function reconcileLabelColoursForRepo(
  repo: string,
  opts: LabelColourReconcileOptions = {},
): Promise<LabelColourReconcileResult> {
  const runner = opts.runCommand ?? createDefaultRunCommand(opts.ghConfigDir);
  const dryRun = opts.dryRun === true;
  const base: LabelColourReconcileResult = {
    ok: true,
    repo,
    inspected: 0,
    drifted: 0,
    changed: 0,
    failures: 0,
    dryRun,
    changes: [],
  };

  const listed = await listRemoteLabels(repo, runner);
  if (!listed.ok) {
    return { ...base, ok: false, failures: 1, error: listed.error };
  }

  for (const remote of listed.labels) {
    // Only labels the canonical table names — a human's own label is left
    // exactly as they set it.
    const canonical = getLabelByName(remote.name);
    if (!canonical) continue;
    base.inspected++;

    // Casing alone is not drift: GitHub returns whatever case the label was
    // created with, and the table is lower-case by construction.
    const current = remote.color.toLowerCase();
    if (current === canonical.colour) continue;
    base.drifted++;

    const change: LabelColourChange = {
      label: remote.name,
      from: current,
      to: canonical.colour,
      applied: false,
    };

    if (dryRun) {
      base.changes.push(change);
      continue;
    }

    const edit = await runner([
      "gh",
      "label",
      "edit",
      remote.name,
      "--repo",
      repo,
      "--color",
      canonical.colour,
    ]);
    if (edit.success) {
      change.applied = true;
      base.changed++;
    } else {
      change.error = edit.stderr || "gh label edit failed";
      base.failures++;
      base.ok = false;
    }
    base.changes.push(change);
  }

  return base;
}

/**
 * Reconcile label colours across every configured repository.
 *
 * A repo that fails is reported and the sweep continues — one unreachable
 * repo must not leave the rest of the fleet drifted.
 */
export async function reconcileLabelColoursForAllRepos(
  repos: string[],
  opts: LabelColourReconcileOptions = {},
): Promise<LabelColourReconcileResult[]> {
  const results: LabelColourReconcileResult[] = [];
  for (const repo of repos) {
    if (!repo) continue;
    results.push(await reconcileLabelColoursForRepo(repo, opts));
  }
  return results;
}
