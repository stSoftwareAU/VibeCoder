/**
 * Per-run write-repo allowlist — egress containment (Issue #3311).
 *
 * Workstream 1 of #3309 (harden the Vibe Coder against GitLost-style
 * prompt-injection data leaks). A successful prompt injection can read one
 * repo and post its contents as a public comment in another; there is no
 * runtime egress restriction on the agent. This module adds one: every
 * GitHub *write* the worker performs is validated against the current run's
 * allowlist of target repos **before it reaches GitHub**. A write to any
 * repo not on the allowlist is refused (thrown) and recorded as a security
 * audit event.
 *
 * Chokepoint — worker process. {@link enforceGhWriteAllowlist} is called
 * from the single lowest-level `gh` spawn (`spawnGh` in gh_spawn.ts) — the
 * shared path every comment / label / PR / `gh api` write the *worker*
 * performs flows through, including `runGhCommandRaw` in github.ts. Until
 * Issue #3703 that contract was aspirational: ~20 modules spawned `gh`
 * themselves and skipped both this allowlist and the audit journal. A
 * quality-gate check (`gh_spawn_chokepoint_check.ts`) now fails the build on
 * any direct `new Deno.Command("gh", …)` outside the chokepoint.
 *
 * The command's target `owner/repo` is derived by the existing mutation
 * classifier (audit_mutation_classifier.ts); a write with no explicit
 * `-R`/endpoint targets the cwd repo (the run's own clone) and is allowed,
 * while a mutation whose target cannot be determined at all fails closed
 * (Issue #3703).
 *
 * Second chokepoint — agent subprocess (Issue #3643). The agent runs in a
 * *different* process with unrestricted Bash and an inherited `GH_TOKEN`, so
 * its own `gh` calls never traverse `runGhCommandRaw` and this module alone
 * did not constrain them. `gh_guard_shim.ts` closes that gap by putting a
 * `gh` wrapper first on the child's `PATH`; the wrapper re-enters the same
 * allowlist decision (`gh_guard_decision.ts`) before the real binary runs.
 * That wrapper is a containment boundary, not a sandbox — an agent that
 * calls the real binary by absolute path still bypasses it. Behind it sits the
 * credential layer noted below (Issue #1391): the token itself only reaches
 * the repos the run may write to, so a bypass of the wrapper is not a bypass
 * of the boundary.
 *
 * Fail-open until seeded. The allowlist is inert until a run seeds it with
 * {@link seedWriteRepoAllowlist}, so unrelated flows and tests are
 * unaffected until a run opts in. The production seed points are
 * `issue_worker.ts` (the claimed issue's own repo) and
 * `idle_task_claim_handler.ts` (the scanned repo).
 *
 * Extension points, and their limit (Issue #3861). Exactly three things
 * widen a seeded allowlist:
 *
 *   1. A full reseed ({@link seedWriteRepoAllowlist}) for the next claim.
 *   2. {@link registerWriteRepo} — a **worker-process** grant, used by the
 *      #3860 seed-idle-tasks flow (`commands/process_seed_idle_tasks.ts`),
 *      which never spawns the agent and releases the grant in a `finally`.
 *   3. Refcounted heartbeat pins ({@link pinWriteRepo}, Issue #3760).
 *   4. {@link withScopedWriteRepo} — a **worker-process** grant scoped to a
 *      single validated call and removed in a `finally` (Issue #182). Its one
 *      production caller is the cross-repo dependency-PR bridge
 *      (`cross_repo_pr_handoff.ts`), which first validates the target as a
 *      reachable, pushable `stSoftwareAU/*` repo that the consuming repo's
 *      own manifest declares as a dependency (Issue #1382) — sharing the
 *      owner is not on its own a reason to write to a sibling tenant.
 *
 * None of them reaches an agent subprocess that is already running.
 * `gh_guard_shim.ts` bakes a snapshot of this allowlist into the child's `gh`
 * wrapper at spawn time, and that snapshot is deliberately not live: an
 * allowlist file re-read per invocation would be one more mutable surface
 * sitting next to an agent with unrestricted Bash. Mid-run extension of the
 * *agent's* boundary is unsupported by design, so a grant made after the
 * snapshot says so with a `[SECURITY] [WRITE_REPO_GRANT_AFTER_SPAWN]` line
 * rather than silently appearing to widen it. See SECURITY.md §6.
 *
 * Credential layer (Issue #1391). #3311 was code-level containment only, and
 * the deferred half was the credential itself: an unscoped installation token
 * carries the App's permissions on *every* repo of the installation, so any
 * write that slips past the two code chokepoints — a new direct spawn, a
 * classifier gap, the agent calling the real `gh` binary by absolute path —
 * still succeeds. {@link installationTokenRepoScope} closes that: while
 * enforcement is active, `gh_spawn.ts` mints the installation token scoped to
 * exactly the repos this run may write to, so GitHub refuses the rest.
 * {@link withTokenScopedRepo} is the one way to widen the *credential's* reach
 * without widening the write allowlist — the cross-repo dependency-PR bridge
 * needs to READ a dependency repo before the `withScopedWriteRepo` grant lets
 * it write one PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { AuditEntry, AuditMutation } from "./audit_journal.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { recordMutation, resolveRunId } from "./audit_journal.ts";
import { classifyGhMutation } from "./audit_mutation_classifier.ts";

/** Sink for recording a security audit event (injectable for tests). */
export type AuditRecorder = (
  mutation: AuditMutation,
) => Promise<Result<AuditEntry>>;

/** Sink for the security log line (injectable for tests). */
export type SecurityLogger = (message: string) => void;

/**
 * Error thrown when a GitHub write targets a repo not on the run's
 * allowlist. The message deliberately avoids retry-trigger keywords
 * (e.g. "rate limit", "timeout") so `retryWithBackoff` treats it as a hard,
 * non-transient failure and does not loop.
 */
export class WriteRepoBlockedError extends Error {
  /** The off-allowlist `owner/repo` that was refused. */
  readonly repo: string;
  /** The classified mutation verb (e.g. "issue-comment"), when known. */
  readonly verb?: string;

  constructor(repo: string, verb?: string) {
    super(
      `Refused GitHub write to off-allowlist repo: ${repo}` +
        (verb ? ` (${verb})` : ""),
    );
    this.name = "WriteRepoBlockedError";
    this.repo = repo;
    this.verb = verb;
  }
}

/**
 * Error thrown when a GitHub write's target repo cannot be determined
 * (Issue #3703).
 *
 * The allowlist used to return early whenever the classifier derived no
 * repo, so a GraphQL mutation, an absolute `https://api.github.com/…`
 * endpoint, or an unlisted root verb passed unchecked. Those now fail
 * closed. Like {@link WriteRepoBlockedError} the message avoids
 * retry-trigger keywords so `retryWithBackoff` treats it as terminal.
 */
export class WriteTargetUndeterminableError extends Error {
  /** The classified mutation verb (e.g. "api-graphql-mutation"). */
  readonly verb: string;
  /** The mutation target (endpoint / GraphQL fields), when known. */
  readonly target?: string;

  constructor(verb: string, target?: string) {
    super(
      `Refused GitHub write with an undeterminable target repo (${verb})` +
        (target ? ` — target: ${target}` : ""),
    );
    this.name = "WriteTargetUndeterminableError";
    this.verb = verb;
    if (target !== undefined) this.target = target;
  }
}

/**
 * The per-slot allowlist state (Issue #4175, part of #4168).
 *
 * These four fields used to be module-level singletons — one per worker
 * process. Two concurrent slots would have shared them, so seeding for
 * slot B would either clobber slot A's allowlist or widen the process
 * allowlist to the UNION of both repos — and a prompt injection in slot
 * A's repo could then write to slot B's. The state now lives in a context
 * object; a slot runs inside {@link withWriteRepoAllowlistContext} and
 * every exported function below resolves the ambient context through
 * `AsyncLocalStorage`, so the ~20 call sites and the `spawnGh` chokepoint
 * keep their signatures. Outside any slot scope the process-wide default
 * context is used, which is exactly today's single-slot behaviour.
 *
 * The production wrap site is the slot pool (`run_core.ts`), which gives
 * **every claim** a fresh context (Issue #183). Until it did, nothing called
 * the wrapper: both slots resolved to `defaultContext`, the second claim's
 * seed clobbered the first's allowlist, and the losing slot's agent shim was
 * baked with its sibling's repo — the exact failure this context object
 * exists to prevent.
 */
export interface WriteRepoAllowlistContext {
  /** Whether enforcement is active for the current run. */
  active: boolean;
  /** Normalised (`owner/repo`, lower-case) repos the run may write to. */
  readonly allowed: Set<string>;
  /**
   * Normalised repos pinned by long-lived background writers, with a
   * refcount per repo (Issue #3760).
   *
   * A heartbeat is a `setInterval` that keeps PATCHing a marker comment on
   * *its* claim's repo for as long as it runs. {@link seedWriteRepoAllowlist}
   * clears `allowed` on every new claim, so a heartbeat spanning a claim
   * boundary used to have every marker refresh refused — sibling hosts'
   * stuck-detection then saw the claim as dead and could steal the issue.
   * Pins live outside the per-run set: neither seeding nor
   * {@link resetWriteRepoAllowlist} clears them; only the writer that pinned
   * releases them ({@link unpinWriteRepo}, called from `stopHeartbeat`).
   *
   * This does not reopen the #3311 exfiltration vector: the pinned repo is
   * the claimed issue's repo — a worker-controlled value the agent cannot
   * influence — and the refcount means a repo is only writable while at
   * least one live heartbeat still targets it.
   */
  readonly pinned: Map<string, number>;
  /**
   * Repos the minted installation token may **reach**, beyond the repos this
   * run may write to (Issue #1391), with a refcount per repo.
   *
   * A GitHub App token is scoped per repository, not per verb, so a repo the
   * worker only needs to READ must still be named in the token's scope. This
   * set exists so naming it there does not also put it on the write
   * allowlist: the credential reaches it, the `spawnGh` chokepoint still
   * refuses every write to it. Granted only by {@link withTokenScopedRepo} and
   * released when that call settles.
   */
  readonly tokenScoped: Map<string, number>;
  /**
   * The casing each normalised slug was first seen in (Issue #1391).
   *
   * Every set above is keyed by the lower-cased slug so comparisons are
   * case-insensitive, but {@link installationTokenRepoScope} feeds repository
   * names to GitHub, and a name is worth sending exactly as the operator wrote
   * it rather than as this module happened to fold it.
   */
  readonly slugCasing: Map<string, string>;
  /**
   * Whether an agent subprocess has already baked a snapshot of this run's
   * allowlist into its `gh` guard shim (Issue #3861).
   *
   * Set by {@link noteAgentAllowlistSnapshot}, called from
   * `prepareGhGuardShim`. Cleared by a reseed or a reset, because both start
   * a fresh run whose agent has not been spawned yet.
   */
  agentSnapshotTaken: boolean;
}

/** A fresh, inactive context. */
export function createWriteRepoAllowlistContext(): WriteRepoAllowlistContext {
  return {
    active: false,
    allowed: new Set<string>(),
    pinned: new Map<string, number>(),
    tokenScoped: new Map<string, number>(),
    slugCasing: new Map<string, string>(),
    agentSnapshotTaken: false,
  };
}

/** The process-wide default context — single-slot behaviour, unchanged. */
const defaultContext = createWriteRepoAllowlistContext();

/** Ambient per-slot context (Issue #4175). */
const contextStorage = new AsyncLocalStorage<WriteRepoAllowlistContext>();

/** The context the current async scope is running in. */
function ctx(): WriteRepoAllowlistContext {
  return contextStorage.getStore() ?? defaultContext;
}

/**
 * Run `fn` with its own allowlist context (Issue #4175). Everything the
 * exported functions do inside `fn` — seeding, registering, pinning,
 * enforcing, snapshotting — is scoped to `context`; a concurrent slot in
 * another context is unaffected. Nested `await`s stay in scope; the
 * context is not visible outside `fn`.
 */
export function withWriteRepoAllowlistContext<T>(
  context: WriteRepoAllowlistContext,
  fn: () => Promise<T>,
): Promise<T> {
  return contextStorage.run(context, fn);
}

/** The context the current scope resolves to. Test/diagnostic seam. */
export function currentWriteRepoAllowlistContext(): WriteRepoAllowlistContext {
  return ctx();
}

/** Injected audit sink (defaults to the production journal path). */
let auditRecorder: AuditRecorder = recordMutation;

/** Injected security-log sink (defaults to console.error). */
let securityLogger: SecurityLogger = (m) => console.error(m);

/** Normalise a repo slug for case-insensitive comparison. */
function normalise(repo: string): string {
  return repo.trim().toLowerCase();
}

/**
 * Normalise `repo` and remember the casing it arrived in (Issue #1391), so the
 * repository names sent to GitHub read as the operator wrote them.
 */
function normaliseKeepingCase(repo: string): string {
  const trimmed = repo.trim();
  const n = trimmed.toLowerCase();
  if (n.length > 0 && !ctx().slugCasing.has(n)) {
    ctx().slugCasing.set(n, trimmed);
  }
  return n;
}

/**
 * Deactivate enforcement and clear the allowlist.
 *
 * Called between runs (and from test cleanup) so one run's allowlist never
 * leaks into the next.
 */
export function resetWriteRepoAllowlist(): void {
  const c = ctx();
  c.active = false;
  c.allowed.clear();
  c.agentSnapshotTaken = false;
}

/**
 * Record that an agent subprocess has baked this run's allowlist into its
 * `gh` guard shim (Issue #3861).
 *
 * Called from `prepareGhGuardShim` — the one place that reads the live
 * allowlist for a child spawn. From here on {@link registerWriteRepo} warns
 * loudly, because a grant added now widens the *worker's* boundary only: the
 * running agent keeps the snapshot it was spawned with.
 */
export function noteAgentAllowlistSnapshot(): void {
  ctx().agentSnapshotTaken = true;
}

/**
 * Seed the allowlist for a new run and activate enforcement.
 *
 * Clears the previous run's seeded/registered repos, then adds
 * `targetRepo`. Pins ({@link pinWriteRepo}) survive the clear — they are
 * owned by long-lived writers, not by any single run. From this point every
 * off-allowlist GitHub write is refused until {@link resetWriteRepoAllowlist}.
 *
 * @param targetRepo - The run's own target repo, `owner/repo`.
 */
export function seedWriteRepoAllowlist(targetRepo: string): void {
  const c = ctx();
  c.allowed.clear();
  c.active = true;
  c.agentSnapshotTaken = false;
  registerWriteRepo(targetRepo);
}

/**
 * Register an additional repo the current run may write to.
 *
 * A **worker-process** grant. Its one production caller is the #3860
 * seed-idle-tasks flow (`commands/process_seed_idle_tasks.ts`), which adds
 * the operator-approved target repo alongside the requesting issue's own
 * repo, seeds the wrappers itself, and releases the grant in a `finally`.
 * That flow never spawns the agent.
 *
 * It does **not** extend an already-spawned agent's boundary (Issue #3861):
 * the `gh` guard shim baked its allowlist at spawn time. A grant made after
 * that snapshot is still applied for the worker, but is reported with a
 * `[SECURITY] [WRITE_REPO_GRANT_AFTER_SPAWN]` line so the mis-sequencing is
 * visible instead of looking like a widened agent boundary that never was.
 *
 * A no-op on an empty/blank slug.
 *
 * @param repo - Additional `owner/repo` to allow.
 */
export function registerWriteRepo(repo: string): void {
  const n = normaliseKeepingCase(repo);
  if (n.length === 0) return;
  const c = ctx();
  if (c.agentSnapshotTaken && !c.allowed.has(n)) {
    securityLogger(
      `[SECURITY] [WRITE_REPO_GRANT_AFTER_SPAWN] Granted ${n} after the agent ` +
        "gh guard shim baked this run's allowlist — the grant applies to the " +
        "worker process only; the running agent subprocess cannot write to it.",
    );
  }
  c.allowed.add(n);
}

/**
 * Run `fn` with `repo` temporarily on the **worker's** allowlist, then remove
 * it again (Issue #182).
 *
 * The one production caller is the cross-repo dependency-PR bridge
 * (`cross_repo_pr_handoff.ts`): the agent cannot open a PR in an internal
 * `stSoftwareAU/*` dependency (its `gh` guard only knows the claim repo), so it
 * pushes the branch and declares the PR, and the *worker* opens it. That single
 * `gh pr create` is the only write the grant covers.
 *
 * The grant is deliberately narrower than {@link registerWriteRepo}:
 *
 * - **Scoped in time** — the repo is removed from the allowlist as soon as
 *   `fn` settles, including when it throws, so the boundary re-closes.
 * - **Worker-only** — the agent subprocess baked its own allowlist snapshot at
 *   spawn time (see the module doc above and SECURITY.md §6), so this cannot
 *   widen what the agent itself may write to.
 * - **Announced** — a `[SECURITY] [WRITE_REPO_SCOPED_GRANT]` line records the
 *   grant, so a cross-repo write is never invisible.
 *
 * Callers MUST validate the target first (internal owner + reachable + push
 * permission); this helper enforces scope, not policy. A repo already on the
 * allowlist (or pinned) is left exactly as it was.
 *
 * @param repo - `owner/repo` the worker may write to for the duration of `fn`.
 * @param fn - The single validated cross-repo operation.
 */
export async function withScopedWriteRepo<T>(
  repo: string,
  fn: () => Promise<T>,
): Promise<T> {
  const n = normaliseKeepingCase(repo);
  const c = ctx();
  // Nothing to grant: no slug, enforcement inactive, or already writable.
  if (n.length === 0 || !c.active || c.allowed.has(n) || c.pinned.has(n)) {
    return await fn();
  }
  securityLogger(
    `[SECURITY] [WRITE_REPO_SCOPED_GRANT] Granted ${repo.trim()} for the duration of one ` +
      "validated cross-repo call — worker process only; the running agent " +
      "subprocess cannot write to it.",
  );
  c.allowed.add(n);
  try {
    return await fn();
  } finally {
    c.allowed.delete(n);
  }
}

/**
 * Run `fn` with `repo` reachable by the run's **installation token**, without
 * putting it on the write allowlist (Issue #1391).
 *
 * A GitHub App token is scoped per repository, not per verb: a repo the worker
 * must READ has to be named in the token's scope or every call to it 404s. The
 * one production caller is the cross-repo dependency-PR bridge
 * (`cross_repo_pr_handoff.ts`), which probes an authorised internal dependency
 * — its default branch, the pushed head, an already-open PR — before opening
 * the single PR that {@link withScopedWriteRepo} covers.
 *
 * The grant is deliberately weaker than {@link withScopedWriteRepo}:
 *
 * - **Reach, not authority** — the repo is *not* added to `allowed`, so the
 *   `spawnGh` chokepoint refuses every write to it exactly as before.
 * - **Scoped in time** — refcounted and released when `fn` settles, including
 *   when it throws.
 * - **Worker-only** — the agent subprocess holds its own credential and its
 *   own baked allowlist snapshot; neither is touched here.
 *
 * Callers MUST validate the target first; this helper enforces scope, not
 * policy. A no-op on a blank slug, and inert while enforcement is inactive
 * (an unscoped token already reaches everything).
 *
 * @param repo - `owner/repo` the token may reach for the duration of `fn`.
 * @param fn - The validated cross-repo operation.
 */
export async function withTokenScopedRepo<T>(
  repo: string,
  fn: () => Promise<T>,
): Promise<T> {
  const n = normaliseKeepingCase(repo);
  const c = ctx();
  if (n.length === 0 || !c.active) return await fn();
  securityLogger(
    `[SECURITY] [TOKEN_SCOPE_GRANT] Installation token scoped to include ${repo.trim()} ` +
      "for the duration of one validated cross-repo call — read reach only; " +
      "writes to it are still refused by the write-repo allowlist.",
  );
  c.tokenScoped.set(n, (c.tokenScoped.get(n) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const count = c.tokenScoped.get(n) ?? 0;
    if (count <= 1) c.tokenScoped.delete(n);
    else c.tokenScoped.set(n, count - 1);
  }
}

/**
 * The repositories the run's GitHub App installation token may reach
 * (Issue #1391).
 *
 * `null` while enforcement is inactive — the run has not seeded an allowlist,
 * so there is nothing to scope to and the token keeps the installation's full
 * reach (the same fail-open-until-seeded rule the write checks follow). Once
 * seeded it is the repos this run may write to (`allowed` ∪ `pinned`) plus any
 * repo a live {@link withTokenScopedRepo} grant needs to read.
 *
 * Slugs are returned in the casing they were registered in — GitHub is fed
 * repository names, not this module's comparison keys.
 *
 * @returns Sorted `owner/repo` slugs, or `null` for an unscoped token.
 */
export function installationTokenRepoScope(): string[] | null {
  const c = ctx();
  if (!c.active) return null;
  const keys = new Set([
    ...c.allowed,
    ...c.pinned.keys(),
    ...c.tokenScoped.keys(),
  ]);
  return [...keys].map((n) => c.slugCasing.get(n) ?? n).sort();
}

/**
 * Pin a repo so it stays writable across allowlist reseeds (Issue #3760).
 *
 * Called by `startHeartbeat` with the claim's repo before the initial
 * marker write. Refcounted — two heartbeats on the same repo hold two
 * pins, and the repo stays writable until both release. A no-op on an
 * empty/blank slug.
 *
 * @param repo - `owner/repo` to pin.
 */
export function pinWriteRepo(repo: string): void {
  const n = normaliseKeepingCase(repo);
  if (n.length === 0) return;
  const { pinned } = ctx();
  pinned.set(n, (pinned.get(n) ?? 0) + 1);
}

/**
 * Release one pin on a repo (Issue #3760).
 *
 * Called by `stopHeartbeat` after the final stale-marker write. The repo
 * loses its reseed-proof protection once the last pin is released. A safe
 * no-op when the repo holds no pin.
 *
 * @param repo - `owner/repo` to unpin.
 */
export function unpinWriteRepo(repo: string): void {
  const n = normalise(repo);
  const { pinned } = ctx();
  const count = pinned.get(n);
  if (count === undefined) return;
  if (count <= 1) pinned.delete(n);
  else pinned.set(n, count - 1);
}

/** Clear all pins. Test-only — production pins are released by their owner. */
export function _resetWriteRepoPins(): void {
  ctx().pinned.clear();
}

/** Whether enforcement is active (i.e. a run has seeded the allowlist). */
export function isWriteRepoAllowlistActive(): boolean {
  return ctx().active;
}

/** The current allowlist as a sorted array of `owner/repo` slugs. */
export function listAllowedWriteRepos(): string[] {
  return [...ctx().allowed].sort();
}

/**
 * Whether a write to `repo` is permitted for the current run.
 *
 * Always `true` while enforcement is inactive (fail-open until seeded).
 *
 * @param repo - `owner/repo` to check.
 */
export function isWriteRepoAllowed(repo: string): boolean {
  const c = ctx();
  if (!c.active) return true;
  const n = normalise(repo);
  // Pinned repos (Issue #3760) are writable regardless of the current
  // run's seeded set — an active heartbeat must be able to refresh its
  // marker even after the next claim reseeds.
  return c.allowed.has(n) || c.pinned.has(n);
}

/** Record a blocked write as a security audit event (best-effort). */
async function recordBlocked(
  repo: string,
  verb: string,
  target: string | undefined,
): Promise<void> {
  try {
    await auditRecorder({
      runId: resolveRunId(),
      verb: `blocked-${verb}`,
      outcome: "error",
      repo,
      ...(target ? { target } : {}),
      caller: "worker/deno/lib/write_repo_allowlist.ts",
    });
  } catch {
    // Best-effort: never let audit journalling mask the block itself.
  }
}

/**
 * Enforce the allowlist for a single `gh` invocation.
 *
 * A no-op when enforcement is inactive, when the command is not a GitHub
 * mutation, or when the mutation targets the cwd repo (no explicit repo).
 * When the mutation explicitly targets an off-allowlist repo, emits a
 * security audit event plus a `[SECURITY]` log line and throws
 * {@link WriteRepoBlockedError} — before the caller spawns `gh`.
 *
 * Fail closed (Issue #3703): a mutation whose target repo is undeterminable
 * — a GraphQL mutation, an endpoint that names no repo, an unlisted root
 * verb — is refused with {@link WriteTargetUndeterminableError} rather than
 * allowed through unjournalled.
 *
 * @param args - Arguments about to be passed to the `gh` binary.
 * @throws WriteRepoBlockedError when the write targets an off-allowlist repo.
 * @throws WriteTargetUndeterminableError when the target is undeterminable.
 */
export async function enforceGhWriteAllowlist(
  args: readonly string[],
): Promise<void> {
  if (!ctx().active) return;
  const info = classifyGhMutation(args);
  // Not a mutation — reads are never the exfiltration sink.
  if (!info) return;

  if (info.scope === "unknown") {
    securityLogger(
      `[SECURITY] [WRITE_TARGET_UNDETERMINABLE] Refused ${info.verb}` +
        (info.target ? ` (${info.target})` : "") +
        " — target repo not derivable, failing closed",
    );
    await recordBlocked("unknown", info.verb, info.target);
    throw new WriteTargetUndeterminableError(info.verb, info.target);
  }

  // A cwd-repo write (no explicit repo) or a sanctioned non-repo mutation —
  // the exfil vector requires explicitly naming another repo, so allow.
  if (!info.repo) return;
  if (isWriteRepoAllowed(info.repo)) return;

  securityLogger(
    `[SECURITY] [WRITE_REPO_BLOCKED] Refused ${info.verb} to ${info.repo} ` +
      `— not on run allowlist [${listAllowedWriteRepos().join(", ")}]`,
  );
  await recordBlocked(info.repo, info.verb, info.target);
  throw new WriteRepoBlockedError(info.repo, info.verb);
}

/**
 * Override the audit/log sinks. Test-only — production uses the journal and
 * console.error defaults.
 */
export function _setWriteRepoAllowlistSinks(
  sinks: { record?: AuditRecorder; log?: SecurityLogger },
): void {
  if (sinks.record) auditRecorder = sinks.record;
  if (sinks.log) securityLogger = sinks.log;
}

/** Restore the production audit/log sinks. Test-only. */
export function _resetWriteRepoAllowlistSinks(): void {
  auditRecorder = recordMutation;
  securityLogger = (m) => console.error(m);
}
