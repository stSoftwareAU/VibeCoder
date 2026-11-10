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
 * Fail-open until seeded — but never silently (Issue #1425). The allowlist
 * is inert until a run seeds it with {@link seedWriteRepoAllowlist}, so the
 * main loop's legitimate cross-repo maintenance and unrelated flows are
 * unaffected until a run opts in. The production seed points are
 * `issue_worker.ts` (the claimed issue's own repo),
 * `idle_task_claim_handler.ts` (the scanned repo), and setup's repo-side
 * steps (`setup/setup_cli.ts`, every configured repo — Issue #2684), each in
 * a context of its own. The gap that rule leaves
 * is that a code path which *forgot* to seed — a new command, a
 * mis-ordered initialisation, a promise settling outside the seeded
 * `AsyncLocalStorage` scope — used to be indistinguishable from a protected
 * one. So a mutation classified while enforcement is inactive is still
 * allowed, but it is now marked: the first write of each kind (verb and
 * target repo) in a context emits a `[SECURITY] [WRITE_REPO_UNSEEDED]` line
 * and an `unseeded-<verb>` audit event, and every one is counted
 * ({@link unseededWriteCounts}). Once per kind, not once per write, because
 * a line that fires on every maintenance write is a line nobody reads.
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
 */ import { AsyncLocalStorage } from "node:async_hooks";
import { recordMutation, resolveRunId } from "./audit_journal.ts";
import { classifyGhMutation } from "./audit_mutation_classifier.ts";
/**
 * Error thrown when a GitHub write targets a repo not on the run's
 * allowlist. The message deliberately avoids retry-trigger keywords
 * (e.g. "rate limit", "timeout") so `retryWithBackoff` treats it as a hard,
 * non-transient failure and does not loop.
 */ export class WriteRepoBlockedError extends Error {
  /** The off-allowlist `owner/repo` that was refused. */ repo;
  /** The classified mutation verb (e.g. "issue-comment"), when known. */ verb;
  constructor(repo, verb){
    super(`Refused GitHub write to off-allowlist repo: ${repo}` + (verb ? ` (${verb})` : ""));
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
 */ export class WriteTargetUndeterminableError extends Error {
  /** The classified mutation verb (e.g. "api-graphql-mutation"). */ verb;
  /** The mutation target (endpoint / GraphQL fields), when known. */ target;
  constructor(verb, target){
    super(`Refused GitHub write with an undeterminable target repo (${verb})` + (target ? ` — target: ${target}` : ""));
    this.name = "WriteTargetUndeterminableError";
    this.verb = verb;
    if (target !== undefined) this.target = target;
  }
}
/** A fresh, inactive context. */ export function createWriteRepoAllowlistContext() {
  return {
    active: false,
    allowed: new Set(),
    pinned: new Map(),
    tokenScoped: new Map(),
    slugCasing: new Map(),
    unseededWrites: new Map(),
    agentSnapshotTaken: false
  };
}
/** The process-wide default context — single-slot behaviour, unchanged. */ const defaultContext = createWriteRepoAllowlistContext();
/** Ambient per-slot context (Issue #4175). */ const contextStorage = new AsyncLocalStorage();
/** The context the current async scope is running in. */ function ctx() {
  return contextStorage.getStore() ?? defaultContext;
}
/**
 * Run `fn` with its own allowlist context (Issue #4175). Everything the
 * exported functions do inside `fn` — seeding, registering, pinning,
 * enforcing, snapshotting — is scoped to `context`; a concurrent slot in
 * another context is unaffected. Nested `await`s stay in scope; the
 * context is not visible outside `fn`.
 */ export function withWriteRepoAllowlistContext(context, fn) {
  return contextStorage.run(context, fn);
}
/** The context the current scope resolves to. Test/diagnostic seam. */ export function currentWriteRepoAllowlistContext() {
  return ctx();
}
/** Injected audit sink (defaults to the production journal path). */ let auditRecorder = recordMutation;
/** Injected security-log sink (defaults to console.error). */ let securityLogger = (m)=>console.error(m);
/** Normalise a repo slug for case-insensitive comparison. */ function normalise(repo) {
  return repo.trim().toLowerCase();
}
/**
 * Normalise `repo` and remember the casing it arrived in (Issue #1391), so the
 * repository names sent to GitHub read as the operator wrote them.
 */ function normaliseKeepingCase(repo) {
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
 */ export function resetWriteRepoAllowlist() {
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
 */ export function noteAgentAllowlistSnapshot() {
  ctx().agentSnapshotTaken = true;
}
/**
 * Seed the allowlist for a new run and activate enforcement.
 *
 * Clears the previous run's seeded/registered repos, then adds
 * `targetRepo` and any `moreRepos`. Pins ({@link pinWriteRepo}) survive the
 * clear — they are owned by long-lived writers, not by any single run. From
 * this point every off-allowlist GitHub write is refused until
 * {@link resetWriteRepoAllowlist}.
 *
 * A worker run seeds its one target repo. Setup seeds every configured repo
 * (Issue #2684): it writes to each of them by design, and only to them.
 *
 * @param targetRepo - The run's own target repo, `owner/repo`.
 * @param moreRepos - Further repos the same run writes to by design.
 */ export function seedWriteRepoAllowlist(targetRepo, ...moreRepos) {
  const c = ctx();
  c.allowed.clear();
  c.active = true;
  c.agentSnapshotTaken = false;
  for (const repo of [
    targetRepo,
    ...moreRepos
  ])registerWriteRepo(repo);
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
 */ export function registerWriteRepo(repo) {
  const n = normaliseKeepingCase(repo);
  if (n.length === 0) return;
  const c = ctx();
  if (c.agentSnapshotTaken && !c.allowed.has(n)) {
    securityLogger(`[SECURITY] [WRITE_REPO_GRANT_AFTER_SPAWN] Granted ${n} after the agent ` + "gh guard shim baked this run's allowlist — the grant applies to the " + "worker process only; the running agent subprocess cannot write to it.");
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
 */ export async function withScopedWriteRepo(repo, fn) {
  const n = normaliseKeepingCase(repo);
  const c = ctx();
  // Nothing to grant: no slug, enforcement inactive, or already writable.
  if (n.length === 0 || !c.active || c.allowed.has(n) || c.pinned.has(n)) {
    return await fn();
  }
  securityLogger(`[SECURITY] [WRITE_REPO_SCOPED_GRANT] Granted ${repo.trim()} for the duration of one ` + "validated cross-repo call — worker process only; the running agent " + "subprocess cannot write to it.");
  c.allowed.add(n);
  try {
    return await fn();
  } finally{
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
 */ export async function withTokenScopedRepo(repo, fn) {
  const n = normaliseKeepingCase(repo);
  const c = ctx();
  if (n.length === 0 || !c.active) return await fn();
  securityLogger(`[SECURITY] [TOKEN_SCOPE_GRANT] Installation token scoped to include ${repo.trim()} ` + "for the duration of one validated cross-repo call — read reach only; " + "writes to it are still refused by the write-repo allowlist.");
  c.tokenScoped.set(n, (c.tokenScoped.get(n) ?? 0) + 1);
  try {
    return await fn();
  } finally{
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
 */ export function installationTokenRepoScope() {
  const c = ctx();
  if (!c.active) return null;
  const keys = new Set([
    ...c.allowed,
    ...c.pinned.keys(),
    ...c.tokenScoped.keys()
  ]);
  return [
    ...keys
  ].map((n)=>c.slugCasing.get(n) ?? n).sort();
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
 */ export function pinWriteRepo(repo) {
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
 */ export function unpinWriteRepo(repo) {
  const n = normalise(repo);
  const { pinned } = ctx();
  const count = pinned.get(n);
  if (count === undefined) return;
  if (count <= 1) pinned.delete(n);
  else pinned.set(n, count - 1);
}
/** Clear all pins. Test-only — production pins are released by their owner. */ export function _resetWriteRepoPins() {
  ctx().pinned.clear();
}
/** Whether enforcement is active (i.e. a run has seeded the allowlist). */ export function isWriteRepoAllowlistActive() {
  return ctx().active;
}
/** The current allowlist as a sorted array of `owner/repo` slugs. */ export function listAllowedWriteRepos() {
  return [
    ...ctx().allowed
  ].sort();
}
/**
 * Whether a write to `repo` is permitted for the current run.
 *
 * Always `true` while enforcement is inactive (fail-open until seeded).
 *
 * @param repo - `owner/repo` to check.
 */ export function isWriteRepoAllowed(repo) {
  const c = ctx();
  if (!c.active) return true;
  const n = normalise(repo);
  // Pinned repos (Issue #3760) are writable regardless of the current
  // run's seeded set — an active heartbeat must be able to refresh its
  // marker even after the next claim reseeds.
  return c.allowed.has(n) || c.pinned.has(n);
}
/** The target a classified mutation is written to, for the unseeded record. */ function unseededTarget(info) {
  if (info.repo) return info.repo;
  return info.scope === "unknown" ? "<undeterminable>" : "<cwd repo>";
}
/**
 * Mark a mutation that ran with the allowlist inactive (Issue #1425).
 *
 * The write is still allowed — this is the fail-open rule, unchanged — but
 * it no longer passes unseen. The first mutation of each kind (verb and
 * target) in this context emits a `[SECURITY] [WRITE_REPO_UNSEEDED]` line
 * and an `unseeded-<verb>` audit event; every one is counted.
 */ async function noteUnseededWrite(c, info) {
  const where = unseededTarget(info);
  const key = `${info.verb} → ${where}`;
  const seen = (c.unseededWrites.get(key) ?? 0) + 1;
  c.unseededWrites.set(key, seen);
  if (seen > 1) return;
  securityLogger(`[SECURITY] [WRITE_REPO_UNSEEDED] ${info.verb} to ${where}` + (info.target ? ` (${info.target})` : "") + " ran with the write-repo allowlist inactive — no run has seeded it, " + "so this write is unscoped. Allowed (fail-open until seeded); first of " + "its kind in this context, later ones are counted (Issue #1425).");
  try {
    await auditRecorder({
      runId: resolveRunId(),
      verb: `unseeded-${info.verb}`,
      outcome: "success",
      ...info.repo ? {
        repo: info.repo
      } : {},
      ...info.target ? {
        target: info.target
      } : {},
      caller: "worker/deno/lib/write_repo_allowlist.ts"
    });
  } catch  {
  // Best-effort: the signal must never fail the write it describes.
  }
}
/**
 * Mutations that ran while enforcement was inactive in the current context
 * (Issue #1425): `verb → repo` kinds with a count each, sorted by kind.
 */ export function unseededWriteCounts() {
  const out = {};
  for (const key of [
    ...ctx().unseededWrites.keys()
  ].sort()){
    out[key] = ctx().unseededWrites.get(key) ?? 0;
  }
  return out;
}
/** Total mutations that ran while enforcement was inactive (Issue #1425). */ export function countUnseededWrites() {
  let total = 0;
  for (const n of ctx().unseededWrites.values())total += n;
  return total;
}
/** Forget the unseeded-write record. Test-only. */ export function _resetUnseededWrites() {
  ctx().unseededWrites.clear();
}
/** Record a blocked write as a security audit event (best-effort). */ async function recordBlocked(repo, verb, target) {
  try {
    await auditRecorder({
      runId: resolveRunId(),
      verb: `blocked-${verb}`,
      outcome: "error",
      repo,
      ...target ? {
        target
      } : {},
      caller: "worker/deno/lib/write_repo_allowlist.ts"
    });
  } catch  {
  // Best-effort: never let audit journalling mask the block itself.
  }
}
/**
 * Enforce the allowlist for a single `gh` invocation.
 *
 * A no-op when the command is not a GitHub mutation, or when the mutation
 * targets the cwd repo (no explicit repo). While enforcement is inactive a
 * mutation is allowed through unchanged, but marked — see
 * {@link unseededWriteCounts} (Issue #1425).
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
 */ export async function enforceGhWriteAllowlist(args) {
  const c = ctx();
  const info = classifyGhMutation(args);
  // Not a mutation — reads are never the exfiltration sink.
  if (!info) return;
  // Fail-open until seeded (see the module doc) — but seen (Issue #1425).
  if (!c.active) {
    await noteUnseededWrite(c, info);
    return;
  }
  if (info.scope === "unknown") {
    securityLogger(`[SECURITY] [WRITE_TARGET_UNDETERMINABLE] Refused ${info.verb}` + (info.target ? ` (${info.target})` : "") + " — target repo not derivable, failing closed");
    await recordBlocked("unknown", info.verb, info.target);
    throw new WriteTargetUndeterminableError(info.verb, info.target);
  }
  // A cwd-repo write (no explicit repo) or a sanctioned non-repo mutation —
  // the exfil vector requires explicitly naming another repo, so allow.
  if (!info.repo) return;
  if (isWriteRepoAllowed(info.repo)) return;
  securityLogger(`[SECURITY] [WRITE_REPO_BLOCKED] Refused ${info.verb} to ${info.repo} ` + `— not on run allowlist [${listAllowedWriteRepos().join(", ")}]`);
  await recordBlocked(info.repo, info.verb, info.target);
  throw new WriteRepoBlockedError(info.repo, info.verb);
}
/**
 * Override the audit/log sinks. Test-only — production uses the journal and
 * console.error defaults.
 */ export function _setWriteRepoAllowlistSinks(sinks) {
  if (sinks.record) auditRecorder = sinks.record;
  if (sinks.log) securityLogger = sinks.log;
}
/** Restore the production audit/log sinks. Test-only. */ export function _resetWriteRepoAllowlistSinks() {
  auditRecorder = recordMutation;
  securityLogger = (m)=>console.error(m);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi93cml0ZV9yZXBvX2FsbG93bGlzdC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFBlci1ydW4gd3JpdGUtcmVwbyBhbGxvd2xpc3Qg4oCUIGVncmVzcyBjb250YWlubWVudCAoSXNzdWUgIzMzMTEpLlxuICpcbiAqIFdvcmtzdHJlYW0gMSBvZiAjMzMwOSAoaGFyZGVuIHRoZSBWaWJlIENvZGVyIGFnYWluc3QgR2l0TG9zdC1zdHlsZVxuICogcHJvbXB0LWluamVjdGlvbiBkYXRhIGxlYWtzKS4gQSBzdWNjZXNzZnVsIHByb21wdCBpbmplY3Rpb24gY2FuIHJlYWQgb25lXG4gKiByZXBvIGFuZCBwb3N0IGl0cyBjb250ZW50cyBhcyBhIHB1YmxpYyBjb21tZW50IGluIGFub3RoZXI7IHRoZXJlIGlzIG5vXG4gKiBydW50aW1lIGVncmVzcyByZXN0cmljdGlvbiBvbiB0aGUgYWdlbnQuIFRoaXMgbW9kdWxlIGFkZHMgb25lOiBldmVyeVxuICogR2l0SHViICp3cml0ZSogdGhlIHdvcmtlciBwZXJmb3JtcyBpcyB2YWxpZGF0ZWQgYWdhaW5zdCB0aGUgY3VycmVudCBydW4nc1xuICogYWxsb3dsaXN0IG9mIHRhcmdldCByZXBvcyAqKmJlZm9yZSBpdCByZWFjaGVzIEdpdEh1YioqLiBBIHdyaXRlIHRvIGFueVxuICogcmVwbyBub3Qgb24gdGhlIGFsbG93bGlzdCBpcyByZWZ1c2VkICh0aHJvd24pIGFuZCByZWNvcmRlZCBhcyBhIHNlY3VyaXR5XG4gKiBhdWRpdCBldmVudC5cbiAqXG4gKiBDaG9rZXBvaW50IOKAlCB3b3JrZXIgcHJvY2Vzcy4ge0BsaW5rIGVuZm9yY2VHaFdyaXRlQWxsb3dsaXN0fSBpcyBjYWxsZWRcbiAqIGZyb20gdGhlIHNpbmdsZSBsb3dlc3QtbGV2ZWwgYGdoYCBzcGF3biAoYHNwYXduR2hgIGluIGdoX3NwYXduLnRzKSDigJQgdGhlXG4gKiBzaGFyZWQgcGF0aCBldmVyeSBjb21tZW50IC8gbGFiZWwgLyBQUiAvIGBnaCBhcGlgIHdyaXRlIHRoZSAqd29ya2VyKlxuICogcGVyZm9ybXMgZmxvd3MgdGhyb3VnaCwgaW5jbHVkaW5nIGBydW5HaENvbW1hbmRSYXdgIGluIGdpdGh1Yi50cy4gVW50aWxcbiAqIElzc3VlICMzNzAzIHRoYXQgY29udHJhY3Qgd2FzIGFzcGlyYXRpb25hbDogfjIwIG1vZHVsZXMgc3Bhd25lZCBgZ2hgXG4gKiB0aGVtc2VsdmVzIGFuZCBza2lwcGVkIGJvdGggdGhpcyBhbGxvd2xpc3QgYW5kIHRoZSBhdWRpdCBqb3VybmFsLiBBXG4gKiBxdWFsaXR5LWdhdGUgY2hlY2sgKGBnaF9zcGF3bl9jaG9rZXBvaW50X2NoZWNrLnRzYCkgbm93IGZhaWxzIHRoZSBidWlsZCBvblxuICogYW55IGRpcmVjdCBgbmV3IERlbm8uQ29tbWFuZChcImdoXCIsIOKApilgIG91dHNpZGUgdGhlIGNob2tlcG9pbnQuXG4gKlxuICogVGhlIGNvbW1hbmQncyB0YXJnZXQgYG93bmVyL3JlcG9gIGlzIGRlcml2ZWQgYnkgdGhlIGV4aXN0aW5nIG11dGF0aW9uXG4gKiBjbGFzc2lmaWVyIChhdWRpdF9tdXRhdGlvbl9jbGFzc2lmaWVyLnRzKTsgYSB3cml0ZSB3aXRoIG5vIGV4cGxpY2l0XG4gKiBgLVJgL2VuZHBvaW50IHRhcmdldHMgdGhlIGN3ZCByZXBvICh0aGUgcnVuJ3Mgb3duIGNsb25lKSBhbmQgaXMgYWxsb3dlZCxcbiAqIHdoaWxlIGEgbXV0YXRpb24gd2hvc2UgdGFyZ2V0IGNhbm5vdCBiZSBkZXRlcm1pbmVkIGF0IGFsbCBmYWlscyBjbG9zZWRcbiAqIChJc3N1ZSAjMzcwMykuXG4gKlxuICogU2Vjb25kIGNob2tlcG9pbnQg4oCUIGFnZW50IHN1YnByb2Nlc3MgKElzc3VlICMzNjQzKS4gVGhlIGFnZW50IHJ1bnMgaW4gYVxuICogKmRpZmZlcmVudCogcHJvY2VzcyB3aXRoIHVucmVzdHJpY3RlZCBCYXNoIGFuZCBhbiBpbmhlcml0ZWQgYEdIX1RPS0VOYCwgc29cbiAqIGl0cyBvd24gYGdoYCBjYWxscyBuZXZlciB0cmF2ZXJzZSBgcnVuR2hDb21tYW5kUmF3YCBhbmQgdGhpcyBtb2R1bGUgYWxvbmVcbiAqIGRpZCBub3QgY29uc3RyYWluIHRoZW0uIGBnaF9ndWFyZF9zaGltLnRzYCBjbG9zZXMgdGhhdCBnYXAgYnkgcHV0dGluZyBhXG4gKiBgZ2hgIHdyYXBwZXIgZmlyc3Qgb24gdGhlIGNoaWxkJ3MgYFBBVEhgOyB0aGUgd3JhcHBlciByZS1lbnRlcnMgdGhlIHNhbWVcbiAqIGFsbG93bGlzdCBkZWNpc2lvbiAoYGdoX2d1YXJkX2RlY2lzaW9uLnRzYCkgYmVmb3JlIHRoZSByZWFsIGJpbmFyeSBydW5zLlxuICogVGhhdCB3cmFwcGVyIGlzIGEgY29udGFpbm1lbnQgYm91bmRhcnksIG5vdCBhIHNhbmRib3gg4oCUIGFuIGFnZW50IHRoYXRcbiAqIGNhbGxzIHRoZSByZWFsIGJpbmFyeSBieSBhYnNvbHV0ZSBwYXRoIHN0aWxsIGJ5cGFzc2VzIGl0LiBCZWhpbmQgaXQgc2l0cyB0aGVcbiAqIGNyZWRlbnRpYWwgbGF5ZXIgbm90ZWQgYmVsb3cgKElzc3VlICMxMzkxKTogdGhlIHRva2VuIGl0c2VsZiBvbmx5IHJlYWNoZXNcbiAqIHRoZSByZXBvcyB0aGUgcnVuIG1heSB3cml0ZSB0bywgc28gYSBieXBhc3Mgb2YgdGhlIHdyYXBwZXIgaXMgbm90IGEgYnlwYXNzXG4gKiBvZiB0aGUgYm91bmRhcnkuXG4gKlxuICogRmFpbC1vcGVuIHVudGlsIHNlZWRlZCDigJQgYnV0IG5ldmVyIHNpbGVudGx5IChJc3N1ZSAjMTQyNSkuIFRoZSBhbGxvd2xpc3RcbiAqIGlzIGluZXJ0IHVudGlsIGEgcnVuIHNlZWRzIGl0IHdpdGgge0BsaW5rIHNlZWRXcml0ZVJlcG9BbGxvd2xpc3R9LCBzbyB0aGVcbiAqIG1haW4gbG9vcCdzIGxlZ2l0aW1hdGUgY3Jvc3MtcmVwbyBtYWludGVuYW5jZSBhbmQgdW5yZWxhdGVkIGZsb3dzIGFyZVxuICogdW5hZmZlY3RlZCB1bnRpbCBhIHJ1biBvcHRzIGluLiBUaGUgcHJvZHVjdGlvbiBzZWVkIHBvaW50cyBhcmVcbiAqIGBpc3N1ZV93b3JrZXIudHNgICh0aGUgY2xhaW1lZCBpc3N1ZSdzIG93biByZXBvKSxcbiAqIGBpZGxlX3Rhc2tfY2xhaW1faGFuZGxlci50c2AgKHRoZSBzY2FubmVkIHJlcG8pLCBhbmQgc2V0dXAncyByZXBvLXNpZGVcbiAqIHN0ZXBzIChgc2V0dXAvc2V0dXBfY2xpLnRzYCwgZXZlcnkgY29uZmlndXJlZCByZXBvIOKAlCBJc3N1ZSAjMjY4NCksIGVhY2ggaW5cbiAqIGEgY29udGV4dCBvZiBpdHMgb3duLiBUaGUgZ2FwIHRoYXQgcnVsZSBsZWF2ZXNcbiAqIGlzIHRoYXQgYSBjb2RlIHBhdGggd2hpY2ggKmZvcmdvdCogdG8gc2VlZCDigJQgYSBuZXcgY29tbWFuZCwgYVxuICogbWlzLW9yZGVyZWQgaW5pdGlhbGlzYXRpb24sIGEgcHJvbWlzZSBzZXR0bGluZyBvdXRzaWRlIHRoZSBzZWVkZWRcbiAqIGBBc3luY0xvY2FsU3RvcmFnZWAgc2NvcGUg4oCUIHVzZWQgdG8gYmUgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIHByb3RlY3RlZFxuICogb25lLiBTbyBhIG11dGF0aW9uIGNsYXNzaWZpZWQgd2hpbGUgZW5mb3JjZW1lbnQgaXMgaW5hY3RpdmUgaXMgc3RpbGxcbiAqIGFsbG93ZWQsIGJ1dCBpdCBpcyBub3cgbWFya2VkOiB0aGUgZmlyc3Qgd3JpdGUgb2YgZWFjaCBraW5kICh2ZXJiIGFuZFxuICogdGFyZ2V0IHJlcG8pIGluIGEgY29udGV4dCBlbWl0cyBhIGBbU0VDVVJJVFldIFtXUklURV9SRVBPX1VOU0VFREVEXWAgbGluZVxuICogYW5kIGFuIGB1bnNlZWRlZC08dmVyYj5gIGF1ZGl0IGV2ZW50LCBhbmQgZXZlcnkgb25lIGlzIGNvdW50ZWRcbiAqICh7QGxpbmsgdW5zZWVkZWRXcml0ZUNvdW50c30pLiBPbmNlIHBlciBraW5kLCBub3Qgb25jZSBwZXIgd3JpdGUsIGJlY2F1c2VcbiAqIGEgbGluZSB0aGF0IGZpcmVzIG9uIGV2ZXJ5IG1haW50ZW5hbmNlIHdyaXRlIGlzIGEgbGluZSBub2JvZHkgcmVhZHMuXG4gKlxuICogRXh0ZW5zaW9uIHBvaW50cywgYW5kIHRoZWlyIGxpbWl0IChJc3N1ZSAjMzg2MSkuIEV4YWN0bHkgdGhyZWUgdGhpbmdzXG4gKiB3aWRlbiBhIHNlZWRlZCBhbGxvd2xpc3Q6XG4gKlxuICogICAxLiBBIGZ1bGwgcmVzZWVkICh7QGxpbmsgc2VlZFdyaXRlUmVwb0FsbG93bGlzdH0pIGZvciB0aGUgbmV4dCBjbGFpbS5cbiAqICAgMi4ge0BsaW5rIHJlZ2lzdGVyV3JpdGVSZXBvfSDigJQgYSAqKndvcmtlci1wcm9jZXNzKiogZ3JhbnQsIHVzZWQgYnkgdGhlXG4gKiAgICAgICMzODYwIHNlZWQtaWRsZS10YXNrcyBmbG93IChgY29tbWFuZHMvcHJvY2Vzc19zZWVkX2lkbGVfdGFza3MudHNgKSxcbiAqICAgICAgd2hpY2ggbmV2ZXIgc3Bhd25zIHRoZSBhZ2VudCBhbmQgcmVsZWFzZXMgdGhlIGdyYW50IGluIGEgYGZpbmFsbHlgLlxuICogICAzLiBSZWZjb3VudGVkIGhlYXJ0YmVhdCBwaW5zICh7QGxpbmsgcGluV3JpdGVSZXBvfSwgSXNzdWUgIzM3NjApLlxuICogICA0LiB7QGxpbmsgd2l0aFNjb3BlZFdyaXRlUmVwb30g4oCUIGEgKip3b3JrZXItcHJvY2VzcyoqIGdyYW50IHNjb3BlZCB0byBhXG4gKiAgICAgIHNpbmdsZSB2YWxpZGF0ZWQgY2FsbCBhbmQgcmVtb3ZlZCBpbiBhIGBmaW5hbGx5YCAoSXNzdWUgIzE4MikuIEl0cyBvbmVcbiAqICAgICAgcHJvZHVjdGlvbiBjYWxsZXIgaXMgdGhlIGNyb3NzLXJlcG8gZGVwZW5kZW5jeS1QUiBicmlkZ2VcbiAqICAgICAgKGBjcm9zc19yZXBvX3ByX2hhbmRvZmYudHNgKSwgd2hpY2ggZmlyc3QgdmFsaWRhdGVzIHRoZSB0YXJnZXQgYXMgYVxuICogICAgICByZWFjaGFibGUsIHB1c2hhYmxlIGBzdFNvZnR3YXJlQVUvKmAgcmVwbyB0aGF0IHRoZSBjb25zdW1pbmcgcmVwbydzXG4gKiAgICAgIG93biBtYW5pZmVzdCBkZWNsYXJlcyBhcyBhIGRlcGVuZGVuY3kgKElzc3VlICMxMzgyKSDigJQgc2hhcmluZyB0aGVcbiAqICAgICAgb3duZXIgaXMgbm90IG9uIGl0cyBvd24gYSByZWFzb24gdG8gd3JpdGUgdG8gYSBzaWJsaW5nIHRlbmFudC5cbiAqXG4gKiBOb25lIG9mIHRoZW0gcmVhY2hlcyBhbiBhZ2VudCBzdWJwcm9jZXNzIHRoYXQgaXMgYWxyZWFkeSBydW5uaW5nLlxuICogYGdoX2d1YXJkX3NoaW0udHNgIGJha2VzIGEgc25hcHNob3Qgb2YgdGhpcyBhbGxvd2xpc3QgaW50byB0aGUgY2hpbGQncyBgZ2hgXG4gKiB3cmFwcGVyIGF0IHNwYXduIHRpbWUsIGFuZCB0aGF0IHNuYXBzaG90IGlzIGRlbGliZXJhdGVseSBub3QgbGl2ZTogYW5cbiAqIGFsbG93bGlzdCBmaWxlIHJlLXJlYWQgcGVyIGludm9jYXRpb24gd291bGQgYmUgb25lIG1vcmUgbXV0YWJsZSBzdXJmYWNlXG4gKiBzaXR0aW5nIG5leHQgdG8gYW4gYWdlbnQgd2l0aCB1bnJlc3RyaWN0ZWQgQmFzaC4gTWlkLXJ1biBleHRlbnNpb24gb2YgdGhlXG4gKiAqYWdlbnQncyogYm91bmRhcnkgaXMgdW5zdXBwb3J0ZWQgYnkgZGVzaWduLCBzbyBhIGdyYW50IG1hZGUgYWZ0ZXIgdGhlXG4gKiBzbmFwc2hvdCBzYXlzIHNvIHdpdGggYSBgW1NFQ1VSSVRZXSBbV1JJVEVfUkVQT19HUkFOVF9BRlRFUl9TUEFXTl1gIGxpbmVcbiAqIHJhdGhlciB0aGFuIHNpbGVudGx5IGFwcGVhcmluZyB0byB3aWRlbiBpdC4gU2VlIFNFQ1VSSVRZLm1kIMKnNi5cbiAqXG4gKiBDcmVkZW50aWFsIGxheWVyIChJc3N1ZSAjMTM5MSkuICMzMzExIHdhcyBjb2RlLWxldmVsIGNvbnRhaW5tZW50IG9ubHksIGFuZFxuICogdGhlIGRlZmVycmVkIGhhbGYgd2FzIHRoZSBjcmVkZW50aWFsIGl0c2VsZjogYW4gdW5zY29wZWQgaW5zdGFsbGF0aW9uIHRva2VuXG4gKiBjYXJyaWVzIHRoZSBBcHAncyBwZXJtaXNzaW9ucyBvbiAqZXZlcnkqIHJlcG8gb2YgdGhlIGluc3RhbGxhdGlvbiwgc28gYW55XG4gKiB3cml0ZSB0aGF0IHNsaXBzIHBhc3QgdGhlIHR3byBjb2RlIGNob2tlcG9pbnRzIOKAlCBhIG5ldyBkaXJlY3Qgc3Bhd24sIGFcbiAqIGNsYXNzaWZpZXIgZ2FwLCB0aGUgYWdlbnQgY2FsbGluZyB0aGUgcmVhbCBgZ2hgIGJpbmFyeSBieSBhYnNvbHV0ZSBwYXRoIOKAlFxuICogc3RpbGwgc3VjY2VlZHMuIHtAbGluayBpbnN0YWxsYXRpb25Ub2tlblJlcG9TY29wZX0gY2xvc2VzIHRoYXQ6IHdoaWxlXG4gKiBlbmZvcmNlbWVudCBpcyBhY3RpdmUsIGBnaF9zcGF3bi50c2AgbWludHMgdGhlIGluc3RhbGxhdGlvbiB0b2tlbiBzY29wZWQgdG9cbiAqIGV4YWN0bHkgdGhlIHJlcG9zIHRoaXMgcnVuIG1heSB3cml0ZSB0bywgc28gR2l0SHViIHJlZnVzZXMgdGhlIHJlc3QuXG4gKiB7QGxpbmsgd2l0aFRva2VuU2NvcGVkUmVwb30gaXMgdGhlIG9uZSB3YXkgdG8gd2lkZW4gdGhlICpjcmVkZW50aWFsJ3MqIHJlYWNoXG4gKiB3aXRob3V0IHdpZGVuaW5nIHRoZSB3cml0ZSBhbGxvd2xpc3Qg4oCUIHRoZSBjcm9zcy1yZXBvIGRlcGVuZGVuY3ktUFIgYnJpZGdlXG4gKiBuZWVkcyB0byBSRUFEIGEgZGVwZW5kZW5jeSByZXBvIGJlZm9yZSB0aGUgYHdpdGhTY29wZWRXcml0ZVJlcG9gIGdyYW50IGxldHNcbiAqIGl0IHdyaXRlIG9uZSBQUi5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHR5cGUgeyBBdWRpdEVudHJ5LCBBdWRpdE11dGF0aW9uIH0gZnJvbSBcIi4vYXVkaXRfam91cm5hbC50c1wiO1xuaW1wb3J0IHsgQXN5bmNMb2NhbFN0b3JhZ2UgfSBmcm9tIFwibm9kZTphc3luY19ob29rc1wiO1xuaW1wb3J0IHsgcmVjb3JkTXV0YXRpb24sIHJlc29sdmVSdW5JZCB9IGZyb20gXCIuL2F1ZGl0X2pvdXJuYWwudHNcIjtcbmltcG9ydCB7XG4gIGNsYXNzaWZ5R2hNdXRhdGlvbixcbiAgdHlwZSBNdXRhdGlvbkluZm8sXG59IGZyb20gXCIuL2F1ZGl0X211dGF0aW9uX2NsYXNzaWZpZXIudHNcIjtcblxuLyoqIFNpbmsgZm9yIHJlY29yZGluZyBhIHNlY3VyaXR5IGF1ZGl0IGV2ZW50IChpbmplY3RhYmxlIGZvciB0ZXN0cykuICovXG5leHBvcnQgdHlwZSBBdWRpdFJlY29yZGVyID0gKFxuICBtdXRhdGlvbjogQXVkaXRNdXRhdGlvbixcbikgPT4gUHJvbWlzZTxSZXN1bHQ8QXVkaXRFbnRyeT4+O1xuXG4vKiogU2luayBmb3IgdGhlIHNlY3VyaXR5IGxvZyBsaW5lIChpbmplY3RhYmxlIGZvciB0ZXN0cykuICovXG5leHBvcnQgdHlwZSBTZWN1cml0eUxvZ2dlciA9IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG5cbi8qKlxuICogRXJyb3IgdGhyb3duIHdoZW4gYSBHaXRIdWIgd3JpdGUgdGFyZ2V0cyBhIHJlcG8gbm90IG9uIHRoZSBydW4nc1xuICogYWxsb3dsaXN0LiBUaGUgbWVzc2FnZSBkZWxpYmVyYXRlbHkgYXZvaWRzIHJldHJ5LXRyaWdnZXIga2V5d29yZHNcbiAqIChlLmcuIFwicmF0ZSBsaW1pdFwiLCBcInRpbWVvdXRcIikgc28gYHJldHJ5V2l0aEJhY2tvZmZgIHRyZWF0cyBpdCBhcyBhIGhhcmQsXG4gKiBub24tdHJhbnNpZW50IGZhaWx1cmUgYW5kIGRvZXMgbm90IGxvb3AuXG4gKi9cbmV4cG9ydCBjbGFzcyBXcml0ZVJlcG9CbG9ja2VkRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIC8qKiBUaGUgb2ZmLWFsbG93bGlzdCBgb3duZXIvcmVwb2AgdGhhdCB3YXMgcmVmdXNlZC4gKi9cbiAgcmVhZG9ubHkgcmVwbzogc3RyaW5nO1xuICAvKiogVGhlIGNsYXNzaWZpZWQgbXV0YXRpb24gdmVyYiAoZS5nLiBcImlzc3VlLWNvbW1lbnRcIiksIHdoZW4ga25vd24uICovXG4gIHJlYWRvbmx5IHZlcmI/OiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3IocmVwbzogc3RyaW5nLCB2ZXJiPzogc3RyaW5nKSB7XG4gICAgc3VwZXIoXG4gICAgICBgUmVmdXNlZCBHaXRIdWIgd3JpdGUgdG8gb2ZmLWFsbG93bGlzdCByZXBvOiAke3JlcG99YCArXG4gICAgICAgICh2ZXJiID8gYCAoJHt2ZXJifSlgIDogXCJcIiksXG4gICAgKTtcbiAgICB0aGlzLm5hbWUgPSBcIldyaXRlUmVwb0Jsb2NrZWRFcnJvclwiO1xuICAgIHRoaXMucmVwbyA9IHJlcG87XG4gICAgdGhpcy52ZXJiID0gdmVyYjtcbiAgfVxufVxuXG4vKipcbiAqIEVycm9yIHRocm93biB3aGVuIGEgR2l0SHViIHdyaXRlJ3MgdGFyZ2V0IHJlcG8gY2Fubm90IGJlIGRldGVybWluZWRcbiAqIChJc3N1ZSAjMzcwMykuXG4gKlxuICogVGhlIGFsbG93bGlzdCB1c2VkIHRvIHJldHVybiBlYXJseSB3aGVuZXZlciB0aGUgY2xhc3NpZmllciBkZXJpdmVkIG5vXG4gKiByZXBvLCBzbyBhIEdyYXBoUUwgbXV0YXRpb24sIGFuIGFic29sdXRlIGBodHRwczovL2FwaS5naXRodWIuY29tL+KApmBcbiAqIGVuZHBvaW50LCBvciBhbiB1bmxpc3RlZCByb290IHZlcmIgcGFzc2VkIHVuY2hlY2tlZC4gVGhvc2Ugbm93IGZhaWxcbiAqIGNsb3NlZC4gTGlrZSB7QGxpbmsgV3JpdGVSZXBvQmxvY2tlZEVycm9yfSB0aGUgbWVzc2FnZSBhdm9pZHNcbiAqIHJldHJ5LXRyaWdnZXIga2V5d29yZHMgc28gYHJldHJ5V2l0aEJhY2tvZmZgIHRyZWF0cyBpdCBhcyB0ZXJtaW5hbC5cbiAqL1xuZXhwb3J0IGNsYXNzIFdyaXRlVGFyZ2V0VW5kZXRlcm1pbmFibGVFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgLyoqIFRoZSBjbGFzc2lmaWVkIG11dGF0aW9uIHZlcmIgKGUuZy4gXCJhcGktZ3JhcGhxbC1tdXRhdGlvblwiKS4gKi9cbiAgcmVhZG9ubHkgdmVyYjogc3RyaW5nO1xuICAvKiogVGhlIG11dGF0aW9uIHRhcmdldCAoZW5kcG9pbnQgLyBHcmFwaFFMIGZpZWxkcyksIHdoZW4ga25vd24uICovXG4gIHJlYWRvbmx5IHRhcmdldD86IHN0cmluZztcblxuICBjb25zdHJ1Y3Rvcih2ZXJiOiBzdHJpbmcsIHRhcmdldD86IHN0cmluZykge1xuICAgIHN1cGVyKFxuICAgICAgYFJlZnVzZWQgR2l0SHViIHdyaXRlIHdpdGggYW4gdW5kZXRlcm1pbmFibGUgdGFyZ2V0IHJlcG8gKCR7dmVyYn0pYCArXG4gICAgICAgICh0YXJnZXQgPyBgIOKAlCB0YXJnZXQ6ICR7dGFyZ2V0fWAgOiBcIlwiKSxcbiAgICApO1xuICAgIHRoaXMubmFtZSA9IFwiV3JpdGVUYXJnZXRVbmRldGVybWluYWJsZUVycm9yXCI7XG4gICAgdGhpcy52ZXJiID0gdmVyYjtcbiAgICBpZiAodGFyZ2V0ICE9PSB1bmRlZmluZWQpIHRoaXMudGFyZ2V0ID0gdGFyZ2V0O1xuICB9XG59XG5cbi8qKlxuICogVGhlIHBlci1zbG90IGFsbG93bGlzdCBzdGF0ZSAoSXNzdWUgIzQxNzUsIHBhcnQgb2YgIzQxNjgpLlxuICpcbiAqIFRoZXNlIGZvdXIgZmllbGRzIHVzZWQgdG8gYmUgbW9kdWxlLWxldmVsIHNpbmdsZXRvbnMg4oCUIG9uZSBwZXIgd29ya2VyXG4gKiBwcm9jZXNzLiBUd28gY29uY3VycmVudCBzbG90cyB3b3VsZCBoYXZlIHNoYXJlZCB0aGVtLCBzbyBzZWVkaW5nIGZvclxuICogc2xvdCBCIHdvdWxkIGVpdGhlciBjbG9iYmVyIHNsb3QgQSdzIGFsbG93bGlzdCBvciB3aWRlbiB0aGUgcHJvY2Vzc1xuICogYWxsb3dsaXN0IHRvIHRoZSBVTklPTiBvZiBib3RoIHJlcG9zIOKAlCBhbmQgYSBwcm9tcHQgaW5qZWN0aW9uIGluIHNsb3RcbiAqIEEncyByZXBvIGNvdWxkIHRoZW4gd3JpdGUgdG8gc2xvdCBCJ3MuIFRoZSBzdGF0ZSBub3cgbGl2ZXMgaW4gYSBjb250ZXh0XG4gKiBvYmplY3Q7IGEgc2xvdCBydW5zIGluc2lkZSB7QGxpbmsgd2l0aFdyaXRlUmVwb0FsbG93bGlzdENvbnRleHR9IGFuZFxuICogZXZlcnkgZXhwb3J0ZWQgZnVuY3Rpb24gYmVsb3cgcmVzb2x2ZXMgdGhlIGFtYmllbnQgY29udGV4dCB0aHJvdWdoXG4gKiBgQXN5bmNMb2NhbFN0b3JhZ2VgLCBzbyB0aGUgfjIwIGNhbGwgc2l0ZXMgYW5kIHRoZSBgc3Bhd25HaGAgY2hva2Vwb2ludFxuICoga2VlcCB0aGVpciBzaWduYXR1cmVzLiBPdXRzaWRlIGFueSBzbG90IHNjb3BlIHRoZSBwcm9jZXNzLXdpZGUgZGVmYXVsdFxuICogY29udGV4dCBpcyB1c2VkLCB3aGljaCBpcyBleGFjdGx5IHRvZGF5J3Mgc2luZ2xlLXNsb3QgYmVoYXZpb3VyLlxuICpcbiAqIFRoZSBwcm9kdWN0aW9uIHdyYXAgc2l0ZSBpcyB0aGUgc2xvdCBwb29sIChgcnVuX2NvcmUudHNgKSwgd2hpY2ggZ2l2ZXNcbiAqICoqZXZlcnkgY2xhaW0qKiBhIGZyZXNoIGNvbnRleHQgKElzc3VlICMxODMpLiBVbnRpbCBpdCBkaWQsIG5vdGhpbmcgY2FsbGVkXG4gKiB0aGUgd3JhcHBlcjogYm90aCBzbG90cyByZXNvbHZlZCB0byBgZGVmYXVsdENvbnRleHRgLCB0aGUgc2Vjb25kIGNsYWltJ3NcbiAqIHNlZWQgY2xvYmJlcmVkIHRoZSBmaXJzdCdzIGFsbG93bGlzdCwgYW5kIHRoZSBsb3Npbmcgc2xvdCdzIGFnZW50IHNoaW0gd2FzXG4gKiBiYWtlZCB3aXRoIGl0cyBzaWJsaW5nJ3MgcmVwbyDigJQgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjb250ZXh0IG9iamVjdFxuICogZXhpc3RzIHRvIHByZXZlbnQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV3JpdGVSZXBvQWxsb3dsaXN0Q29udGV4dCB7XG4gIC8qKiBXaGV0aGVyIGVuZm9yY2VtZW50IGlzIGFjdGl2ZSBmb3IgdGhlIGN1cnJlbnQgcnVuLiAqL1xuICBhY3RpdmU6IGJvb2xlYW47XG4gIC8qKiBOb3JtYWxpc2VkIChgb3duZXIvcmVwb2AsIGxvd2VyLWNhc2UpIHJlcG9zIHRoZSBydW4gbWF5IHdyaXRlIHRvLiAqL1xuICByZWFkb25seSBhbGxvd2VkOiBTZXQ8c3RyaW5nPjtcbiAgLyoqXG4gICAqIE5vcm1hbGlzZWQgcmVwb3MgcGlubmVkIGJ5IGxvbmctbGl2ZWQgYmFja2dyb3VuZCB3cml0ZXJzLCB3aXRoIGFcbiAgICogcmVmY291bnQgcGVyIHJlcG8gKElzc3VlICMzNzYwKS5cbiAgICpcbiAgICogQSBoZWFydGJlYXQgaXMgYSBgc2V0SW50ZXJ2YWxgIHRoYXQga2VlcHMgUEFUQ0hpbmcgYSBtYXJrZXIgY29tbWVudCBvblxuICAgKiAqaXRzKiBjbGFpbSdzIHJlcG8gZm9yIGFzIGxvbmcgYXMgaXQgcnVucy4ge0BsaW5rIHNlZWRXcml0ZVJlcG9BbGxvd2xpc3R9XG4gICAqIGNsZWFycyBgYWxsb3dlZGAgb24gZXZlcnkgbmV3IGNsYWltLCBzbyBhIGhlYXJ0YmVhdCBzcGFubmluZyBhIGNsYWltXG4gICAqIGJvdW5kYXJ5IHVzZWQgdG8gaGF2ZSBldmVyeSBtYXJrZXIgcmVmcmVzaCByZWZ1c2VkIOKAlCBzaWJsaW5nIGhvc3RzJ1xuICAgKiBzdHVjay1kZXRlY3Rpb24gdGhlbiBzYXcgdGhlIGNsYWltIGFzIGRlYWQgYW5kIGNvdWxkIHN0ZWFsIHRoZSBpc3N1ZS5cbiAgICogUGlucyBsaXZlIG91dHNpZGUgdGhlIHBlci1ydW4gc2V0OiBuZWl0aGVyIHNlZWRpbmcgbm9yXG4gICAqIHtAbGluayByZXNldFdyaXRlUmVwb0FsbG93bGlzdH0gY2xlYXJzIHRoZW07IG9ubHkgdGhlIHdyaXRlciB0aGF0IHBpbm5lZFxuICAgKiByZWxlYXNlcyB0aGVtICh7QGxpbmsgdW5waW5Xcml0ZVJlcG99LCBjYWxsZWQgZnJvbSBgc3RvcEhlYXJ0YmVhdGApLlxuICAgKlxuICAgKiBUaGlzIGRvZXMgbm90IHJlb3BlbiB0aGUgIzMzMTEgZXhmaWx0cmF0aW9uIHZlY3RvcjogdGhlIHBpbm5lZCByZXBvIGlzXG4gICAqIHRoZSBjbGFpbWVkIGlzc3VlJ3MgcmVwbyDigJQgYSB3b3JrZXItY29udHJvbGxlZCB2YWx1ZSB0aGUgYWdlbnQgY2Fubm90XG4gICAqIGluZmx1ZW5jZSDigJQgYW5kIHRoZSByZWZjb3VudCBtZWFucyBhIHJlcG8gaXMgb25seSB3cml0YWJsZSB3aGlsZSBhdFxuICAgKiBsZWFzdCBvbmUgbGl2ZSBoZWFydGJlYXQgc3RpbGwgdGFyZ2V0cyBpdC5cbiAgICovXG4gIHJlYWRvbmx5IHBpbm5lZDogTWFwPHN0cmluZywgbnVtYmVyPjtcbiAgLyoqXG4gICAqIFJlcG9zIHRoZSBtaW50ZWQgaW5zdGFsbGF0aW9uIHRva2VuIG1heSAqKnJlYWNoKiosIGJleW9uZCB0aGUgcmVwb3MgdGhpc1xuICAgKiBydW4gbWF5IHdyaXRlIHRvIChJc3N1ZSAjMTM5MSksIHdpdGggYSByZWZjb3VudCBwZXIgcmVwby5cbiAgICpcbiAgICogQSBHaXRIdWIgQXBwIHRva2VuIGlzIHNjb3BlZCBwZXIgcmVwb3NpdG9yeSwgbm90IHBlciB2ZXJiLCBzbyBhIHJlcG8gdGhlXG4gICAqIHdvcmtlciBvbmx5IG5lZWRzIHRvIFJFQUQgbXVzdCBzdGlsbCBiZSBuYW1lZCBpbiB0aGUgdG9rZW4ncyBzY29wZS4gVGhpc1xuICAgKiBzZXQgZXhpc3RzIHNvIG5hbWluZyBpdCB0aGVyZSBkb2VzIG5vdCBhbHNvIHB1dCBpdCBvbiB0aGUgd3JpdGVcbiAgICogYWxsb3dsaXN0OiB0aGUgY3JlZGVudGlhbCByZWFjaGVzIGl0LCB0aGUgYHNwYXduR2hgIGNob2tlcG9pbnQgc3RpbGxcbiAgICogcmVmdXNlcyBldmVyeSB3cml0ZSB0byBpdC4gR3JhbnRlZCBvbmx5IGJ5IHtAbGluayB3aXRoVG9rZW5TY29wZWRSZXBvfSBhbmRcbiAgICogcmVsZWFzZWQgd2hlbiB0aGF0IGNhbGwgc2V0dGxlcy5cbiAgICovXG4gIHJlYWRvbmx5IHRva2VuU2NvcGVkOiBNYXA8c3RyaW5nLCBudW1iZXI+O1xuICAvKipcbiAgICogVGhlIGNhc2luZyBlYWNoIG5vcm1hbGlzZWQgc2x1ZyB3YXMgZmlyc3Qgc2VlbiBpbiAoSXNzdWUgIzEzOTEpLlxuICAgKlxuICAgKiBFdmVyeSBzZXQgYWJvdmUgaXMga2V5ZWQgYnkgdGhlIGxvd2VyLWNhc2VkIHNsdWcgc28gY29tcGFyaXNvbnMgYXJlXG4gICAqIGNhc2UtaW5zZW5zaXRpdmUsIGJ1dCB7QGxpbmsgaW5zdGFsbGF0aW9uVG9rZW5SZXBvU2NvcGV9IGZlZWRzIHJlcG9zaXRvcnlcbiAgICogbmFtZXMgdG8gR2l0SHViLCBhbmQgYSBuYW1lIGlzIHdvcnRoIHNlbmRpbmcgZXhhY3RseSBhcyB0aGUgb3BlcmF0b3Igd3JvdGVcbiAgICogaXQgcmF0aGVyIHRoYW4gYXMgdGhpcyBtb2R1bGUgaGFwcGVuZWQgdG8gZm9sZCBpdC5cbiAgICovXG4gIHJlYWRvbmx5IHNsdWdDYXNpbmc6IE1hcDxzdHJpbmcsIHN0cmluZz47XG4gIC8qKlxuICAgKiBNdXRhdGlvbnMgY2xhc3NpZmllZCB3aGlsZSBlbmZvcmNlbWVudCB3YXMgaW5hY3RpdmUgKElzc3VlICMxNDI1KSwgYnlcbiAgICoga2luZCAoYHZlcmIg4oaSIHJlcG9gKSwgd2l0aCBhIGNvdW50IHBlciBraW5kLiBUaGUgZmlyc3Qgb2YgZWFjaCBraW5kIGlzXG4gICAqIGxvZ2dlZCBhbmQgam91cm5hbGxlZDsgdGhlIHJlc3QgYXJlIG9ubHkgY291bnRlZCBoZXJlLiBBIHJlY29yZCBvZiB0aGVcbiAgICogY29udGV4dCdzIGxpZmV0aW1lIOKAlCBuZWl0aGVyIGEgcmVzZWVkIG5vciBhIHJlc2V0IGNsZWFycyBpdCwgYmVjYXVzZVxuICAgKiB0aGUgd2hvbGUgcG9pbnQgaXMgdG8gc2VlIHdoYXQgcmFuIHVuc2NvcGVkIGJldHdlZW4gcnVucy5cbiAgICovXG4gIHJlYWRvbmx5IHVuc2VlZGVkV3JpdGVzOiBNYXA8c3RyaW5nLCBudW1iZXI+O1xuICAvKipcbiAgICogV2hldGhlciBhbiBhZ2VudCBzdWJwcm9jZXNzIGhhcyBhbHJlYWR5IGJha2VkIGEgc25hcHNob3Qgb2YgdGhpcyBydW4nc1xuICAgKiBhbGxvd2xpc3QgaW50byBpdHMgYGdoYCBndWFyZCBzaGltIChJc3N1ZSAjMzg2MSkuXG4gICAqXG4gICAqIFNldCBieSB7QGxpbmsgbm90ZUFnZW50QWxsb3dsaXN0U25hcHNob3R9LCBjYWxsZWQgZnJvbVxuICAgKiBgcHJlcGFyZUdoR3VhcmRTaGltYC4gQ2xlYXJlZCBieSBhIHJlc2VlZCBvciBhIHJlc2V0LCBiZWNhdXNlIGJvdGggc3RhcnRcbiAgICogYSBmcmVzaCBydW4gd2hvc2UgYWdlbnQgaGFzIG5vdCBiZWVuIHNwYXduZWQgeWV0LlxuICAgKi9cbiAgYWdlbnRTbmFwc2hvdFRha2VuOiBib29sZWFuO1xufVxuXG4vKiogQSBmcmVzaCwgaW5hY3RpdmUgY29udGV4dC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVXcml0ZVJlcG9BbGxvd2xpc3RDb250ZXh0KCk6IFdyaXRlUmVwb0FsbG93bGlzdENvbnRleHQge1xuICByZXR1cm4ge1xuICAgIGFjdGl2ZTogZmFsc2UsXG4gICAgYWxsb3dlZDogbmV3IFNldDxzdHJpbmc+KCksXG4gICAgcGlubmVkOiBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpLFxuICAgIHRva2VuU2NvcGVkOiBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpLFxuICAgIHNsdWdDYXNpbmc6IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCksXG4gICAgdW5zZWVkZWRXcml0ZXM6IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCksXG4gICAgYWdlbnRTbmFwc2hvdFRha2VuOiBmYWxzZSxcbiAgfTtcbn1cblxuLyoqIFRoZSBwcm9jZXNzLXdpZGUgZGVmYXVsdCBjb250ZXh0IOKAlCBzaW5nbGUtc2xvdCBiZWhhdmlvdXIsIHVuY2hhbmdlZC4gKi9cbmNvbnN0IGRlZmF1bHRDb250ZXh0ID0gY3JlYXRlV3JpdGVSZXBvQWxsb3dsaXN0Q29udGV4dCgpO1xuXG4vKiogQW1iaWVudCBwZXItc2xvdCBjb250ZXh0IChJc3N1ZSAjNDE3NSkuICovXG5jb25zdCBjb250ZXh0U3RvcmFnZSA9IG5ldyBBc3luY0xvY2FsU3RvcmFnZTxXcml0ZVJlcG9BbGxvd2xpc3RDb250ZXh0PigpO1xuXG4vKiogVGhlIGNvbnRleHQgdGhlIGN1cnJlbnQgYXN5bmMgc2NvcGUgaXMgcnVubmluZyBpbi4gKi9cbmZ1bmN0aW9uIGN0eCgpOiBXcml0ZVJlcG9BbGxvd2xpc3RDb250ZXh0IHtcbiAgcmV0dXJuIGNvbnRleHRTdG9yYWdlLmdldFN0b3JlKCkgPz8gZGVmYXVsdENvbnRleHQ7XG59XG5cbi8qKlxuICogUnVuIGBmbmAgd2l0aCBpdHMgb3duIGFsbG93bGlzdCBjb250ZXh0IChJc3N1ZSAjNDE3NSkuIEV2ZXJ5dGhpbmcgdGhlXG4gKiBleHBvcnRlZCBmdW5jdGlvbnMgZG8gaW5zaWRlIGBmbmAg4oCUIHNlZWRpbmcsIHJlZ2lzdGVyaW5nLCBwaW5uaW5nLFxuICogZW5mb3JjaW5nLCBzbmFwc2hvdHRpbmcg4oCUIGlzIHNjb3BlZCB0byBgY29udGV4dGA7IGEgY29uY3VycmVudCBzbG90IGluXG4gKiBhbm90aGVyIGNvbnRleHQgaXMgdW5hZmZlY3RlZC4gTmVzdGVkIGBhd2FpdGBzIHN0YXkgaW4gc2NvcGU7IHRoZVxuICogY29udGV4dCBpcyBub3QgdmlzaWJsZSBvdXRzaWRlIGBmbmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3aXRoV3JpdGVSZXBvQWxsb3dsaXN0Q29udGV4dDxUPihcbiAgY29udGV4dDogV3JpdGVSZXBvQWxsb3dsaXN0Q29udGV4dCxcbiAgZm46ICgpID0+IFByb21pc2U8VD4sXG4pOiBQcm9taXNlPFQ+IHtcbiAgcmV0dXJuIGNvbnRleHRTdG9yYWdlLnJ1bihjb250ZXh0LCBmbik7XG59XG5cbi8qKiBUaGUgY29udGV4dCB0aGUgY3VycmVudCBzY29wZSByZXNvbHZlcyB0by4gVGVzdC9kaWFnbm9zdGljIHNlYW0uICovXG5leHBvcnQgZnVuY3Rpb24gY3VycmVudFdyaXRlUmVwb0FsbG93bGlzdENvbnRleHQoKTogV3JpdGVSZXBvQWxsb3dsaXN0Q29udGV4dCB7XG4gIHJldHVybiBjdHgoKTtcbn1cblxuLyoqIEluamVjdGVkIGF1ZGl0IHNpbmsgKGRlZmF1bHRzIHRvIHRoZSBwcm9kdWN0aW9uIGpvdXJuYWwgcGF0aCkuICovXG5sZXQgYXVkaXRSZWNvcmRlcjogQXVkaXRSZWNvcmRlciA9IHJlY29yZE11dGF0aW9uO1xuXG4vKiogSW5qZWN0ZWQgc2VjdXJpdHktbG9nIHNpbmsgKGRlZmF1bHRzIHRvIGNvbnNvbGUuZXJyb3IpLiAqL1xubGV0IHNlY3VyaXR5TG9nZ2VyOiBTZWN1cml0eUxvZ2dlciA9IChtKSA9PiBjb25zb2xlLmVycm9yKG0pO1xuXG4vKiogTm9ybWFsaXNlIGEgcmVwbyBzbHVnIGZvciBjYXNlLWluc2Vuc2l0aXZlIGNvbXBhcmlzb24uICovXG5mdW5jdGlvbiBub3JtYWxpc2UocmVwbzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlcG8udHJpbSgpLnRvTG93ZXJDYXNlKCk7XG59XG5cbi8qKlxuICogTm9ybWFsaXNlIGByZXBvYCBhbmQgcmVtZW1iZXIgdGhlIGNhc2luZyBpdCBhcnJpdmVkIGluIChJc3N1ZSAjMTM5MSksIHNvIHRoZVxuICogcmVwb3NpdG9yeSBuYW1lcyBzZW50IHRvIEdpdEh1YiByZWFkIGFzIHRoZSBvcGVyYXRvciB3cm90ZSB0aGVtLlxuICovXG5mdW5jdGlvbiBub3JtYWxpc2VLZWVwaW5nQ2FzZShyZXBvOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gcmVwby50cmltKCk7XG4gIGNvbnN0IG4gPSB0cmltbWVkLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChuLmxlbmd0aCA+IDAgJiYgIWN0eCgpLnNsdWdDYXNpbmcuaGFzKG4pKSB7XG4gICAgY3R4KCkuc2x1Z0Nhc2luZy5zZXQobiwgdHJpbW1lZCk7XG4gIH1cbiAgcmV0dXJuIG47XG59XG5cbi8qKlxuICogRGVhY3RpdmF0ZSBlbmZvcmNlbWVudCBhbmQgY2xlYXIgdGhlIGFsbG93bGlzdC5cbiAqXG4gKiBDYWxsZWQgYmV0d2VlbiBydW5zIChhbmQgZnJvbSB0ZXN0IGNsZWFudXApIHNvIG9uZSBydW4ncyBhbGxvd2xpc3QgbmV2ZXJcbiAqIGxlYWtzIGludG8gdGhlIG5leHQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldFdyaXRlUmVwb0FsbG93bGlzdCgpOiB2b2lkIHtcbiAgY29uc3QgYyA9IGN0eCgpO1xuICBjLmFjdGl2ZSA9IGZhbHNlO1xuICBjLmFsbG93ZWQuY2xlYXIoKTtcbiAgYy5hZ2VudFNuYXBzaG90VGFrZW4gPSBmYWxzZTtcbn1cblxuLyoqXG4gKiBSZWNvcmQgdGhhdCBhbiBhZ2VudCBzdWJwcm9jZXNzIGhhcyBiYWtlZCB0aGlzIHJ1bidzIGFsbG93bGlzdCBpbnRvIGl0c1xuICogYGdoYCBndWFyZCBzaGltIChJc3N1ZSAjMzg2MSkuXG4gKlxuICogQ2FsbGVkIGZyb20gYHByZXBhcmVHaEd1YXJkU2hpbWAg4oCUIHRoZSBvbmUgcGxhY2UgdGhhdCByZWFkcyB0aGUgbGl2ZVxuICogYWxsb3dsaXN0IGZvciBhIGNoaWxkIHNwYXduLiBGcm9tIGhlcmUgb24ge0BsaW5rIHJlZ2lzdGVyV3JpdGVSZXBvfSB3YXJuc1xuICogbG91ZGx5LCBiZWNhdXNlIGEgZ3JhbnQgYWRkZWQgbm93IHdpZGVucyB0aGUgKndvcmtlcidzKiBib3VuZGFyeSBvbmx5OiB0aGVcbiAqIHJ1bm5pbmcgYWdlbnQga2VlcHMgdGhlIHNuYXBzaG90IGl0IHdhcyBzcGF3bmVkIHdpdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3RlQWdlbnRBbGxvd2xpc3RTbmFwc2hvdCgpOiB2b2lkIHtcbiAgY3R4KCkuYWdlbnRTbmFwc2hvdFRha2VuID0gdHJ1ZTtcbn1cblxuLyoqXG4gKiBTZWVkIHRoZSBhbGxvd2xpc3QgZm9yIGEgbmV3IHJ1biBhbmQgYWN0aXZhdGUgZW5mb3JjZW1lbnQuXG4gKlxuICogQ2xlYXJzIHRoZSBwcmV2aW91cyBydW4ncyBzZWVkZWQvcmVnaXN0ZXJlZCByZXBvcywgdGhlbiBhZGRzXG4gKiBgdGFyZ2V0UmVwb2AgYW5kIGFueSBgbW9yZVJlcG9zYC4gUGlucyAoe0BsaW5rIHBpbldyaXRlUmVwb30pIHN1cnZpdmUgdGhlXG4gKiBjbGVhciDigJQgdGhleSBhcmUgb3duZWQgYnkgbG9uZy1saXZlZCB3cml0ZXJzLCBub3QgYnkgYW55IHNpbmdsZSBydW4uIEZyb21cbiAqIHRoaXMgcG9pbnQgZXZlcnkgb2ZmLWFsbG93bGlzdCBHaXRIdWIgd3JpdGUgaXMgcmVmdXNlZCB1bnRpbFxuICoge0BsaW5rIHJlc2V0V3JpdGVSZXBvQWxsb3dsaXN0fS5cbiAqXG4gKiBBIHdvcmtlciBydW4gc2VlZHMgaXRzIG9uZSB0YXJnZXQgcmVwby4gU2V0dXAgc2VlZHMgZXZlcnkgY29uZmlndXJlZCByZXBvXG4gKiAoSXNzdWUgIzI2ODQpOiBpdCB3cml0ZXMgdG8gZWFjaCBvZiB0aGVtIGJ5IGRlc2lnbiwgYW5kIG9ubHkgdG8gdGhlbS5cbiAqXG4gKiBAcGFyYW0gdGFyZ2V0UmVwbyAtIFRoZSBydW4ncyBvd24gdGFyZ2V0IHJlcG8sIGBvd25lci9yZXBvYC5cbiAqIEBwYXJhbSBtb3JlUmVwb3MgLSBGdXJ0aGVyIHJlcG9zIHRoZSBzYW1lIHJ1biB3cml0ZXMgdG8gYnkgZGVzaWduLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VlZFdyaXRlUmVwb0FsbG93bGlzdChcbiAgdGFyZ2V0UmVwbzogc3RyaW5nLFxuICAuLi5tb3JlUmVwb3M6IHN0cmluZ1tdXG4pOiB2b2lkIHtcbiAgY29uc3QgYyA9IGN0eCgpO1xuICBjLmFsbG93ZWQuY2xlYXIoKTtcbiAgYy5hY3RpdmUgPSB0cnVlO1xuICBjLmFnZW50U25hcHNob3RUYWtlbiA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IHJlcG8gb2YgW3RhcmdldFJlcG8sIC4uLm1vcmVSZXBvc10pIHJlZ2lzdGVyV3JpdGVSZXBvKHJlcG8pO1xufVxuXG4vKipcbiAqIFJlZ2lzdGVyIGFuIGFkZGl0aW9uYWwgcmVwbyB0aGUgY3VycmVudCBydW4gbWF5IHdyaXRlIHRvLlxuICpcbiAqIEEgKip3b3JrZXItcHJvY2VzcyoqIGdyYW50LiBJdHMgb25lIHByb2R1Y3Rpb24gY2FsbGVyIGlzIHRoZSAjMzg2MFxuICogc2VlZC1pZGxlLXRhc2tzIGZsb3cgKGBjb21tYW5kcy9wcm9jZXNzX3NlZWRfaWRsZV90YXNrcy50c2ApLCB3aGljaCBhZGRzXG4gKiB0aGUgb3BlcmF0b3ItYXBwcm92ZWQgdGFyZ2V0IHJlcG8gYWxvbmdzaWRlIHRoZSByZXF1ZXN0aW5nIGlzc3VlJ3Mgb3duXG4gKiByZXBvLCBzZWVkcyB0aGUgd3JhcHBlcnMgaXRzZWxmLCBhbmQgcmVsZWFzZXMgdGhlIGdyYW50IGluIGEgYGZpbmFsbHlgLlxuICogVGhhdCBmbG93IG5ldmVyIHNwYXducyB0aGUgYWdlbnQuXG4gKlxuICogSXQgZG9lcyAqKm5vdCoqIGV4dGVuZCBhbiBhbHJlYWR5LXNwYXduZWQgYWdlbnQncyBib3VuZGFyeSAoSXNzdWUgIzM4NjEpOlxuICogdGhlIGBnaGAgZ3VhcmQgc2hpbSBiYWtlZCBpdHMgYWxsb3dsaXN0IGF0IHNwYXduIHRpbWUuIEEgZ3JhbnQgbWFkZSBhZnRlclxuICogdGhhdCBzbmFwc2hvdCBpcyBzdGlsbCBhcHBsaWVkIGZvciB0aGUgd29ya2VyLCBidXQgaXMgcmVwb3J0ZWQgd2l0aCBhXG4gKiBgW1NFQ1VSSVRZXSBbV1JJVEVfUkVQT19HUkFOVF9BRlRFUl9TUEFXTl1gIGxpbmUgc28gdGhlIG1pcy1zZXF1ZW5jaW5nIGlzXG4gKiB2aXNpYmxlIGluc3RlYWQgb2YgbG9va2luZyBsaWtlIGEgd2lkZW5lZCBhZ2VudCBib3VuZGFyeSB0aGF0IG5ldmVyIHdhcy5cbiAqXG4gKiBBIG5vLW9wIG9uIGFuIGVtcHR5L2JsYW5rIHNsdWcuXG4gKlxuICogQHBhcmFtIHJlcG8gLSBBZGRpdGlvbmFsIGBvd25lci9yZXBvYCB0byBhbGxvdy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyV3JpdGVSZXBvKHJlcG86IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBuID0gbm9ybWFsaXNlS2VlcGluZ0Nhc2UocmVwbyk7XG4gIGlmIChuLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICBjb25zdCBjID0gY3R4KCk7XG4gIGlmIChjLmFnZW50U25hcHNob3RUYWtlbiAmJiAhYy5hbGxvd2VkLmhhcyhuKSkge1xuICAgIHNlY3VyaXR5TG9nZ2VyKFxuICAgICAgYFtTRUNVUklUWV0gW1dSSVRFX1JFUE9fR1JBTlRfQUZURVJfU1BBV05dIEdyYW50ZWQgJHtufSBhZnRlciB0aGUgYWdlbnQgYCArXG4gICAgICAgIFwiZ2ggZ3VhcmQgc2hpbSBiYWtlZCB0aGlzIHJ1bidzIGFsbG93bGlzdCDigJQgdGhlIGdyYW50IGFwcGxpZXMgdG8gdGhlIFwiICtcbiAgICAgICAgXCJ3b3JrZXIgcHJvY2VzcyBvbmx5OyB0aGUgcnVubmluZyBhZ2VudCBzdWJwcm9jZXNzIGNhbm5vdCB3cml0ZSB0byBpdC5cIixcbiAgICApO1xuICB9XG4gIGMuYWxsb3dlZC5hZGQobik7XG59XG5cbi8qKlxuICogUnVuIGBmbmAgd2l0aCBgcmVwb2AgdGVtcG9yYXJpbHkgb24gdGhlICoqd29ya2VyJ3MqKiBhbGxvd2xpc3QsIHRoZW4gcmVtb3ZlXG4gKiBpdCBhZ2FpbiAoSXNzdWUgIzE4MikuXG4gKlxuICogVGhlIG9uZSBwcm9kdWN0aW9uIGNhbGxlciBpcyB0aGUgY3Jvc3MtcmVwbyBkZXBlbmRlbmN5LVBSIGJyaWRnZVxuICogKGBjcm9zc19yZXBvX3ByX2hhbmRvZmYudHNgKTogdGhlIGFnZW50IGNhbm5vdCBvcGVuIGEgUFIgaW4gYW4gaW50ZXJuYWxcbiAqIGBzdFNvZnR3YXJlQVUvKmAgZGVwZW5kZW5jeSAoaXRzIGBnaGAgZ3VhcmQgb25seSBrbm93cyB0aGUgY2xhaW0gcmVwbyksIHNvIGl0XG4gKiBwdXNoZXMgdGhlIGJyYW5jaCBhbmQgZGVjbGFyZXMgdGhlIFBSLCBhbmQgdGhlICp3b3JrZXIqIG9wZW5zIGl0LiBUaGF0IHNpbmdsZVxuICogYGdoIHByIGNyZWF0ZWAgaXMgdGhlIG9ubHkgd3JpdGUgdGhlIGdyYW50IGNvdmVycy5cbiAqXG4gKiBUaGUgZ3JhbnQgaXMgZGVsaWJlcmF0ZWx5IG5hcnJvd2VyIHRoYW4ge0BsaW5rIHJlZ2lzdGVyV3JpdGVSZXBvfTpcbiAqXG4gKiAtICoqU2NvcGVkIGluIHRpbWUqKiDigJQgdGhlIHJlcG8gaXMgcmVtb3ZlZCBmcm9tIHRoZSBhbGxvd2xpc3QgYXMgc29vbiBhc1xuICogICBgZm5gIHNldHRsZXMsIGluY2x1ZGluZyB3aGVuIGl0IHRocm93cywgc28gdGhlIGJvdW5kYXJ5IHJlLWNsb3Nlcy5cbiAqIC0gKipXb3JrZXItb25seSoqIOKAlCB0aGUgYWdlbnQgc3VicHJvY2VzcyBiYWtlZCBpdHMgb3duIGFsbG93bGlzdCBzbmFwc2hvdCBhdFxuICogICBzcGF3biB0aW1lIChzZWUgdGhlIG1vZHVsZSBkb2MgYWJvdmUgYW5kIFNFQ1VSSVRZLm1kIMKnNiksIHNvIHRoaXMgY2Fubm90XG4gKiAgIHdpZGVuIHdoYXQgdGhlIGFnZW50IGl0c2VsZiBtYXkgd3JpdGUgdG8uXG4gKiAtICoqQW5ub3VuY2VkKiog4oCUIGEgYFtTRUNVUklUWV0gW1dSSVRFX1JFUE9fU0NPUEVEX0dSQU5UXWAgbGluZSByZWNvcmRzIHRoZVxuICogICBncmFudCwgc28gYSBjcm9zcy1yZXBvIHdyaXRlIGlzIG5ldmVyIGludmlzaWJsZS5cbiAqXG4gKiBDYWxsZXJzIE1VU1QgdmFsaWRhdGUgdGhlIHRhcmdldCBmaXJzdCAoaW50ZXJuYWwgb3duZXIgKyByZWFjaGFibGUgKyBwdXNoXG4gKiBwZXJtaXNzaW9uKTsgdGhpcyBoZWxwZXIgZW5mb3JjZXMgc2NvcGUsIG5vdCBwb2xpY3kuIEEgcmVwbyBhbHJlYWR5IG9uIHRoZVxuICogYWxsb3dsaXN0IChvciBwaW5uZWQpIGlzIGxlZnQgZXhhY3RseSBhcyBpdCB3YXMuXG4gKlxuICogQHBhcmFtIHJlcG8gLSBgb3duZXIvcmVwb2AgdGhlIHdvcmtlciBtYXkgd3JpdGUgdG8gZm9yIHRoZSBkdXJhdGlvbiBvZiBgZm5gLlxuICogQHBhcmFtIGZuIC0gVGhlIHNpbmdsZSB2YWxpZGF0ZWQgY3Jvc3MtcmVwbyBvcGVyYXRpb24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3aXRoU2NvcGVkV3JpdGVSZXBvPFQ+KFxuICByZXBvOiBzdHJpbmcsXG4gIGZuOiAoKSA9PiBQcm9taXNlPFQ+LFxuKTogUHJvbWlzZTxUPiB7XG4gIGNvbnN0IG4gPSBub3JtYWxpc2VLZWVwaW5nQ2FzZShyZXBvKTtcbiAgY29uc3QgYyA9IGN0eCgpO1xuICAvLyBOb3RoaW5nIHRvIGdyYW50OiBubyBzbHVnLCBlbmZvcmNlbWVudCBpbmFjdGl2ZSwgb3IgYWxyZWFkeSB3cml0YWJsZS5cbiAgaWYgKG4ubGVuZ3RoID09PSAwIHx8ICFjLmFjdGl2ZSB8fCBjLmFsbG93ZWQuaGFzKG4pIHx8IGMucGlubmVkLmhhcyhuKSkge1xuICAgIHJldHVybiBhd2FpdCBmbigpO1xuICB9XG4gIHNlY3VyaXR5TG9nZ2VyKFxuICAgIGBbU0VDVVJJVFldIFtXUklURV9SRVBPX1NDT1BFRF9HUkFOVF0gR3JhbnRlZCAke3JlcG8udHJpbSgpfSBmb3IgdGhlIGR1cmF0aW9uIG9mIG9uZSBgICtcbiAgICAgIFwidmFsaWRhdGVkIGNyb3NzLXJlcG8gY2FsbCDigJQgd29ya2VyIHByb2Nlc3Mgb25seTsgdGhlIHJ1bm5pbmcgYWdlbnQgXCIgK1xuICAgICAgXCJzdWJwcm9jZXNzIGNhbm5vdCB3cml0ZSB0byBpdC5cIixcbiAgKTtcbiAgYy5hbGxvd2VkLmFkZChuKTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZm4oKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjLmFsbG93ZWQuZGVsZXRlKG4pO1xuICB9XG59XG5cbi8qKlxuICogUnVuIGBmbmAgd2l0aCBgcmVwb2AgcmVhY2hhYmxlIGJ5IHRoZSBydW4ncyAqKmluc3RhbGxhdGlvbiB0b2tlbioqLCB3aXRob3V0XG4gKiBwdXR0aW5nIGl0IG9uIHRoZSB3cml0ZSBhbGxvd2xpc3QgKElzc3VlICMxMzkxKS5cbiAqXG4gKiBBIEdpdEh1YiBBcHAgdG9rZW4gaXMgc2NvcGVkIHBlciByZXBvc2l0b3J5LCBub3QgcGVyIHZlcmI6IGEgcmVwbyB0aGUgd29ya2VyXG4gKiBtdXN0IFJFQUQgaGFzIHRvIGJlIG5hbWVkIGluIHRoZSB0b2tlbidzIHNjb3BlIG9yIGV2ZXJ5IGNhbGwgdG8gaXQgNDA0cy4gVGhlXG4gKiBvbmUgcHJvZHVjdGlvbiBjYWxsZXIgaXMgdGhlIGNyb3NzLXJlcG8gZGVwZW5kZW5jeS1QUiBicmlkZ2VcbiAqIChgY3Jvc3NfcmVwb19wcl9oYW5kb2ZmLnRzYCksIHdoaWNoIHByb2JlcyBhbiBhdXRob3Jpc2VkIGludGVybmFsIGRlcGVuZGVuY3lcbiAqIOKAlCBpdHMgZGVmYXVsdCBicmFuY2gsIHRoZSBwdXNoZWQgaGVhZCwgYW4gYWxyZWFkeS1vcGVuIFBSIOKAlCBiZWZvcmUgb3BlbmluZ1xuICogdGhlIHNpbmdsZSBQUiB0aGF0IHtAbGluayB3aXRoU2NvcGVkV3JpdGVSZXBvfSBjb3ZlcnMuXG4gKlxuICogVGhlIGdyYW50IGlzIGRlbGliZXJhdGVseSB3ZWFrZXIgdGhhbiB7QGxpbmsgd2l0aFNjb3BlZFdyaXRlUmVwb306XG4gKlxuICogLSAqKlJlYWNoLCBub3QgYXV0aG9yaXR5Kiog4oCUIHRoZSByZXBvIGlzICpub3QqIGFkZGVkIHRvIGBhbGxvd2VkYCwgc28gdGhlXG4gKiAgIGBzcGF3bkdoYCBjaG9rZXBvaW50IHJlZnVzZXMgZXZlcnkgd3JpdGUgdG8gaXQgZXhhY3RseSBhcyBiZWZvcmUuXG4gKiAtICoqU2NvcGVkIGluIHRpbWUqKiDigJQgcmVmY291bnRlZCBhbmQgcmVsZWFzZWQgd2hlbiBgZm5gIHNldHRsZXMsIGluY2x1ZGluZ1xuICogICB3aGVuIGl0IHRocm93cy5cbiAqIC0gKipXb3JrZXItb25seSoqIOKAlCB0aGUgYWdlbnQgc3VicHJvY2VzcyBob2xkcyBpdHMgb3duIGNyZWRlbnRpYWwgYW5kIGl0c1xuICogICBvd24gYmFrZWQgYWxsb3dsaXN0IHNuYXBzaG90OyBuZWl0aGVyIGlzIHRvdWNoZWQgaGVyZS5cbiAqXG4gKiBDYWxsZXJzIE1VU1QgdmFsaWRhdGUgdGhlIHRhcmdldCBmaXJzdDsgdGhpcyBoZWxwZXIgZW5mb3JjZXMgc2NvcGUsIG5vdFxuICogcG9saWN5LiBBIG5vLW9wIG9uIGEgYmxhbmsgc2x1ZywgYW5kIGluZXJ0IHdoaWxlIGVuZm9yY2VtZW50IGlzIGluYWN0aXZlXG4gKiAoYW4gdW5zY29wZWQgdG9rZW4gYWxyZWFkeSByZWFjaGVzIGV2ZXJ5dGhpbmcpLlxuICpcbiAqIEBwYXJhbSByZXBvIC0gYG93bmVyL3JlcG9gIHRoZSB0b2tlbiBtYXkgcmVhY2ggZm9yIHRoZSBkdXJhdGlvbiBvZiBgZm5gLlxuICogQHBhcmFtIGZuIC0gVGhlIHZhbGlkYXRlZCBjcm9zcy1yZXBvIG9wZXJhdGlvbi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdpdGhUb2tlblNjb3BlZFJlcG88VD4oXG4gIHJlcG86IHN0cmluZyxcbiAgZm46ICgpID0+IFByb21pc2U8VD4sXG4pOiBQcm9taXNlPFQ+IHtcbiAgY29uc3QgbiA9IG5vcm1hbGlzZUtlZXBpbmdDYXNlKHJlcG8pO1xuICBjb25zdCBjID0gY3R4KCk7XG4gIGlmIChuLmxlbmd0aCA9PT0gMCB8fCAhYy5hY3RpdmUpIHJldHVybiBhd2FpdCBmbigpO1xuICBzZWN1cml0eUxvZ2dlcihcbiAgICBgW1NFQ1VSSVRZXSBbVE9LRU5fU0NPUEVfR1JBTlRdIEluc3RhbGxhdGlvbiB0b2tlbiBzY29wZWQgdG8gaW5jbHVkZSAke3JlcG8udHJpbSgpfSBgICtcbiAgICAgIFwiZm9yIHRoZSBkdXJhdGlvbiBvZiBvbmUgdmFsaWRhdGVkIGNyb3NzLXJlcG8gY2FsbCDigJQgcmVhZCByZWFjaCBvbmx5OyBcIiArXG4gICAgICBcIndyaXRlcyB0byBpdCBhcmUgc3RpbGwgcmVmdXNlZCBieSB0aGUgd3JpdGUtcmVwbyBhbGxvd2xpc3QuXCIsXG4gICk7XG4gIGMudG9rZW5TY29wZWQuc2V0KG4sIChjLnRva2VuU2NvcGVkLmdldChuKSA/PyAwKSArIDEpO1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBmbigpO1xuICB9IGZpbmFsbHkge1xuICAgIGNvbnN0IGNvdW50ID0gYy50b2tlblNjb3BlZC5nZXQobikgPz8gMDtcbiAgICBpZiAoY291bnQgPD0gMSkgYy50b2tlblNjb3BlZC5kZWxldGUobik7XG4gICAgZWxzZSBjLnRva2VuU2NvcGVkLnNldChuLCBjb3VudCAtIDEpO1xuICB9XG59XG5cbi8qKlxuICogVGhlIHJlcG9zaXRvcmllcyB0aGUgcnVuJ3MgR2l0SHViIEFwcCBpbnN0YWxsYXRpb24gdG9rZW4gbWF5IHJlYWNoXG4gKiAoSXNzdWUgIzEzOTEpLlxuICpcbiAqIGBudWxsYCB3aGlsZSBlbmZvcmNlbWVudCBpcyBpbmFjdGl2ZSDigJQgdGhlIHJ1biBoYXMgbm90IHNlZWRlZCBhbiBhbGxvd2xpc3QsXG4gKiBzbyB0aGVyZSBpcyBub3RoaW5nIHRvIHNjb3BlIHRvIGFuZCB0aGUgdG9rZW4ga2VlcHMgdGhlIGluc3RhbGxhdGlvbidzIGZ1bGxcbiAqIHJlYWNoICh0aGUgc2FtZSBmYWlsLW9wZW4tdW50aWwtc2VlZGVkIHJ1bGUgdGhlIHdyaXRlIGNoZWNrcyBmb2xsb3cpLiBPbmNlXG4gKiBzZWVkZWQgaXQgaXMgdGhlIHJlcG9zIHRoaXMgcnVuIG1heSB3cml0ZSB0byAoYGFsbG93ZWRgIOKIqiBgcGlubmVkYCkgcGx1cyBhbnlcbiAqIHJlcG8gYSBsaXZlIHtAbGluayB3aXRoVG9rZW5TY29wZWRSZXBvfSBncmFudCBuZWVkcyB0byByZWFkLlxuICpcbiAqIFNsdWdzIGFyZSByZXR1cm5lZCBpbiB0aGUgY2FzaW5nIHRoZXkgd2VyZSByZWdpc3RlcmVkIGluIOKAlCBHaXRIdWIgaXMgZmVkXG4gKiByZXBvc2l0b3J5IG5hbWVzLCBub3QgdGhpcyBtb2R1bGUncyBjb21wYXJpc29uIGtleXMuXG4gKlxuICogQHJldHVybnMgU29ydGVkIGBvd25lci9yZXBvYCBzbHVncywgb3IgYG51bGxgIGZvciBhbiB1bnNjb3BlZCB0b2tlbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxhdGlvblRva2VuUmVwb1Njb3BlKCk6IHN0cmluZ1tdIHwgbnVsbCB7XG4gIGNvbnN0IGMgPSBjdHgoKTtcbiAgaWYgKCFjLmFjdGl2ZSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGtleXMgPSBuZXcgU2V0KFtcbiAgICAuLi5jLmFsbG93ZWQsXG4gICAgLi4uYy5waW5uZWQua2V5cygpLFxuICAgIC4uLmMudG9rZW5TY29wZWQua2V5cygpLFxuICBdKTtcbiAgcmV0dXJuIFsuLi5rZXlzXS5tYXAoKG4pID0+IGMuc2x1Z0Nhc2luZy5nZXQobikgPz8gbikuc29ydCgpO1xufVxuXG4vKipcbiAqIFBpbiBhIHJlcG8gc28gaXQgc3RheXMgd3JpdGFibGUgYWNyb3NzIGFsbG93bGlzdCByZXNlZWRzIChJc3N1ZSAjMzc2MCkuXG4gKlxuICogQ2FsbGVkIGJ5IGBzdGFydEhlYXJ0YmVhdGAgd2l0aCB0aGUgY2xhaW0ncyByZXBvIGJlZm9yZSB0aGUgaW5pdGlhbFxuICogbWFya2VyIHdyaXRlLiBSZWZjb3VudGVkIOKAlCB0d28gaGVhcnRiZWF0cyBvbiB0aGUgc2FtZSByZXBvIGhvbGQgdHdvXG4gKiBwaW5zLCBhbmQgdGhlIHJlcG8gc3RheXMgd3JpdGFibGUgdW50aWwgYm90aCByZWxlYXNlLiBBIG5vLW9wIG9uIGFuXG4gKiBlbXB0eS9ibGFuayBzbHVnLlxuICpcbiAqIEBwYXJhbSByZXBvIC0gYG93bmVyL3JlcG9gIHRvIHBpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBpbldyaXRlUmVwbyhyZXBvOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbiA9IG5vcm1hbGlzZUtlZXBpbmdDYXNlKHJlcG8pO1xuICBpZiAobi5sZW5ndGggPT09IDApIHJldHVybjtcbiAgY29uc3QgeyBwaW5uZWQgfSA9IGN0eCgpO1xuICBwaW5uZWQuc2V0KG4sIChwaW5uZWQuZ2V0KG4pID8/IDApICsgMSk7XG59XG5cbi8qKlxuICogUmVsZWFzZSBvbmUgcGluIG9uIGEgcmVwbyAoSXNzdWUgIzM3NjApLlxuICpcbiAqIENhbGxlZCBieSBgc3RvcEhlYXJ0YmVhdGAgYWZ0ZXIgdGhlIGZpbmFsIHN0YWxlLW1hcmtlciB3cml0ZS4gVGhlIHJlcG9cbiAqIGxvc2VzIGl0cyByZXNlZWQtcHJvb2YgcHJvdGVjdGlvbiBvbmNlIHRoZSBsYXN0IHBpbiBpcyByZWxlYXNlZC4gQSBzYWZlXG4gKiBuby1vcCB3aGVuIHRoZSByZXBvIGhvbGRzIG5vIHBpbi5cbiAqXG4gKiBAcGFyYW0gcmVwbyAtIGBvd25lci9yZXBvYCB0byB1bnBpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVucGluV3JpdGVSZXBvKHJlcG86IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBuID0gbm9ybWFsaXNlKHJlcG8pO1xuICBjb25zdCB7IHBpbm5lZCB9ID0gY3R4KCk7XG4gIGNvbnN0IGNvdW50ID0gcGlubmVkLmdldChuKTtcbiAgaWYgKGNvdW50ID09PSB1bmRlZmluZWQpIHJldHVybjtcbiAgaWYgKGNvdW50IDw9IDEpIHBpbm5lZC5kZWxldGUobik7XG4gIGVsc2UgcGlubmVkLnNldChuLCBjb3VudCAtIDEpO1xufVxuXG4vKiogQ2xlYXIgYWxsIHBpbnMuIFRlc3Qtb25seSDigJQgcHJvZHVjdGlvbiBwaW5zIGFyZSByZWxlYXNlZCBieSB0aGVpciBvd25lci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfcmVzZXRXcml0ZVJlcG9QaW5zKCk6IHZvaWQge1xuICBjdHgoKS5waW5uZWQuY2xlYXIoKTtcbn1cblxuLyoqIFdoZXRoZXIgZW5mb3JjZW1lbnQgaXMgYWN0aXZlIChpLmUuIGEgcnVuIGhhcyBzZWVkZWQgdGhlIGFsbG93bGlzdCkuICovXG5leHBvcnQgZnVuY3Rpb24gaXNXcml0ZVJlcG9BbGxvd2xpc3RBY3RpdmUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBjdHgoKS5hY3RpdmU7XG59XG5cbi8qKiBUaGUgY3VycmVudCBhbGxvd2xpc3QgYXMgYSBzb3J0ZWQgYXJyYXkgb2YgYG93bmVyL3JlcG9gIHNsdWdzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3RBbGxvd2VkV3JpdGVSZXBvcygpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBbLi4uY3R4KCkuYWxsb3dlZF0uc29ydCgpO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgYSB3cml0ZSB0byBgcmVwb2AgaXMgcGVybWl0dGVkIGZvciB0aGUgY3VycmVudCBydW4uXG4gKlxuICogQWx3YXlzIGB0cnVlYCB3aGlsZSBlbmZvcmNlbWVudCBpcyBpbmFjdGl2ZSAoZmFpbC1vcGVuIHVudGlsIHNlZWRlZCkuXG4gKlxuICogQHBhcmFtIHJlcG8gLSBgb3duZXIvcmVwb2AgdG8gY2hlY2suXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1dyaXRlUmVwb0FsbG93ZWQocmVwbzogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGMgPSBjdHgoKTtcbiAgaWYgKCFjLmFjdGl2ZSkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IG4gPSBub3JtYWxpc2UocmVwbyk7XG4gIC8vIFBpbm5lZCByZXBvcyAoSXNzdWUgIzM3NjApIGFyZSB3cml0YWJsZSByZWdhcmRsZXNzIG9mIHRoZSBjdXJyZW50XG4gIC8vIHJ1bidzIHNlZWRlZCBzZXQg4oCUIGFuIGFjdGl2ZSBoZWFydGJlYXQgbXVzdCBiZSBhYmxlIHRvIHJlZnJlc2ggaXRzXG4gIC8vIG1hcmtlciBldmVuIGFmdGVyIHRoZSBuZXh0IGNsYWltIHJlc2VlZHMuXG4gIHJldHVybiBjLmFsbG93ZWQuaGFzKG4pIHx8IGMucGlubmVkLmhhcyhuKTtcbn1cblxuLyoqIFRoZSB0YXJnZXQgYSBjbGFzc2lmaWVkIG11dGF0aW9uIGlzIHdyaXR0ZW4gdG8sIGZvciB0aGUgdW5zZWVkZWQgcmVjb3JkLiAqL1xuZnVuY3Rpb24gdW5zZWVkZWRUYXJnZXQoaW5mbzogTXV0YXRpb25JbmZvKTogc3RyaW5nIHtcbiAgaWYgKGluZm8ucmVwbykgcmV0dXJuIGluZm8ucmVwbztcbiAgcmV0dXJuIGluZm8uc2NvcGUgPT09IFwidW5rbm93blwiID8gXCI8dW5kZXRlcm1pbmFibGU+XCIgOiBcIjxjd2QgcmVwbz5cIjtcbn1cblxuLyoqXG4gKiBNYXJrIGEgbXV0YXRpb24gdGhhdCByYW4gd2l0aCB0aGUgYWxsb3dsaXN0IGluYWN0aXZlIChJc3N1ZSAjMTQyNSkuXG4gKlxuICogVGhlIHdyaXRlIGlzIHN0aWxsIGFsbG93ZWQg4oCUIHRoaXMgaXMgdGhlIGZhaWwtb3BlbiBydWxlLCB1bmNoYW5nZWQg4oCUIGJ1dFxuICogaXQgbm8gbG9uZ2VyIHBhc3NlcyB1bnNlZW4uIFRoZSBmaXJzdCBtdXRhdGlvbiBvZiBlYWNoIGtpbmQgKHZlcmIgYW5kXG4gKiB0YXJnZXQpIGluIHRoaXMgY29udGV4dCBlbWl0cyBhIGBbU0VDVVJJVFldIFtXUklURV9SRVBPX1VOU0VFREVEXWAgbGluZVxuICogYW5kIGFuIGB1bnNlZWRlZC08dmVyYj5gIGF1ZGl0IGV2ZW50OyBldmVyeSBvbmUgaXMgY291bnRlZC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbm90ZVVuc2VlZGVkV3JpdGUoXG4gIGM6IFdyaXRlUmVwb0FsbG93bGlzdENvbnRleHQsXG4gIGluZm86IE11dGF0aW9uSW5mbyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB3aGVyZSA9IHVuc2VlZGVkVGFyZ2V0KGluZm8pO1xuICBjb25zdCBrZXkgPSBgJHtpbmZvLnZlcmJ9IOKGkiAke3doZXJlfWA7XG4gIGNvbnN0IHNlZW4gPSAoYy51bnNlZWRlZFdyaXRlcy5nZXQoa2V5KSA/PyAwKSArIDE7XG4gIGMudW5zZWVkZWRXcml0ZXMuc2V0KGtleSwgc2Vlbik7XG4gIGlmIChzZWVuID4gMSkgcmV0dXJuO1xuICBzZWN1cml0eUxvZ2dlcihcbiAgICBgW1NFQ1VSSVRZXSBbV1JJVEVfUkVQT19VTlNFRURFRF0gJHtpbmZvLnZlcmJ9IHRvICR7d2hlcmV9YCArXG4gICAgICAoaW5mby50YXJnZXQgPyBgICgke2luZm8udGFyZ2V0fSlgIDogXCJcIikgK1xuICAgICAgXCIgcmFuIHdpdGggdGhlIHdyaXRlLXJlcG8gYWxsb3dsaXN0IGluYWN0aXZlIOKAlCBubyBydW4gaGFzIHNlZWRlZCBpdCwgXCIgK1xuICAgICAgXCJzbyB0aGlzIHdyaXRlIGlzIHVuc2NvcGVkLiBBbGxvd2VkIChmYWlsLW9wZW4gdW50aWwgc2VlZGVkKTsgZmlyc3Qgb2YgXCIgK1xuICAgICAgXCJpdHMga2luZCBpbiB0aGlzIGNvbnRleHQsIGxhdGVyIG9uZXMgYXJlIGNvdW50ZWQgKElzc3VlICMxNDI1KS5cIixcbiAgKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBhdWRpdFJlY29yZGVyKHtcbiAgICAgIHJ1bklkOiByZXNvbHZlUnVuSWQoKSxcbiAgICAgIHZlcmI6IGB1bnNlZWRlZC0ke2luZm8udmVyYn1gLFxuICAgICAgb3V0Y29tZTogXCJzdWNjZXNzXCIsXG4gICAgICAuLi4oaW5mby5yZXBvID8geyByZXBvOiBpbmZvLnJlcG8gfSA6IHt9KSxcbiAgICAgIC4uLihpbmZvLnRhcmdldCA/IHsgdGFyZ2V0OiBpbmZvLnRhcmdldCB9IDoge30pLFxuICAgICAgY2FsbGVyOiBcIndvcmtlci9kZW5vL2xpYi93cml0ZV9yZXBvX2FsbG93bGlzdC50c1wiLFxuICAgIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvLyBCZXN0LWVmZm9ydDogdGhlIHNpZ25hbCBtdXN0IG5ldmVyIGZhaWwgdGhlIHdyaXRlIGl0IGRlc2NyaWJlcy5cbiAgfVxufVxuXG4vKipcbiAqIE11dGF0aW9ucyB0aGF0IHJhbiB3aGlsZSBlbmZvcmNlbWVudCB3YXMgaW5hY3RpdmUgaW4gdGhlIGN1cnJlbnQgY29udGV4dFxuICogKElzc3VlICMxNDI1KTogYHZlcmIg4oaSIHJlcG9gIGtpbmRzIHdpdGggYSBjb3VudCBlYWNoLCBzb3J0ZWQgYnkga2luZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVuc2VlZGVkV3JpdGVDb3VudHMoKTogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB7XG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuICBmb3IgKGNvbnN0IGtleSBvZiBbLi4uY3R4KCkudW5zZWVkZWRXcml0ZXMua2V5cygpXS5zb3J0KCkpIHtcbiAgICBvdXRba2V5XSA9IGN0eCgpLnVuc2VlZGVkV3JpdGVzLmdldChrZXkpID8/IDA7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFRvdGFsIG11dGF0aW9ucyB0aGF0IHJhbiB3aGlsZSBlbmZvcmNlbWVudCB3YXMgaW5hY3RpdmUgKElzc3VlICMxNDI1KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb3VudFVuc2VlZGVkV3JpdGVzKCk6IG51bWJlciB7XG4gIGxldCB0b3RhbCA9IDA7XG4gIGZvciAoY29uc3QgbiBvZiBjdHgoKS51bnNlZWRlZFdyaXRlcy52YWx1ZXMoKSkgdG90YWwgKz0gbjtcbiAgcmV0dXJuIHRvdGFsO1xufVxuXG4vKiogRm9yZ2V0IHRoZSB1bnNlZWRlZC13cml0ZSByZWNvcmQuIFRlc3Qtb25seS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfcmVzZXRVbnNlZWRlZFdyaXRlcygpOiB2b2lkIHtcbiAgY3R4KCkudW5zZWVkZWRXcml0ZXMuY2xlYXIoKTtcbn1cblxuLyoqIFJlY29yZCBhIGJsb2NrZWQgd3JpdGUgYXMgYSBzZWN1cml0eSBhdWRpdCBldmVudCAoYmVzdC1lZmZvcnQpLiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVjb3JkQmxvY2tlZChcbiAgcmVwbzogc3RyaW5nLFxuICB2ZXJiOiBzdHJpbmcsXG4gIHRhcmdldDogc3RyaW5nIHwgdW5kZWZpbmVkLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgYXdhaXQgYXVkaXRSZWNvcmRlcih7XG4gICAgICBydW5JZDogcmVzb2x2ZVJ1bklkKCksXG4gICAgICB2ZXJiOiBgYmxvY2tlZC0ke3ZlcmJ9YCxcbiAgICAgIG91dGNvbWU6IFwiZXJyb3JcIixcbiAgICAgIHJlcG8sXG4gICAgICAuLi4odGFyZ2V0ID8geyB0YXJnZXQgfSA6IHt9KSxcbiAgICAgIGNhbGxlcjogXCJ3b3JrZXIvZGVuby9saWIvd3JpdGVfcmVwb19hbGxvd2xpc3QudHNcIixcbiAgICB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gQmVzdC1lZmZvcnQ6IG5ldmVyIGxldCBhdWRpdCBqb3VybmFsbGluZyBtYXNrIHRoZSBibG9jayBpdHNlbGYuXG4gIH1cbn1cblxuLyoqXG4gKiBFbmZvcmNlIHRoZSBhbGxvd2xpc3QgZm9yIGEgc2luZ2xlIGBnaGAgaW52b2NhdGlvbi5cbiAqXG4gKiBBIG5vLW9wIHdoZW4gdGhlIGNvbW1hbmQgaXMgbm90IGEgR2l0SHViIG11dGF0aW9uLCBvciB3aGVuIHRoZSBtdXRhdGlvblxuICogdGFyZ2V0cyB0aGUgY3dkIHJlcG8gKG5vIGV4cGxpY2l0IHJlcG8pLiBXaGlsZSBlbmZvcmNlbWVudCBpcyBpbmFjdGl2ZSBhXG4gKiBtdXRhdGlvbiBpcyBhbGxvd2VkIHRocm91Z2ggdW5jaGFuZ2VkLCBidXQgbWFya2VkIOKAlCBzZWVcbiAqIHtAbGluayB1bnNlZWRlZFdyaXRlQ291bnRzfSAoSXNzdWUgIzE0MjUpLlxuICogV2hlbiB0aGUgbXV0YXRpb24gZXhwbGljaXRseSB0YXJnZXRzIGFuIG9mZi1hbGxvd2xpc3QgcmVwbywgZW1pdHMgYVxuICogc2VjdXJpdHkgYXVkaXQgZXZlbnQgcGx1cyBhIGBbU0VDVVJJVFldYCBsb2cgbGluZSBhbmQgdGhyb3dzXG4gKiB7QGxpbmsgV3JpdGVSZXBvQmxvY2tlZEVycm9yfSDigJQgYmVmb3JlIHRoZSBjYWxsZXIgc3Bhd25zIGBnaGAuXG4gKlxuICogRmFpbCBjbG9zZWQgKElzc3VlICMzNzAzKTogYSBtdXRhdGlvbiB3aG9zZSB0YXJnZXQgcmVwbyBpcyB1bmRldGVybWluYWJsZVxuICog4oCUIGEgR3JhcGhRTCBtdXRhdGlvbiwgYW4gZW5kcG9pbnQgdGhhdCBuYW1lcyBubyByZXBvLCBhbiB1bmxpc3RlZCByb290XG4gKiB2ZXJiIOKAlCBpcyByZWZ1c2VkIHdpdGgge0BsaW5rIFdyaXRlVGFyZ2V0VW5kZXRlcm1pbmFibGVFcnJvcn0gcmF0aGVyIHRoYW5cbiAqIGFsbG93ZWQgdGhyb3VnaCB1bmpvdXJuYWxsZWQuXG4gKlxuICogQHBhcmFtIGFyZ3MgLSBBcmd1bWVudHMgYWJvdXQgdG8gYmUgcGFzc2VkIHRvIHRoZSBgZ2hgIGJpbmFyeS5cbiAqIEB0aHJvd3MgV3JpdGVSZXBvQmxvY2tlZEVycm9yIHdoZW4gdGhlIHdyaXRlIHRhcmdldHMgYW4gb2ZmLWFsbG93bGlzdCByZXBvLlxuICogQHRocm93cyBXcml0ZVRhcmdldFVuZGV0ZXJtaW5hYmxlRXJyb3Igd2hlbiB0aGUgdGFyZ2V0IGlzIHVuZGV0ZXJtaW5hYmxlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5mb3JjZUdoV3JpdGVBbGxvd2xpc3QoXG4gIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGMgPSBjdHgoKTtcbiAgY29uc3QgaW5mbyA9IGNsYXNzaWZ5R2hNdXRhdGlvbihhcmdzKTtcbiAgLy8gTm90IGEgbXV0YXRpb24g4oCUIHJlYWRzIGFyZSBuZXZlciB0aGUgZXhmaWx0cmF0aW9uIHNpbmsuXG4gIGlmICghaW5mbykgcmV0dXJuO1xuXG4gIC8vIEZhaWwtb3BlbiB1bnRpbCBzZWVkZWQgKHNlZSB0aGUgbW9kdWxlIGRvYykg4oCUIGJ1dCBzZWVuIChJc3N1ZSAjMTQyNSkuXG4gIGlmICghYy5hY3RpdmUpIHtcbiAgICBhd2FpdCBub3RlVW5zZWVkZWRXcml0ZShjLCBpbmZvKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoaW5mby5zY29wZSA9PT0gXCJ1bmtub3duXCIpIHtcbiAgICBzZWN1cml0eUxvZ2dlcihcbiAgICAgIGBbU0VDVVJJVFldIFtXUklURV9UQVJHRVRfVU5ERVRFUk1JTkFCTEVdIFJlZnVzZWQgJHtpbmZvLnZlcmJ9YCArXG4gICAgICAgIChpbmZvLnRhcmdldCA/IGAgKCR7aW5mby50YXJnZXR9KWAgOiBcIlwiKSArXG4gICAgICAgIFwiIOKAlCB0YXJnZXQgcmVwbyBub3QgZGVyaXZhYmxlLCBmYWlsaW5nIGNsb3NlZFwiLFxuICAgICk7XG4gICAgYXdhaXQgcmVjb3JkQmxvY2tlZChcInVua25vd25cIiwgaW5mby52ZXJiLCBpbmZvLnRhcmdldCk7XG4gICAgdGhyb3cgbmV3IFdyaXRlVGFyZ2V0VW5kZXRlcm1pbmFibGVFcnJvcihpbmZvLnZlcmIsIGluZm8udGFyZ2V0KTtcbiAgfVxuXG4gIC8vIEEgY3dkLXJlcG8gd3JpdGUgKG5vIGV4cGxpY2l0IHJlcG8pIG9yIGEgc2FuY3Rpb25lZCBub24tcmVwbyBtdXRhdGlvbiDigJRcbiAgLy8gdGhlIGV4ZmlsIHZlY3RvciByZXF1aXJlcyBleHBsaWNpdGx5IG5hbWluZyBhbm90aGVyIHJlcG8sIHNvIGFsbG93LlxuICBpZiAoIWluZm8ucmVwbykgcmV0dXJuO1xuICBpZiAoaXNXcml0ZVJlcG9BbGxvd2VkKGluZm8ucmVwbykpIHJldHVybjtcblxuICBzZWN1cml0eUxvZ2dlcihcbiAgICBgW1NFQ1VSSVRZXSBbV1JJVEVfUkVQT19CTE9DS0VEXSBSZWZ1c2VkICR7aW5mby52ZXJifSB0byAke2luZm8ucmVwb30gYCArXG4gICAgICBg4oCUIG5vdCBvbiBydW4gYWxsb3dsaXN0IFske2xpc3RBbGxvd2VkV3JpdGVSZXBvcygpLmpvaW4oXCIsIFwiKX1dYCxcbiAgKTtcbiAgYXdhaXQgcmVjb3JkQmxvY2tlZChpbmZvLnJlcG8sIGluZm8udmVyYiwgaW5mby50YXJnZXQpO1xuICB0aHJvdyBuZXcgV3JpdGVSZXBvQmxvY2tlZEVycm9yKGluZm8ucmVwbywgaW5mby52ZXJiKTtcbn1cblxuLyoqXG4gKiBPdmVycmlkZSB0aGUgYXVkaXQvbG9nIHNpbmtzLiBUZXN0LW9ubHkg4oCUIHByb2R1Y3Rpb24gdXNlcyB0aGUgam91cm5hbCBhbmRcbiAqIGNvbnNvbGUuZXJyb3IgZGVmYXVsdHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfc2V0V3JpdGVSZXBvQWxsb3dsaXN0U2lua3MoXG4gIHNpbmtzOiB7IHJlY29yZD86IEF1ZGl0UmVjb3JkZXI7IGxvZz86IFNlY3VyaXR5TG9nZ2VyIH0sXG4pOiB2b2lkIHtcbiAgaWYgKHNpbmtzLnJlY29yZCkgYXVkaXRSZWNvcmRlciA9IHNpbmtzLnJlY29yZDtcbiAgaWYgKHNpbmtzLmxvZykgc2VjdXJpdHlMb2dnZXIgPSBzaW5rcy5sb2c7XG59XG5cbi8qKiBSZXN0b3JlIHRoZSBwcm9kdWN0aW9uIGF1ZGl0L2xvZyBzaW5rcy4gVGVzdC1vbmx5LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9yZXNldFdyaXRlUmVwb0FsbG93bGlzdFNpbmtzKCk6IHZvaWQge1xuICBhdWRpdFJlY29yZGVyID0gcmVjb3JkTXV0YXRpb247XG4gIHNlY3VyaXR5TG9nZ2VyID0gKG0pID0+IGNvbnNvbGUuZXJyb3IobSk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWdHQyxHQUlELFNBQVMsaUJBQWlCLFFBQVEsbUJBQW1CO0FBQ3JELFNBQVMsY0FBYyxFQUFFLFlBQVksUUFBUSxxQkFBcUI7QUFDbEUsU0FDRSxrQkFBa0IsUUFFYixpQ0FBaUM7QUFVeEM7Ozs7O0NBS0MsR0FDRCxPQUFPLE1BQU0sOEJBQThCO0VBQ3pDLHFEQUFxRCxHQUNyRCxBQUFTLEtBQWE7RUFDdEIscUVBQXFFLEdBQ3JFLEFBQVMsS0FBYztFQUV2QixZQUFZLElBQVksRUFBRSxJQUFhLENBQUU7SUFDdkMsS0FBSyxDQUNILENBQUMsNENBQTRDLEVBQUUsTUFBTSxHQUNuRCxDQUFDLE9BQU8sQ0FBQyxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUMsR0FBRyxFQUFFO0lBRTdCLElBQUksQ0FBQyxJQUFJLEdBQUc7SUFDWixJQUFJLENBQUMsSUFBSSxHQUFHO0lBQ1osSUFBSSxDQUFDLElBQUksR0FBRztFQUNkO0FBQ0Y7QUFFQTs7Ozs7Ozs7O0NBU0MsR0FDRCxPQUFPLE1BQU0sdUNBQXVDO0VBQ2xELGdFQUFnRSxHQUNoRSxBQUFTLEtBQWE7RUFDdEIsaUVBQWlFLEdBQ2pFLEFBQVMsT0FBZ0I7RUFFekIsWUFBWSxJQUFZLEVBQUUsTUFBZSxDQUFFO0lBQ3pDLEtBQUssQ0FDSCxDQUFDLHlEQUF5RCxFQUFFLEtBQUssQ0FBQyxDQUFDLEdBQ2pFLENBQUMsU0FBUyxDQUFDLFdBQVcsRUFBRSxRQUFRLEdBQUcsRUFBRTtJQUV6QyxJQUFJLENBQUMsSUFBSSxHQUFHO0lBQ1osSUFBSSxDQUFDLElBQUksR0FBRztJQUNaLElBQUksV0FBVyxXQUFXLElBQUksQ0FBQyxNQUFNLEdBQUc7RUFDMUM7QUFDRjtBQXVGQSwrQkFBK0IsR0FDL0IsT0FBTyxTQUFTO0VBQ2QsT0FBTztJQUNMLFFBQVE7SUFDUixTQUFTLElBQUk7SUFDYixRQUFRLElBQUk7SUFDWixhQUFhLElBQUk7SUFDakIsWUFBWSxJQUFJO0lBQ2hCLGdCQUFnQixJQUFJO0lBQ3BCLG9CQUFvQjtFQUN0QjtBQUNGO0FBRUEseUVBQXlFLEdBQ3pFLE1BQU0saUJBQWlCO0FBRXZCLDRDQUE0QyxHQUM1QyxNQUFNLGlCQUFpQixJQUFJO0FBRTNCLHVEQUF1RCxHQUN2RCxTQUFTO0VBQ1AsT0FBTyxlQUFlLFFBQVEsTUFBTTtBQUN0QztBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUyw4QkFDZCxPQUFrQyxFQUNsQyxFQUFvQjtFQUVwQixPQUFPLGVBQWUsR0FBRyxDQUFDLFNBQVM7QUFDckM7QUFFQSxxRUFBcUUsR0FDckUsT0FBTyxTQUFTO0VBQ2QsT0FBTztBQUNUO0FBRUEsbUVBQW1FLEdBQ25FLElBQUksZ0JBQStCO0FBRW5DLDREQUE0RCxHQUM1RCxJQUFJLGlCQUFpQyxDQUFDLElBQU0sUUFBUSxLQUFLLENBQUM7QUFFMUQsMkRBQTJELEdBQzNELFNBQVMsVUFBVSxJQUFZO0VBQzdCLE9BQU8sS0FBSyxJQUFJLEdBQUcsV0FBVztBQUNoQztBQUVBOzs7Q0FHQyxHQUNELFNBQVMscUJBQXFCLElBQVk7RUFDeEMsTUFBTSxVQUFVLEtBQUssSUFBSTtFQUN6QixNQUFNLElBQUksUUFBUSxXQUFXO0VBQzdCLElBQUksRUFBRSxNQUFNLEdBQUcsS0FBSyxDQUFDLE1BQU0sVUFBVSxDQUFDLEdBQUcsQ0FBQyxJQUFJO0lBQzVDLE1BQU0sVUFBVSxDQUFDLEdBQUcsQ0FBQyxHQUFHO0VBQzFCO0VBQ0EsT0FBTztBQUNUO0FBRUE7Ozs7O0NBS0MsR0FDRCxPQUFPLFNBQVM7RUFDZCxNQUFNLElBQUk7RUFDVixFQUFFLE1BQU0sR0FBRztFQUNYLEVBQUUsT0FBTyxDQUFDLEtBQUs7RUFDZixFQUFFLGtCQUFrQixHQUFHO0FBQ3pCO0FBRUE7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLFNBQVM7RUFDZCxNQUFNLGtCQUFrQixHQUFHO0FBQzdCO0FBRUE7Ozs7Ozs7Ozs7Ozs7O0NBY0MsR0FDRCxPQUFPLFNBQVMsdUJBQ2QsVUFBa0IsRUFDbEIsR0FBRyxTQUFtQjtFQUV0QixNQUFNLElBQUk7RUFDVixFQUFFLE9BQU8sQ0FBQyxLQUFLO0VBQ2YsRUFBRSxNQUFNLEdBQUc7RUFDWCxFQUFFLGtCQUFrQixHQUFHO0VBQ3ZCLEtBQUssTUFBTSxRQUFRO0lBQUM7T0FBZTtHQUFVLENBQUUsa0JBQWtCO0FBQ25FO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWtCQyxHQUNELE9BQU8sU0FBUyxrQkFBa0IsSUFBWTtFQUM1QyxNQUFNLElBQUkscUJBQXFCO0VBQy9CLElBQUksRUFBRSxNQUFNLEtBQUssR0FBRztFQUNwQixNQUFNLElBQUk7RUFDVixJQUFJLEVBQUUsa0JBQWtCLElBQUksQ0FBQyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSTtJQUM3QyxlQUNFLENBQUMsa0RBQWtELEVBQUUsRUFBRSxpQkFBaUIsQ0FBQyxHQUN2RSx5RUFDQTtFQUVOO0VBQ0EsRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDO0FBQ2hCO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBMEJDLEdBQ0QsT0FBTyxlQUFlLG9CQUNwQixJQUFZLEVBQ1osRUFBb0I7RUFFcEIsTUFBTSxJQUFJLHFCQUFxQjtFQUMvQixNQUFNLElBQUk7RUFDVix3RUFBd0U7RUFDeEUsSUFBSSxFQUFFLE1BQU0sS0FBSyxLQUFLLENBQUMsRUFBRSxNQUFNLElBQUksRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUk7SUFDdEUsT0FBTyxNQUFNO0VBQ2Y7RUFDQSxlQUNFLENBQUMsNkNBQTZDLEVBQUUsS0FBSyxJQUFJLEdBQUcseUJBQXlCLENBQUMsR0FDcEYsd0VBQ0E7RUFFSixFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUM7RUFDZCxJQUFJO0lBQ0YsT0FBTyxNQUFNO0VBQ2YsU0FBVTtJQUNSLEVBQUUsT0FBTyxDQUFDLE1BQU0sQ0FBQztFQUNuQjtBQUNGO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBMEJDLEdBQ0QsT0FBTyxlQUFlLG9CQUNwQixJQUFZLEVBQ1osRUFBb0I7RUFFcEIsTUFBTSxJQUFJLHFCQUFxQjtFQUMvQixNQUFNLElBQUk7RUFDVixJQUFJLEVBQUUsTUFBTSxLQUFLLEtBQUssQ0FBQyxFQUFFLE1BQU0sRUFBRSxPQUFPLE1BQU07RUFDOUMsZUFDRSxDQUFDLG9FQUFvRSxFQUFFLEtBQUssSUFBSSxHQUFHLENBQUMsQ0FBQyxHQUNuRiwwRUFDQTtFQUVKLEVBQUUsV0FBVyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxXQUFXLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxJQUFJO0VBQ25ELElBQUk7SUFDRixPQUFPLE1BQU07RUFDZixTQUFVO0lBQ1IsTUFBTSxRQUFRLEVBQUUsV0FBVyxDQUFDLEdBQUcsQ0FBQyxNQUFNO0lBQ3RDLElBQUksU0FBUyxHQUFHLEVBQUUsV0FBVyxDQUFDLE1BQU0sQ0FBQztTQUNoQyxFQUFFLFdBQVcsQ0FBQyxHQUFHLENBQUMsR0FBRyxRQUFRO0VBQ3BDO0FBQ0Y7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Q0FjQyxHQUNELE9BQU8sU0FBUztFQUNkLE1BQU0sSUFBSTtFQUNWLElBQUksQ0FBQyxFQUFFLE1BQU0sRUFBRSxPQUFPO0VBQ3RCLE1BQU0sT0FBTyxJQUFJLElBQUk7T0FDaEIsRUFBRSxPQUFPO09BQ1QsRUFBRSxNQUFNLENBQUMsSUFBSTtPQUNiLEVBQUUsV0FBVyxDQUFDLElBQUk7R0FDdEI7RUFDRCxPQUFPO09BQUk7R0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQU0sRUFBRSxVQUFVLENBQUMsR0FBRyxDQUFDLE1BQU0sR0FBRyxJQUFJO0FBQzVEO0FBRUE7Ozs7Ozs7OztDQVNDLEdBQ0QsT0FBTyxTQUFTLGFBQWEsSUFBWTtFQUN2QyxNQUFNLElBQUkscUJBQXFCO0VBQy9CLElBQUksRUFBRSxNQUFNLEtBQUssR0FBRztFQUNwQixNQUFNLEVBQUUsTUFBTSxFQUFFLEdBQUc7RUFDbkIsT0FBTyxHQUFHLENBQUMsR0FBRyxDQUFDLE9BQU8sR0FBRyxDQUFDLE1BQU0sQ0FBQyxJQUFJO0FBQ3ZDO0FBRUE7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLFNBQVMsZUFBZSxJQUFZO0VBQ3pDLE1BQU0sSUFBSSxVQUFVO0VBQ3BCLE1BQU0sRUFBRSxNQUFNLEVBQUUsR0FBRztFQUNuQixNQUFNLFFBQVEsT0FBTyxHQUFHLENBQUM7RUFDekIsSUFBSSxVQUFVLFdBQVc7RUFDekIsSUFBSSxTQUFTLEdBQUcsT0FBTyxNQUFNLENBQUM7T0FDekIsT0FBTyxHQUFHLENBQUMsR0FBRyxRQUFRO0FBQzdCO0FBRUEsNkVBQTZFLEdBQzdFLE9BQU8sU0FBUztFQUNkLE1BQU0sTUFBTSxDQUFDLEtBQUs7QUFDcEI7QUFFQSx5RUFBeUUsR0FDekUsT0FBTyxTQUFTO0VBQ2QsT0FBTyxNQUFNLE1BQU07QUFDckI7QUFFQSxtRUFBbUUsR0FDbkUsT0FBTyxTQUFTO0VBQ2QsT0FBTztPQUFJLE1BQU0sT0FBTztHQUFDLENBQUMsSUFBSTtBQUNoQztBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUyxtQkFBbUIsSUFBWTtFQUM3QyxNQUFNLElBQUk7RUFDVixJQUFJLENBQUMsRUFBRSxNQUFNLEVBQUUsT0FBTztFQUN0QixNQUFNLElBQUksVUFBVTtFQUNwQixvRUFBb0U7RUFDcEUscUVBQXFFO0VBQ3JFLDRDQUE0QztFQUM1QyxPQUFPLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsTUFBTSxDQUFDLEdBQUcsQ0FBQztBQUMxQztBQUVBLDZFQUE2RSxHQUM3RSxTQUFTLGVBQWUsSUFBa0I7RUFDeEMsSUFBSSxLQUFLLElBQUksRUFBRSxPQUFPLEtBQUssSUFBSTtFQUMvQixPQUFPLEtBQUssS0FBSyxLQUFLLFlBQVkscUJBQXFCO0FBQ3pEO0FBRUE7Ozs7Ozs7Q0FPQyxHQUNELGVBQWUsa0JBQ2IsQ0FBNEIsRUFDNUIsSUFBa0I7RUFFbEIsTUFBTSxRQUFRLGVBQWU7RUFDN0IsTUFBTSxNQUFNLEdBQUcsS0FBSyxJQUFJLENBQUMsR0FBRyxFQUFFLE9BQU87RUFDckMsTUFBTSxPQUFPLENBQUMsRUFBRSxjQUFjLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJO0VBQ2hELEVBQUUsY0FBYyxDQUFDLEdBQUcsQ0FBQyxLQUFLO0VBQzFCLElBQUksT0FBTyxHQUFHO0VBQ2QsZUFDRSxDQUFDLGlDQUFpQyxFQUFFLEtBQUssSUFBSSxDQUFDLElBQUksRUFBRSxPQUFPLEdBQ3pELENBQUMsS0FBSyxNQUFNLEdBQUcsQ0FBQyxFQUFFLEVBQUUsS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDLEdBQUcsRUFBRSxJQUN2Qyx5RUFDQSwyRUFDQTtFQUVKLElBQUk7SUFDRixNQUFNLGNBQWM7TUFDbEIsT0FBTztNQUNQLE1BQU0sQ0FBQyxTQUFTLEVBQUUsS0FBSyxJQUFJLEVBQUU7TUFDN0IsU0FBUztNQUNULEdBQUksS0FBSyxJQUFJLEdBQUc7UUFBRSxNQUFNLEtBQUssSUFBSTtNQUFDLElBQUksQ0FBQyxDQUFDO01BQ3hDLEdBQUksS0FBSyxNQUFNLEdBQUc7UUFBRSxRQUFRLEtBQUssTUFBTTtNQUFDLElBQUksQ0FBQyxDQUFDO01BQzlDLFFBQVE7SUFDVjtFQUNGLEVBQUUsT0FBTTtFQUNOLGtFQUFrRTtFQUNwRTtBQUNGO0FBRUE7OztDQUdDLEdBQ0QsT0FBTyxTQUFTO0VBQ2QsTUFBTSxNQUE4QixDQUFDO0VBQ3JDLEtBQUssTUFBTSxPQUFPO09BQUksTUFBTSxjQUFjLENBQUMsSUFBSTtHQUFHLENBQUMsSUFBSSxHQUFJO0lBQ3pELEdBQUcsQ0FBQyxJQUFJLEdBQUcsTUFBTSxjQUFjLENBQUMsR0FBRyxDQUFDLFFBQVE7RUFDOUM7RUFDQSxPQUFPO0FBQ1Q7QUFFQSwyRUFBMkUsR0FDM0UsT0FBTyxTQUFTO0VBQ2QsSUFBSSxRQUFRO0VBQ1osS0FBSyxNQUFNLEtBQUssTUFBTSxjQUFjLENBQUMsTUFBTSxHQUFJLFNBQVM7RUFDeEQsT0FBTztBQUNUO0FBRUEsaURBQWlELEdBQ2pELE9BQU8sU0FBUztFQUNkLE1BQU0sY0FBYyxDQUFDLEtBQUs7QUFDNUI7QUFFQSxvRUFBb0UsR0FDcEUsZUFBZSxjQUNiLElBQVksRUFDWixJQUFZLEVBQ1osTUFBMEI7RUFFMUIsSUFBSTtJQUNGLE1BQU0sY0FBYztNQUNsQixPQUFPO01BQ1AsTUFBTSxDQUFDLFFBQVEsRUFBRSxNQUFNO01BQ3ZCLFNBQVM7TUFDVDtNQUNBLEdBQUksU0FBUztRQUFFO01BQU8sSUFBSSxDQUFDLENBQUM7TUFDNUIsUUFBUTtJQUNWO0VBQ0YsRUFBRSxPQUFNO0VBQ04sa0VBQWtFO0VBQ3BFO0FBQ0Y7QUFFQTs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW1CQyxHQUNELE9BQU8sZUFBZSx3QkFDcEIsSUFBdUI7RUFFdkIsTUFBTSxJQUFJO0VBQ1YsTUFBTSxPQUFPLG1CQUFtQjtFQUNoQywwREFBMEQ7RUFDMUQsSUFBSSxDQUFDLE1BQU07RUFFWCx3RUFBd0U7RUFDeEUsSUFBSSxDQUFDLEVBQUUsTUFBTSxFQUFFO0lBQ2IsTUFBTSxrQkFBa0IsR0FBRztJQUMzQjtFQUNGO0VBRUEsSUFBSSxLQUFLLEtBQUssS0FBSyxXQUFXO0lBQzVCLGVBQ0UsQ0FBQyxpREFBaUQsRUFBRSxLQUFLLElBQUksRUFBRSxHQUM3RCxDQUFDLEtBQUssTUFBTSxHQUFHLENBQUMsRUFBRSxFQUFFLEtBQUssTUFBTSxDQUFDLENBQUMsQ0FBQyxHQUFHLEVBQUUsSUFDdkM7SUFFSixNQUFNLGNBQWMsV0FBVyxLQUFLLElBQUksRUFBRSxLQUFLLE1BQU07SUFDckQsTUFBTSxJQUFJLCtCQUErQixLQUFLLElBQUksRUFBRSxLQUFLLE1BQU07RUFDakU7RUFFQSwwRUFBMEU7RUFDMUUsc0VBQXNFO0VBQ3RFLElBQUksQ0FBQyxLQUFLLElBQUksRUFBRTtFQUNoQixJQUFJLG1CQUFtQixLQUFLLElBQUksR0FBRztFQUVuQyxlQUNFLENBQUMsd0NBQXdDLEVBQUUsS0FBSyxJQUFJLENBQUMsSUFBSSxFQUFFLEtBQUssSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUNyRSxDQUFDLHdCQUF3QixFQUFFLHdCQUF3QixJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7RUFFcEUsTUFBTSxjQUFjLEtBQUssSUFBSSxFQUFFLEtBQUssSUFBSSxFQUFFLEtBQUssTUFBTTtFQUNyRCxNQUFNLElBQUksc0JBQXNCLEtBQUssSUFBSSxFQUFFLEtBQUssSUFBSTtBQUN0RDtBQUVBOzs7Q0FHQyxHQUNELE9BQU8sU0FBUyw0QkFDZCxLQUF1RDtFQUV2RCxJQUFJLE1BQU0sTUFBTSxFQUFFLGdCQUFnQixNQUFNLE1BQU07RUFDOUMsSUFBSSxNQUFNLEdBQUcsRUFBRSxpQkFBaUIsTUFBTSxHQUFHO0FBQzNDO0FBRUEsdURBQXVELEdBQ3ZELE9BQU8sU0FBUztFQUNkLGdCQUFnQjtFQUNoQixpQkFBaUIsQ0FBQyxJQUFNLFFBQVEsS0FBSyxDQUFDO0FBQ3hDIn0=
// denoCacheMetadata=15778748495688858339,4158979598849249963