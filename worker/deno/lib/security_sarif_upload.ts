/**
 * Upload a security-scan SARIF 2.1.0 document to GitHub code scanning
 * (Issue #3538, gap G2). Isolated from the pure builder in
 * `security_sarif.ts` so the network + subprocess side stays testable behind
 * injected runners and the builder stays pure.
 *
 * The upload is **per-repo** (Issue #3239) — it targets the consuming repo's
 * own code-scanning surface via `POST repos/{repo}/code-scanning/sarifs`, and
 * never centralises anything cross-repo.
 *
 * Fail-loud contract (Issue #3234): the outcome is a discriminated result that
 * never collapses "code scanning not enabled / no access" (403/404) into a
 * silent success, and never treats a hard error as a benign no-op.
 *
 * Australian English throughout (behaviour, normalise).
 */

import { parseHttpStatus } from "./alert_feeds/code_scanning_alerts.ts";
import { runGhOrThrow } from "./gh_spawn.ts";

/** Matches a valid `owner/repo` slug (no whitespace, exactly one slash). */
const REPO_SLUG = /^[^/\s]+\/[^/\s]+$/;
/** A full 40-hex-character commit SHA. */
const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * Injected `gh` executor: runs `gh` with the given args, optionally piping
 * `stdin` (for `gh api ... --input -`). Returns stdout; throws with gh stderr
 * on a non-zero exit. Mirrors the `GhExec` convention in
 * `branch_protection_configurator.ts`.
 */
export type GhExec = (args: string[], stdin?: string) => Promise<string>;

/** Injected git runner: runs `git` in `cwd`, returning its exit + output. */
export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Resolved commit + ref the SARIF is attributed to. */
export interface GitRef {
  /** Full 40-char commit SHA. */
  commitSha: string;
  /** Fully-qualified ref, e.g. `refs/heads/main`. */
  ref: string;
}

/** Discriminated outcome of {@link uploadSecuritySarif}. */
export type SarifUploadResult =
  | { kind: "uploaded"; id: string }
  | { kind: "code-scanning-unavailable"; status: 403 | 404; reason: string }
  | { kind: "error"; error: string };

/**
 * Default production git runner — spawns `git -C <cwd> ...`.
 */
export async function defaultGitRunner(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();
  return {
    code,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
}

/**
 * Default production `gh` executor — routed through the shared chokepoint
 * (Issue #3703) so the SARIF upload is allowlist-checked and journalled.
 */
export async function defaultGhExec(
  args: string[],
  stdin?: string,
): Promise<string> {
  return await runGhOrThrow(args, stdin !== undefined ? { stdin } : {});
}

/**
 * gzip-compress a string and base64-encode the result — the payload format
 * GitHub's SARIF upload API expects for its `sarif` field.
 */
export async function gzipBase64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const stream = new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
  );
  const compressed = new Uint8Array(await stream.arrayBuffer());
  let binary = "";
  for (const byte of compressed) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Resolve the commit SHA and fully-qualified ref of a checkout, for SARIF
 * attribution. Returns a typed error (never throws) so the caller can fail
 * loud without aborting the surrounding scan.
 *
 * - commit SHA via `git rev-parse HEAD` (must be a full 40-hex SHA).
 * - ref via `git symbolic-ref -q HEAD` (`refs/heads/<branch>`); on a detached
 *   HEAD `symbolic-ref` exits non-zero and we surface an error rather than
 *   guessing a ref.
 */
export async function resolveGitRef(
  checkoutDir: string,
  runGit: GitRunner = defaultGitRunner,
): Promise<{ ok: true; value: GitRef } | { ok: false; error: string }> {
  const head = await runGit(["rev-parse", "HEAD"], checkoutDir);
  if (head.code !== 0) {
    return {
      ok: false,
      error:
        `git rev-parse HEAD failed (exit ${head.code}): ${head.stderr.trim()}`,
    };
  }
  const commitSha = head.stdout.trim();
  if (!FULL_SHA.test(commitSha)) {
    return {
      ok: false,
      error: `git rev-parse HEAD gave a non-SHA: ${commitSha}`,
    };
  }

  const symref = await runGit(["symbolic-ref", "-q", "HEAD"], checkoutDir);
  if (symref.code !== 0) {
    return {
      ok: false,
      error:
        `git symbolic-ref HEAD failed (detached HEAD?) (exit ${symref.code}): ${symref.stderr.trim()}`,
    };
  }
  const ref = symref.stdout.trim();
  if (!ref.startsWith("refs/")) {
    return {
      ok: false,
      error: `git symbolic-ref gave an unexpected ref: ${ref}`,
    };
  }
  return { ok: true, value: { commitSha, ref } };
}

/** Arguments for {@link uploadSecuritySarif}. */
export interface UploadSarifOptions {
  /** `owner/repo` slug of the target (consuming) repo. */
  repo: string;
  /** Full 40-char commit SHA the SARIF is attributed to. */
  commitSha: string;
  /** Fully-qualified ref, e.g. `refs/heads/main`. */
  ref: string;
  /** The SARIF document as a JSON string. */
  sarifJson: string;
}

/**
 * Upload a SARIF document to a repo's GitHub code scanning.
 *
 * The `sarif` field is gzip+base64 per the API contract. A 403 (code security
 * not enabled / no `security_events` scope) or 404 (code scanning disabled /
 * no access) is surfaced as `code-scanning-unavailable` — distinct from a hard
 * error and never a silent success. Any other failure is surfaced as `error`.
 */
export async function uploadSecuritySarif(
  options: UploadSarifOptions,
  ghExec: GhExec = defaultGhExec,
): Promise<SarifUploadResult> {
  const repo = (options.repo ?? "").trim();
  if (!REPO_SLUG.test(repo)) {
    return { kind: "error", error: `Invalid repo slug: "${options.repo}"` };
  }
  if (!FULL_SHA.test(options.commitSha ?? "")) {
    return {
      kind: "error",
      error: `Invalid commit SHA: "${options.commitSha}"`,
    };
  }
  if (!(options.ref ?? "").startsWith("refs/")) {
    return { kind: "error", error: `Invalid ref: "${options.ref}"` };
  }

  let sarifBase64: string;
  try {
    sarifBase64 = await gzipBase64(options.sarifJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", error: `Failed to gzip SARIF: ${message}` };
  }

  const body = JSON.stringify({
    commit_sha: options.commitSha,
    ref: options.ref,
    sarif: sarifBase64,
  });

  let raw: string;
  try {
    raw = await ghExec(
      [
        "api",
        "-X",
        "POST",
        `repos/${repo}/code-scanning/sarifs`,
        "--input",
        "-",
      ],
      body,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = parseHttpStatus(message);
    if (status === 403 || status === 404) {
      return { kind: "code-scanning-unavailable", status, reason: message };
    }
    return { kind: "error", error: message };
  }

  // The API returns `{ id, url }` on success; carry the id for traceability.
  let id = "";
  try {
    const parsed = JSON.parse(raw.trim() || "{}");
    if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
      id = parsed.id;
    }
  } catch {
    // A non-JSON success body is unexpected but not a failure — the POST
    // succeeded (2xx). Leave id empty.
  }
  return { kind: "uploaded", id };
}
