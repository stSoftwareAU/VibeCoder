/**
 * Filing attestations for auto-filed worker diagnostics (Issue #1277).
 *
 * Tier 2b (`collect_self_diagnostic_candidates.ts`) is the one discovery
 * route that emits a workable candidate with no human-applied label. Its
 * provenance gate was repo + body marker + fleet author — and the marker
 * lives in the body, which is exactly what an injected agent holding the
 * run's `gh` credential writes. `gh issue create --body '<!-- VIBE_RUN_FAILURE:… -->'`
 * in the worker's own repo therefore minted a self-scheduled work item, so
 * the composed gate reduced to "filed by the worker account", the signal the
 * module's own docstring calls insufficient.
 *
 * This module supplies the missing signal: evidence the agent cannot mint.
 * When the worker's own filer creates a diagnostic it records a **filing
 * attestation** in the tamper-evident audit journal
 * (`audit_journal.ts`) — the created issue number and a digest of the body
 * it posted, under the distinct {@link SELF_DIAGNOSTIC_FILING_VERB}. The
 * collector then emits a candidate only for an issue that attestation
 * names.
 *
 * Why an agent cannot forge one:
 *
 *   - The journal lives **outside** every repo working tree, under
 *     `${WORK_DIR}/audit/`, so nothing the agent writes in the clone
 *     reaches it.
 *   - The agent's own `gh` calls *are* journalled — by `gh_guard_shim.ts`,
 *     under the mutation classifier's verb (`issue create`), never under
 *     this module's verb and never carrying the created issue's number,
 *     which is not in the argv it is classifying.
 *   - Appending a forged line directly is not silent: every append is
 *     hash-chained and anchored, so an interior write, a rewritten entry or
 *     an unanchored tail is reported loud by the chain sweep.
 *
 * The body digest closes the follow-on move. Without it the agent could
 * leave the worker's genuinely-filed diagnostic in place and rewrite its
 * body — the fleet login is inside `allowed_authors`, so the sibling
 * content-integrity gate would read that edit as a trusted one — and the
 * worker would schedule attacker-authored content under a real
 * attestation. The digest is taken over the body the filer posted, so an
 * edited body no longer matches and the diagnostic falls back to waiting
 * for a human `work-on`.
 *
 * Fail closed, and loud: an unreadable journal, a disabled journal, a
 * missing attestation and a mismatched body all refuse the candidate and
 * say which of those it was. The diagnostic stays open and a human `work-on`
 * still schedules it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { AuditEntry } from "./audit_entry.ts";
import {
  loadEntries,
  recordMutation,
  resolveBaseDir,
  resolveRunId,
} from "./audit_journal.ts";
import { isAuditJournalEnabled } from "./audit_hook.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/**
 * Audit-chain verb for "the worker's own filer created this diagnostic".
 *
 * Deliberately distinct from the `self-schedule-diagnostic` verb in
 * `self_diagnostic_provenance.ts`: that one records the *scheduling*
 * decision, this one the *filing* it must be able to point back to.
 */
export const SELF_DIAGNOSTIC_FILING_VERB = "file-self-diagnostic";

/** Journal file names the sweep and this reader both recognise. */
const JOURNAL_FILE_PATTERN = /^audit-.*\.jsonl$/;

/** Digest field embedded in the attestation entry's `caller`. */
const BODY_DIGEST_FIELD = "body-sha256";

/** Where attestations are written and read. Overridden by tests only. */
export interface AttestationOptions {
  /** Audit directory; defaults to the environment's `${WORK_DIR}/audit`. */
  baseDir?: string;
  /** Environment lookup; defaults to the real process environment. */
  env?: EnvLookup;
  /** Journal partition, mirroring `RecordOptions.workerId`. */
  workerId?: string;
  /** Journal date partition, mirroring `RecordOptions.date`. */
  date?: string;
  /** Sink for refusal/diagnostic lines. Defaults to `console.error`. */
  log?: (message: string) => void;
}

/** One diagnostic the worker's own filer created. */
export interface SelfDiagnosticFiling {
  /** Repo the issue was filed in. */
  repo: string;
  /** Number of the created issue. */
  issueNumber: number;
  /** Family id from `SELF_DIAGNOSTIC_FAMILIES`, e.g. `run-failure`. */
  familyId: string;
  /** The exact body the filer posted. */
  body: string;
  /** Module that filed it, e.g. `worker/deno/lib/run_failure_issue.ts`. */
  filedBy: string;
}

/** Why an issue is, or is not, backed by a filing attestation. */
export type AttestationVerdict =
  | { attested: true; familyId: string }
  | {
    attested: false;
    reason: "no-attestation" | "body-mismatch" | "journal-unavailable";
    detail: string;
  };

/**
 * Normalise a body before digesting it.
 *
 * GitHub returns issue bodies with CRLF line endings whatever was posted, so
 * the filer's own text and the text a later scan reads back differ by line
 * endings alone. Folding them (and trailing whitespace) is what makes the
 * digest compare like with like; it weakens nothing, because a body that
 * differs only in line endings is the same body.
 */
export function normaliseBodyForDigest(body: string): string {
  return body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd();
}

/** SHA-256 hex digest of the normalised body. */
export async function computeBodyDigest(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(normaliseBodyForDigest(body));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The `caller` field of an attestation entry — family and body digest. */
function formatAttestationCaller(
  filing: Pick<SelfDiagnosticFiling, "familyId" | "filedBy">,
  digest: string,
): string {
  return `${filing.filedBy} (family=${filing.familyId} ` +
    `${BODY_DIGEST_FIELD}=${digest})`;
}

/** The family id and body digest carried by an attestation entry. */
function parseAttestationCaller(
  caller: string | undefined,
): { familyId: string; digest: string } | null {
  if (!caller) return null;
  const family = /\bfamily=([A-Za-z0-9_-]+)/.exec(caller);
  const digest = /\bbody-sha256=([0-9a-f]{64})\b/.exec(caller);
  if (!family || !digest) return null;
  return { familyId: family[1]!, digest: digest[1]! };
}

/**
 * Record that the worker's own filer created this diagnostic.
 *
 * Best-effort by contract, like every other journal write: it never throws
 * and never aborts the filing it describes. A failure is logged and returns
 * false — the diagnostic is still filed, it simply is not self-schedulable
 * until a human applies `work-on`, which is the fail-closed direction.
 *
 * @returns true when the attestation reached the audit chain.
 */
export async function recordSelfDiagnosticFiling(
  filing: SelfDiagnosticFiling,
  opts: AttestationOptions = {},
): Promise<boolean> {
  const env = opts.env ?? processEnvLookup;
  const log = opts.log ?? ((message: string) => console.error(message));
  const target = `${filing.repo}#${filing.issueNumber}`;

  if (filing.issueNumber <= 0) {
    log(
      `[self-diagnostic] no filing attestation for ${filing.repo}: the ` +
        `created issue number could not be parsed — the diagnostic waits ` +
        `for a human \`work-on\``,
    );
    return false;
  }

  if (!isAuditJournalEnabled(env)) {
    log(
      `[self-diagnostic] no filing attestation for ${target}: audit ` +
        `journalling is not enabled (WORK_DIR unset, or VIBE_AUDIT_DISABLED) ` +
        `— the diagnostic waits for a human \`work-on\``,
    );
    return false;
  }

  const digest = await computeBodyDigest(filing.body);
  const recorded = await recordMutation({
    runId: resolveRunId(env),
    repo: filing.repo,
    target: `#${filing.issueNumber}`,
    verb: SELF_DIAGNOSTIC_FILING_VERB,
    outcome: "success",
    caller: formatAttestationCaller(filing, digest),
  }, {
    ...(opts.baseDir ? { baseDir: opts.baseDir } : {}),
    ...(opts.workerId ? { workerId: opts.workerId } : {}),
    ...(opts.date ? { date: opts.date } : {}),
    env,
  });

  if (!recorded.ok) {
    log(
      `[self-diagnostic] filing attestation for ${target} could not be ` +
        `recorded: ${recorded.error.message} — the diagnostic waits for a ` +
        `human \`work-on\``,
    );
    return false;
  }
  return true;
}

/** Attestations found for one repo, keyed by issue number. */
type AttestationIndex = Map<number, { familyId: string; digests: Set<string> }>;

/** Case-insensitive `owner/repo` comparison. */
function sameRepo(a: string | undefined, b: string): boolean {
  return (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
}

/** Add one journal entry to the index when it attests a filing in `repo`. */
function indexEntry(
  index: AttestationIndex,
  entry: AuditEntry,
  repo: string,
): void {
  if (entry.verb !== SELF_DIAGNOSTIC_FILING_VERB) return;
  if (!sameRepo(entry.repo, repo)) return;
  const number = /^#(\d+)$/.exec((entry.target ?? "").trim());
  if (!number) return;
  const parsed = parseAttestationCaller(entry.caller);
  if (!parsed) return;
  const issueNumber = parseInt(number[1]!, 10);
  const existing = index.get(issueNumber);
  if (existing) {
    existing.digests.add(parsed.digest);
    return;
  }
  index.set(issueNumber, {
    familyId: parsed.familyId,
    digests: new Set([parsed.digest]),
  });
}

/**
 * Read every filing attestation for `repo` out of the local audit journals.
 *
 * Throws only when the audit directory itself cannot be listed — a missing
 * directory is an empty index (nothing was ever filed here), not an error.
 * A journal file that cannot be parsed is logged and skipped: its issues
 * then have no attestation and are refused, which is the fail-closed
 * direction.
 */
async function readAttestations(
  repo: string,
  opts: AttestationOptions,
): Promise<AttestationIndex> {
  const env = opts.env ?? processEnvLookup;
  const log = opts.log ?? ((message: string) => console.error(message));
  const baseDir = resolveBaseDir(opts.baseDir, env);
  const index: AttestationIndex = new Map();

  const names: string[] = [];
  try {
    for await (const item of Deno.readDir(baseDir)) {
      if (item.isFile && JOURNAL_FILE_PATTERN.test(item.name)) {
        names.push(item.name);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return index;
    throw err;
  }

  for (const name of names.sort()) {
    const path = `${baseDir}/${name}`;
    const entries = await loadEntries(path);
    if (!entries.ok) {
      log(
        `[self-diagnostic] audit journal ${path} could not be read: ` +
          `${entries.error.message} — any diagnostic it attests stays ` +
          `unschedulable`,
      );
      continue;
    }
    for (const entry of entries.value) indexEntry(index, entry, repo);
  }
  return index;
}

/**
 * Verify the worker's own filer created each of these issues.
 *
 * One journal sweep serves the whole batch, so the cost does not scale with
 * the number of candidate diagnostics.
 *
 * @param repo - Repo the issues live in.
 * @param issues - Candidate diagnostics, with the body the scan read.
 * @returns One verdict per issue number, in the order they were supplied.
 */
export async function verifySelfDiagnosticFilings(
  repo: string,
  issues: readonly { number: number; body?: string }[],
  opts: AttestationOptions = {},
): Promise<Map<number, AttestationVerdict>> {
  const env = opts.env ?? processEnvLookup;
  const verdicts = new Map<number, AttestationVerdict>();

  const unavailable = (detail: string): Map<number, AttestationVerdict> => {
    for (const issue of issues) {
      verdicts.set(issue.number, {
        attested: false,
        reason: "journal-unavailable",
        detail,
      });
    }
    return verdicts;
  };

  if (!isAuditJournalEnabled(env)) {
    return unavailable(
      "audit journalling is not enabled (WORK_DIR unset, or " +
        "VIBE_AUDIT_DISABLED), so no filing attestation can be verified",
    );
  }

  let index: AttestationIndex;
  try {
    index = await readAttestations(repo, opts);
  } catch (err) {
    return unavailable(
      `the audit journals could not be listed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  for (const issue of issues) {
    const found = index.get(issue.number);
    if (!found) {
      verdicts.set(issue.number, {
        attested: false,
        reason: "no-attestation",
        detail: "no filing attestation in the audit chain — the worker's own " +
          "filer did not create this issue",
      });
      continue;
    }
    const digest = await computeBodyDigest(issue.body ?? "");
    if (!found.digests.has(digest)) {
      verdicts.set(issue.number, {
        attested: false,
        reason: "body-mismatch",
        detail: "the body no longer matches the one the filer posted, so " +
          "the attestation does not cover the current content",
      });
      continue;
    }
    verdicts.set(issue.number, { attested: true, familyId: found.familyId });
  }
  return verdicts;
}
