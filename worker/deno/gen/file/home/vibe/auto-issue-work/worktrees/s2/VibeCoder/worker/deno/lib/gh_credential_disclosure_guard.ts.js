/**
 * Credential *reads* the agent subprocess may not make (Issue #1371).
 *
 * Every control the agent-side `gh` guard enforces — the write-repo allowlist,
 * the reserved-label denylist, the claimed-issue lifecycle guard, the body
 * redaction — is reached by classifying the argument vector of a `gh` call.
 * That is a containment boundary around the *channel*, and it holds only for
 * as long as the channel is the agent's only way to reach GitHub. The guard's
 * own residual-risk note says so plainly: an agent that talks to the REST API
 * directly never re-enters the classifier at all.
 *
 * What made that residual risk reachable through the guarded channel was a
 * pair of commands the guard classified as harmless reads. `gh auth token`
 * and `gh auth status --show-token` print the run's GitHub credential in
 * plaintext, and `gh_local_state_guard.ts` deliberately let them through
 * ("`status` and `token` are reads and stay allowed") because neither changes
 * anything — on GitHub or locally. But the value they return is precisely the
 * one that makes every later call unguarded, so the guard was handing out its
 * own bypass on request.
 *
 * They are therefore refused, whether or not the write-repo allowlist is
 * active. Nothing in a run needs them: the worker authenticates its own `gh`
 * subprocesses from `gh_spawn.ts` and checks token health with
 * `ensureValidToken` or a plain `gh auth status`, and the agent authenticates
 * from the `GH_CONFIG_DIR` the wrapper pins for it — it never has to see the
 * secret to use it. Plain `gh auth status` stays allowed, so the health checks
 * that read it are untouched.
 *
 * **This narrows the boundary; it does not close it.** An agent with
 * filesystem read access to the pinned `GH_CONFIG_DIR` still shares the host's
 * credentials, and no argv classifier can change that. The durable fix remains
 * the one `gh_guard_shim.ts` names — a per-run token scoped to the target repo,
 * so that what leaks is worth less. Refusing the disclosure removes the
 * supported, one-command way to obtain it.
 *
 * Pure by design — it runs inside the guard's short-lived child process, which
 * has no permissions beyond reading a named body file.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { ghRootCommand, ghSubVerb } from "./audit_mutation_classifier.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";
/**
 * The flag that turns `gh auth status` from a health check into a credential
 * dump, in its long spelling.
 */ const SHOW_TOKEN_FLAG = "--show-token";
/** The shorthand for {@link SHOW_TOKEN_FLAG}. */ const SHOW_TOKEN_SHORTHAND = "t";
/**
 * Shorthand letters of `gh auth status` that take a value, and so end a
 * shorthand group by swallowing the rest of the token.
 *
 * pflag hands the remainder of a group to the first value-taking flag in it,
 * so `-ht github.com` is `--hostname t`, not `--hostname --show-token`. Only
 * `-h`/`--hostname` behaves that way on this subcommand; `-a`/`--active` and
 * `-t`/`--show-token` are booleans and are walked through.
 */ const VALUE_SHORTHANDS = new Set([
  "h"
]);
/**
 * Whether a `gh auth status` argument vector asks for the token.
 *
 * Matches `--show-token`, `--show-token=<anything>` and the `-t` shorthand,
 * including inside a shorthand group (`-at`). A `--show-token=false` is
 * matched too: over-refusing a spelling nobody writes is the safe direction,
 * and the plain command is right there.
 *
 * @param args - Normalised arguments, root and verb included.
 * @returns true when the vector would print the credential.
 */ function asksForToken(args) {
  for (const arg of args){
    if (arg === SHOW_TOKEN_FLAG || arg.startsWith(`${SHOW_TOKEN_FLAG}=`)) {
      return true;
    }
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 2) {
      continue;
    }
    for (const letter of arg.slice(1)){
      if (letter === SHOW_TOKEN_SHORTHAND) return true;
      if (VALUE_SHORTHANDS.has(letter)) break;
    }
  }
  return false;
}
/**
 * Classify a `gh` argument vector as a credential disclosure.
 *
 * @param rawArgs - Arguments about to be passed to the `gh` binary.
 * @returns The disclosure, or `undefined` when the command prints no
 *   credential (every other command, plain `gh auth status` included).
 */ export function classifyGhCredentialDisclosure(rawArgs) {
  // Issue #3867: the attached shorthand spellings are rewritten to their
  // separated form first, so the root/verb scan sees the one spelling.
  const args = normaliseGhArgs(rawArgs);
  if (ghRootCommand(args)?.toLowerCase() !== "auth") return undefined;
  const verb = ghSubVerb(args)?.toLowerCase();
  if (verb === "token") {
    return {
      root: "auth",
      verb: "token",
      disclosed: "the run's GitHub token"
    };
  }
  if (verb === "status" && asksForToken(args)) {
    return {
      root: "auth",
      verb: "status",
      disclosed: "the run's GitHub token"
    };
  }
  return undefined;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9jcmVkZW50aWFsX2Rpc2Nsb3N1cmVfZ3VhcmQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDcmVkZW50aWFsICpyZWFkcyogdGhlIGFnZW50IHN1YnByb2Nlc3MgbWF5IG5vdCBtYWtlIChJc3N1ZSAjMTM3MSkuXG4gKlxuICogRXZlcnkgY29udHJvbCB0aGUgYWdlbnQtc2lkZSBgZ2hgIGd1YXJkIGVuZm9yY2VzIOKAlCB0aGUgd3JpdGUtcmVwbyBhbGxvd2xpc3QsXG4gKiB0aGUgcmVzZXJ2ZWQtbGFiZWwgZGVueWxpc3QsIHRoZSBjbGFpbWVkLWlzc3VlIGxpZmVjeWNsZSBndWFyZCwgdGhlIGJvZHlcbiAqIHJlZGFjdGlvbiDigJQgaXMgcmVhY2hlZCBieSBjbGFzc2lmeWluZyB0aGUgYXJndW1lbnQgdmVjdG9yIG9mIGEgYGdoYCBjYWxsLlxuICogVGhhdCBpcyBhIGNvbnRhaW5tZW50IGJvdW5kYXJ5IGFyb3VuZCB0aGUgKmNoYW5uZWwqLCBhbmQgaXQgaG9sZHMgb25seSBmb3JcbiAqIGFzIGxvbmcgYXMgdGhlIGNoYW5uZWwgaXMgdGhlIGFnZW50J3Mgb25seSB3YXkgdG8gcmVhY2ggR2l0SHViLiBUaGUgZ3VhcmQnc1xuICogb3duIHJlc2lkdWFsLXJpc2sgbm90ZSBzYXlzIHNvIHBsYWlubHk6IGFuIGFnZW50IHRoYXQgdGFsa3MgdG8gdGhlIFJFU1QgQVBJXG4gKiBkaXJlY3RseSBuZXZlciByZS1lbnRlcnMgdGhlIGNsYXNzaWZpZXIgYXQgYWxsLlxuICpcbiAqIFdoYXQgbWFkZSB0aGF0IHJlc2lkdWFsIHJpc2sgcmVhY2hhYmxlIHRocm91Z2ggdGhlIGd1YXJkZWQgY2hhbm5lbCB3YXMgYVxuICogcGFpciBvZiBjb21tYW5kcyB0aGUgZ3VhcmQgY2xhc3NpZmllZCBhcyBoYXJtbGVzcyByZWFkcy4gYGdoIGF1dGggdG9rZW5gXG4gKiBhbmQgYGdoIGF1dGggc3RhdHVzIC0tc2hvdy10b2tlbmAgcHJpbnQgdGhlIHJ1bidzIEdpdEh1YiBjcmVkZW50aWFsIGluXG4gKiBwbGFpbnRleHQsIGFuZCBgZ2hfbG9jYWxfc3RhdGVfZ3VhcmQudHNgIGRlbGliZXJhdGVseSBsZXQgdGhlbSB0aHJvdWdoXG4gKiAoXCJgc3RhdHVzYCBhbmQgYHRva2VuYCBhcmUgcmVhZHMgYW5kIHN0YXkgYWxsb3dlZFwiKSBiZWNhdXNlIG5laXRoZXIgY2hhbmdlc1xuICogYW55dGhpbmcg4oCUIG9uIEdpdEh1YiBvciBsb2NhbGx5LiBCdXQgdGhlIHZhbHVlIHRoZXkgcmV0dXJuIGlzIHByZWNpc2VseSB0aGVcbiAqIG9uZSB0aGF0IG1ha2VzIGV2ZXJ5IGxhdGVyIGNhbGwgdW5ndWFyZGVkLCBzbyB0aGUgZ3VhcmQgd2FzIGhhbmRpbmcgb3V0IGl0c1xuICogb3duIGJ5cGFzcyBvbiByZXF1ZXN0LlxuICpcbiAqIFRoZXkgYXJlIHRoZXJlZm9yZSByZWZ1c2VkLCB3aGV0aGVyIG9yIG5vdCB0aGUgd3JpdGUtcmVwbyBhbGxvd2xpc3QgaXNcbiAqIGFjdGl2ZS4gTm90aGluZyBpbiBhIHJ1biBuZWVkcyB0aGVtOiB0aGUgd29ya2VyIGF1dGhlbnRpY2F0ZXMgaXRzIG93biBgZ2hgXG4gKiBzdWJwcm9jZXNzZXMgZnJvbSBgZ2hfc3Bhd24udHNgIGFuZCBjaGVja3MgdG9rZW4gaGVhbHRoIHdpdGhcbiAqIGBlbnN1cmVWYWxpZFRva2VuYCBvciBhIHBsYWluIGBnaCBhdXRoIHN0YXR1c2AsIGFuZCB0aGUgYWdlbnQgYXV0aGVudGljYXRlc1xuICogZnJvbSB0aGUgYEdIX0NPTkZJR19ESVJgIHRoZSB3cmFwcGVyIHBpbnMgZm9yIGl0IOKAlCBpdCBuZXZlciBoYXMgdG8gc2VlIHRoZVxuICogc2VjcmV0IHRvIHVzZSBpdC4gUGxhaW4gYGdoIGF1dGggc3RhdHVzYCBzdGF5cyBhbGxvd2VkLCBzbyB0aGUgaGVhbHRoIGNoZWNrc1xuICogdGhhdCByZWFkIGl0IGFyZSB1bnRvdWNoZWQuXG4gKlxuICogKipUaGlzIG5hcnJvd3MgdGhlIGJvdW5kYXJ5OyBpdCBkb2VzIG5vdCBjbG9zZSBpdC4qKiBBbiBhZ2VudCB3aXRoXG4gKiBmaWxlc3lzdGVtIHJlYWQgYWNjZXNzIHRvIHRoZSBwaW5uZWQgYEdIX0NPTkZJR19ESVJgIHN0aWxsIHNoYXJlcyB0aGUgaG9zdCdzXG4gKiBjcmVkZW50aWFscywgYW5kIG5vIGFyZ3YgY2xhc3NpZmllciBjYW4gY2hhbmdlIHRoYXQuIFRoZSBkdXJhYmxlIGZpeCByZW1haW5zXG4gKiB0aGUgb25lIGBnaF9ndWFyZF9zaGltLnRzYCBuYW1lcyDigJQgYSBwZXItcnVuIHRva2VuIHNjb3BlZCB0byB0aGUgdGFyZ2V0IHJlcG8sXG4gKiBzbyB0aGF0IHdoYXQgbGVha3MgaXMgd29ydGggbGVzcy4gUmVmdXNpbmcgdGhlIGRpc2Nsb3N1cmUgcmVtb3ZlcyB0aGVcbiAqIHN1cHBvcnRlZCwgb25lLWNvbW1hbmQgd2F5IHRvIG9idGFpbiBpdC5cbiAqXG4gKiBQdXJlIGJ5IGRlc2lnbiDigJQgaXQgcnVucyBpbnNpZGUgdGhlIGd1YXJkJ3Mgc2hvcnQtbGl2ZWQgY2hpbGQgcHJvY2Vzcywgd2hpY2hcbiAqIGhhcyBubyBwZXJtaXNzaW9ucyBiZXlvbmQgcmVhZGluZyBhIG5hbWVkIGJvZHkgZmlsZS5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgeyBnaFJvb3RDb21tYW5kLCBnaFN1YlZlcmIgfSBmcm9tIFwiLi9hdWRpdF9tdXRhdGlvbl9jbGFzc2lmaWVyLnRzXCI7XG5pbXBvcnQgeyBub3JtYWxpc2VHaEFyZ3MgfSBmcm9tIFwiLi9naF9mbGFnX3BhcnNlci50c1wiO1xuXG4vKipcbiAqIFRoZSBmbGFnIHRoYXQgdHVybnMgYGdoIGF1dGggc3RhdHVzYCBmcm9tIGEgaGVhbHRoIGNoZWNrIGludG8gYSBjcmVkZW50aWFsXG4gKiBkdW1wLCBpbiBpdHMgbG9uZyBzcGVsbGluZy5cbiAqL1xuY29uc3QgU0hPV19UT0tFTl9GTEFHID0gXCItLXNob3ctdG9rZW5cIjtcblxuLyoqIFRoZSBzaG9ydGhhbmQgZm9yIHtAbGluayBTSE9XX1RPS0VOX0ZMQUd9LiAqL1xuY29uc3QgU0hPV19UT0tFTl9TSE9SVEhBTkQgPSBcInRcIjtcblxuLyoqXG4gKiBTaG9ydGhhbmQgbGV0dGVycyBvZiBgZ2ggYXV0aCBzdGF0dXNgIHRoYXQgdGFrZSBhIHZhbHVlLCBhbmQgc28gZW5kIGFcbiAqIHNob3J0aGFuZCBncm91cCBieSBzd2FsbG93aW5nIHRoZSByZXN0IG9mIHRoZSB0b2tlbi5cbiAqXG4gKiBwZmxhZyBoYW5kcyB0aGUgcmVtYWluZGVyIG9mIGEgZ3JvdXAgdG8gdGhlIGZpcnN0IHZhbHVlLXRha2luZyBmbGFnIGluIGl0LFxuICogc28gYC1odCBnaXRodWIuY29tYCBpcyBgLS1ob3N0bmFtZSB0YCwgbm90IGAtLWhvc3RuYW1lIC0tc2hvdy10b2tlbmAuIE9ubHlcbiAqIGAtaGAvYC0taG9zdG5hbWVgIGJlaGF2ZXMgdGhhdCB3YXkgb24gdGhpcyBzdWJjb21tYW5kOyBgLWFgL2AtLWFjdGl2ZWAgYW5kXG4gKiBgLXRgL2AtLXNob3ctdG9rZW5gIGFyZSBib29sZWFucyBhbmQgYXJlIHdhbGtlZCB0aHJvdWdoLlxuICovXG5jb25zdCBWQUxVRV9TSE9SVEhBTkRTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXCJoXCJdKTtcblxuLyoqIE9uZSBjbGFzc2lmaWVkIGF0dGVtcHQgdG8gcmVhZCB0aGUgcnVuJ3MgR2l0SHViIGNyZWRlbnRpYWwuICovXG5leHBvcnQgaW50ZXJmYWNlIEdoQ3JlZGVudGlhbERpc2Nsb3N1cmUge1xuICAvKiogQ2Fub25pY2FsIHJvb3QgY29tbWFuZCDigJQgYWx3YXlzIGBhdXRoYC4gKi9cbiAgcm9vdDogc3RyaW5nO1xuICAvKiogVGhlIHN1Yi12ZXJiIGFzIHNwZWxsZWQgb24gdGhlIGNvbW1hbmQgbGluZSDigJQgYHRva2VuYCBvciBgc3RhdHVzYC4gKi9cbiAgdmVyYjogc3RyaW5nO1xuICAvKiogV2hhdCB0aGUgY29tbWFuZCB3b3VsZCBwcmludCwgZm9yIHRoZSByZWZ1c2FsIG1lc3NhZ2UuICovXG4gIGRpc2Nsb3NlZDogc3RyaW5nO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgYSBgZ2ggYXV0aCBzdGF0dXNgIGFyZ3VtZW50IHZlY3RvciBhc2tzIGZvciB0aGUgdG9rZW4uXG4gKlxuICogTWF0Y2hlcyBgLS1zaG93LXRva2VuYCwgYC0tc2hvdy10b2tlbj08YW55dGhpbmc+YCBhbmQgdGhlIGAtdGAgc2hvcnRoYW5kLFxuICogaW5jbHVkaW5nIGluc2lkZSBhIHNob3J0aGFuZCBncm91cCAoYC1hdGApLiBBIGAtLXNob3ctdG9rZW49ZmFsc2VgIGlzXG4gKiBtYXRjaGVkIHRvbzogb3Zlci1yZWZ1c2luZyBhIHNwZWxsaW5nIG5vYm9keSB3cml0ZXMgaXMgdGhlIHNhZmUgZGlyZWN0aW9uLFxuICogYW5kIHRoZSBwbGFpbiBjb21tYW5kIGlzIHJpZ2h0IHRoZXJlLlxuICpcbiAqIEBwYXJhbSBhcmdzIC0gTm9ybWFsaXNlZCBhcmd1bWVudHMsIHJvb3QgYW5kIHZlcmIgaW5jbHVkZWQuXG4gKiBAcmV0dXJucyB0cnVlIHdoZW4gdGhlIHZlY3RvciB3b3VsZCBwcmludCB0aGUgY3JlZGVudGlhbC5cbiAqL1xuZnVuY3Rpb24gYXNrc0ZvclRva2VuKGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIGZvciAoY29uc3QgYXJnIG9mIGFyZ3MpIHtcbiAgICBpZiAoYXJnID09PSBTSE9XX1RPS0VOX0ZMQUcgfHwgYXJnLnN0YXJ0c1dpdGgoYCR7U0hPV19UT0tFTl9GTEFHfT1gKSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGlmIChhcmcgPT09IFwiLS1cIikgYnJlYWs7XG4gICAgaWYgKCFhcmcuc3RhcnRzV2l0aChcIi1cIikgfHwgYXJnLnN0YXJ0c1dpdGgoXCItLVwiKSB8fCBhcmcubGVuZ3RoIDwgMikge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGZvciAoY29uc3QgbGV0dGVyIG9mIGFyZy5zbGljZSgxKSkge1xuICAgICAgaWYgKGxldHRlciA9PT0gU0hPV19UT0tFTl9TSE9SVEhBTkQpIHJldHVybiB0cnVlO1xuICAgICAgaWYgKFZBTFVFX1NIT1JUSEFORFMuaGFzKGxldHRlcikpIGJyZWFrO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogQ2xhc3NpZnkgYSBgZ2hgIGFyZ3VtZW50IHZlY3RvciBhcyBhIGNyZWRlbnRpYWwgZGlzY2xvc3VyZS5cbiAqXG4gKiBAcGFyYW0gcmF3QXJncyAtIEFyZ3VtZW50cyBhYm91dCB0byBiZSBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICogQHJldHVybnMgVGhlIGRpc2Nsb3N1cmUsIG9yIGB1bmRlZmluZWRgIHdoZW4gdGhlIGNvbW1hbmQgcHJpbnRzIG5vXG4gKiAgIGNyZWRlbnRpYWwgKGV2ZXJ5IG90aGVyIGNvbW1hbmQsIHBsYWluIGBnaCBhdXRoIHN0YXR1c2AgaW5jbHVkZWQpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhc3NpZnlHaENyZWRlbnRpYWxEaXNjbG9zdXJlKFxuICByYXdBcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbik6IEdoQ3JlZGVudGlhbERpc2Nsb3N1cmUgfCB1bmRlZmluZWQge1xuICAvLyBJc3N1ZSAjMzg2NzogdGhlIGF0dGFjaGVkIHNob3J0aGFuZCBzcGVsbGluZ3MgYXJlIHJld3JpdHRlbiB0byB0aGVpclxuICAvLyBzZXBhcmF0ZWQgZm9ybSBmaXJzdCwgc28gdGhlIHJvb3QvdmVyYiBzY2FuIHNlZXMgdGhlIG9uZSBzcGVsbGluZy5cbiAgY29uc3QgYXJncyA9IG5vcm1hbGlzZUdoQXJncyhyYXdBcmdzKTtcbiAgaWYgKGdoUm9vdENvbW1hbmQoYXJncyk/LnRvTG93ZXJDYXNlKCkgIT09IFwiYXV0aFwiKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHZlcmIgPSBnaFN1YlZlcmIoYXJncyk/LnRvTG93ZXJDYXNlKCk7XG4gIGlmICh2ZXJiID09PSBcInRva2VuXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgcm9vdDogXCJhdXRoXCIsXG4gICAgICB2ZXJiOiBcInRva2VuXCIsXG4gICAgICBkaXNjbG9zZWQ6IFwidGhlIHJ1bidzIEdpdEh1YiB0b2tlblwiLFxuICAgIH07XG4gIH1cbiAgaWYgKHZlcmIgPT09IFwic3RhdHVzXCIgJiYgYXNrc0ZvclRva2VuKGFyZ3MpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHJvb3Q6IFwiYXV0aFwiLFxuICAgICAgdmVyYjogXCJzdGF0dXNcIixcbiAgICAgIGRpc2Nsb3NlZDogXCJ0aGUgcnVuJ3MgR2l0SHViIHRva2VuXCIsXG4gICAgfTtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1Q0MsR0FFRCxTQUFTLGFBQWEsRUFBRSxTQUFTLFFBQVEsaUNBQWlDO0FBQzFFLFNBQVMsZUFBZSxRQUFRLHNCQUFzQjtBQUV0RDs7O0NBR0MsR0FDRCxNQUFNLGtCQUFrQjtBQUV4QiwrQ0FBK0MsR0FDL0MsTUFBTSx1QkFBdUI7QUFFN0I7Ozs7Ozs7O0NBUUMsR0FDRCxNQUFNLG1CQUF3QyxJQUFJLElBQUk7RUFBQztDQUFJO0FBWTNEOzs7Ozs7Ozs7O0NBVUMsR0FDRCxTQUFTLGFBQWEsSUFBdUI7RUFDM0MsS0FBSyxNQUFNLE9BQU8sS0FBTTtJQUN0QixJQUFJLFFBQVEsbUJBQW1CLElBQUksVUFBVSxDQUFDLEdBQUcsZ0JBQWdCLENBQUMsQ0FBQyxHQUFHO01BQ3BFLE9BQU87SUFDVDtJQUNBLElBQUksUUFBUSxNQUFNO0lBQ2xCLElBQUksQ0FBQyxJQUFJLFVBQVUsQ0FBQyxRQUFRLElBQUksVUFBVSxDQUFDLFNBQVMsSUFBSSxNQUFNLEdBQUcsR0FBRztNQUNsRTtJQUNGO0lBQ0EsS0FBSyxNQUFNLFVBQVUsSUFBSSxLQUFLLENBQUMsR0FBSTtNQUNqQyxJQUFJLFdBQVcsc0JBQXNCLE9BQU87TUFDNUMsSUFBSSxpQkFBaUIsR0FBRyxDQUFDLFNBQVM7SUFDcEM7RUFDRjtFQUNBLE9BQU87QUFDVDtBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUywrQkFDZCxPQUEwQjtFQUUxQix1RUFBdUU7RUFDdkUscUVBQXFFO0VBQ3JFLE1BQU0sT0FBTyxnQkFBZ0I7RUFDN0IsSUFBSSxjQUFjLE9BQU8sa0JBQWtCLFFBQVEsT0FBTztFQUUxRCxNQUFNLE9BQU8sVUFBVSxPQUFPO0VBQzlCLElBQUksU0FBUyxTQUFTO0lBQ3BCLE9BQU87TUFDTCxNQUFNO01BQ04sTUFBTTtNQUNOLFdBQVc7SUFDYjtFQUNGO0VBQ0EsSUFBSSxTQUFTLFlBQVksYUFBYSxPQUFPO0lBQzNDLE9BQU87TUFDTCxNQUFNO01BQ04sTUFBTTtNQUNOLFdBQVc7SUFDYjtFQUNGO0VBQ0EsT0FBTztBQUNUIn0=
// denoCacheMetadata=17213094974292315780,7403060015079538683