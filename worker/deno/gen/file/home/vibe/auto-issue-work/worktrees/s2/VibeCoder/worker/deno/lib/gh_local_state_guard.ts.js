/**
 * Local `gh` state changes the agent subprocess may not make (Issue #187).
 *
 * `classifyGhMutation` classifies commands that change state **on GitHub**.
 * Commands that rewrite the local `gh` installation instead — the credential
 * store, the config file, the alias table, the installed extensions — carry
 * none of its mutating sub-verbs (`login`, `logout`, `switch`, `setup-git`,
 * `refresh`, `install`, …), so they classified as plain reads and
 * {@link evaluateGhCommand} waved them through with `allowed: true`.
 *
 * That is a hole in the containment boundary, not a read:
 *
 * - The wrapper pins `GH_CONFIG_DIR` to the worker's own persistent identity
 *   directory, so a credential the agent writes there outlives the spawn that
 *   wrote it. An injected credential login re-points every later `gh` call —
 *   the worker's included — at an attacker's account.
 * - `setup-git` rewrites the git credential helper, carrying the same
 *   redirection into `git push`.
 * - A config, alias or extension write changes what a later `gh <name>` runs.
 *   The guard already refuses to *run* an alias or an extension (Issue #3866,
 *   `GH_UNKNOWN_COMMAND`) precisely because it cannot see the real command;
 *   refusing to *write* one closes the same gap at the other end.
 *
 * None of these has a legitimate use during a run: credentials are provisioned
 * once, non-interactively, by `setup.sh` (see `credential_preflight.ts`) and
 * consumed read-only — the same unattended-operation invariant
 * `interactive_login_scanner.ts` holds the worker's own source to, applied here
 * at the runtime guard. Read verbs (`gh auth status`, `gh config get`,
 * `gh alias list`, `gh extension list`) are untouched; the worker's own health
 * checks depend on them. The one read that is not benign — `gh auth token`,
 * which prints the credential rather than rewriting it — is refused by
 * `gh_credential_disclosure_guard.ts` (Issue #1371) instead.
 *
 * Pure by design — it runs inside the guard's short-lived child process.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { GH_EXTENSION_ROOTS, ghRootCommand, ghSubVerb } from "./audit_mutation_classifier.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";
/**
 * Sub-verbs that rewrite local `gh` state, per root command.
 *
 * A positive denylist rather than "everything but the known reads": a future
 * `gh` release adding a read verb must not be refused, and the roots here are
 * small and stable. Every verb listed writes to `GH_CONFIG_DIR` (or, for
 * `setup-git`, to the git config it points at).
 */ export const GH_LOCAL_STATE_VERBS = {
  // Credential store. `status` is a read and stays allowed; `token` — and
  // `status --show-token` — is a credential disclosure refused separately
  // by `gh_credential_disclosure_guard.ts` (Issue #1371).
  auth: new Set([
    "login",
    "logout",
    "switch",
    "refresh",
    "setup-git"
  ]),
  // Config file. `get` and `list` are reads.
  config: new Set([
    "set",
    "clear-cache"
  ]),
  // Alias table — what a later `gh <name>` expands to.
  alias: new Set([
    "set",
    "delete",
    "import"
  ]),
  // Installed extensions — what a later `gh <name>` executes. `exec` runs one
  // directly, which is the same unseen command by another spelling.
  extension: new Set([
    "install",
    "upgrade",
    "remove",
    "exec"
  ])
};
/** `gh` root commands whose local-state verbs are denied to the agent. */ const GUARDED_ROOTS = {
  auth: "the credential store",
  config: "the gh configuration",
  alias: "the alias table",
  extension: "the installed extensions"
};
/**
 * Normalise a root spelling to its canonical form.
 *
 * The `gh extension` aliases come from {@link GH_EXTENSION_ROOTS} rather than
 * a second copy kept here (Issue #1396) — one list of the spellings the real
 * binary accepts, so the guard and the mutation classifier cannot drift into
 * refusing `gh ext install` in one and waving it through in the other.
 */ function canonicalRoot(root) {
  return GH_EXTENSION_ROOTS.has(root) ? "extension" : root;
}
/**
 * Classify a `gh` argument vector as a local-state rewrite.
 *
 * @param args - Arguments about to be passed to the `gh` binary.
 * @returns The change, or `undefined` when the command rewrites no local `gh`
 *   state (a read, or any other root command).
 */ export function classifyGhLocalStateChange(rawArgs) {
  // Issue #3867: pflag's attached shorthand spellings are rewritten to their
  // separated form first, so the root/verb scan sees the one spelling.
  const args = normaliseGhArgs(rawArgs);
  const rawRoot = ghRootCommand(args)?.toLowerCase();
  if (rawRoot === undefined) return undefined;
  const root = canonicalRoot(rawRoot);
  const target = GUARDED_ROOTS[root];
  if (target === undefined) return undefined;
  const verb = ghSubVerb(args);
  if (verb === undefined) return undefined;
  if (!GH_LOCAL_STATE_VERBS[root]?.has(verb.toLowerCase())) return undefined;
  return {
    root,
    verb,
    target
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9sb2NhbF9zdGF0ZV9ndWFyZC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIExvY2FsIGBnaGAgc3RhdGUgY2hhbmdlcyB0aGUgYWdlbnQgc3VicHJvY2VzcyBtYXkgbm90IG1ha2UgKElzc3VlICMxODcpLlxuICpcbiAqIGBjbGFzc2lmeUdoTXV0YXRpb25gIGNsYXNzaWZpZXMgY29tbWFuZHMgdGhhdCBjaGFuZ2Ugc3RhdGUgKipvbiBHaXRIdWIqKi5cbiAqIENvbW1hbmRzIHRoYXQgcmV3cml0ZSB0aGUgbG9jYWwgYGdoYCBpbnN0YWxsYXRpb24gaW5zdGVhZCDigJQgdGhlIGNyZWRlbnRpYWxcbiAqIHN0b3JlLCB0aGUgY29uZmlnIGZpbGUsIHRoZSBhbGlhcyB0YWJsZSwgdGhlIGluc3RhbGxlZCBleHRlbnNpb25zIOKAlCBjYXJyeVxuICogbm9uZSBvZiBpdHMgbXV0YXRpbmcgc3ViLXZlcmJzIChgbG9naW5gLCBgbG9nb3V0YCwgYHN3aXRjaGAsIGBzZXR1cC1naXRgLFxuICogYHJlZnJlc2hgLCBgaW5zdGFsbGAsIOKApiksIHNvIHRoZXkgY2xhc3NpZmllZCBhcyBwbGFpbiByZWFkcyBhbmRcbiAqIHtAbGluayBldmFsdWF0ZUdoQ29tbWFuZH0gd2F2ZWQgdGhlbSB0aHJvdWdoIHdpdGggYGFsbG93ZWQ6IHRydWVgLlxuICpcbiAqIFRoYXQgaXMgYSBob2xlIGluIHRoZSBjb250YWlubWVudCBib3VuZGFyeSwgbm90IGEgcmVhZDpcbiAqXG4gKiAtIFRoZSB3cmFwcGVyIHBpbnMgYEdIX0NPTkZJR19ESVJgIHRvIHRoZSB3b3JrZXIncyBvd24gcGVyc2lzdGVudCBpZGVudGl0eVxuICogICBkaXJlY3RvcnksIHNvIGEgY3JlZGVudGlhbCB0aGUgYWdlbnQgd3JpdGVzIHRoZXJlIG91dGxpdmVzIHRoZSBzcGF3biB0aGF0XG4gKiAgIHdyb3RlIGl0LiBBbiBpbmplY3RlZCBjcmVkZW50aWFsIGxvZ2luIHJlLXBvaW50cyBldmVyeSBsYXRlciBgZ2hgIGNhbGwg4oCUXG4gKiAgIHRoZSB3b3JrZXIncyBpbmNsdWRlZCDigJQgYXQgYW4gYXR0YWNrZXIncyBhY2NvdW50LlxuICogLSBgc2V0dXAtZ2l0YCByZXdyaXRlcyB0aGUgZ2l0IGNyZWRlbnRpYWwgaGVscGVyLCBjYXJyeWluZyB0aGUgc2FtZVxuICogICByZWRpcmVjdGlvbiBpbnRvIGBnaXQgcHVzaGAuXG4gKiAtIEEgY29uZmlnLCBhbGlhcyBvciBleHRlbnNpb24gd3JpdGUgY2hhbmdlcyB3aGF0IGEgbGF0ZXIgYGdoIDxuYW1lPmAgcnVucy5cbiAqICAgVGhlIGd1YXJkIGFscmVhZHkgcmVmdXNlcyB0byAqcnVuKiBhbiBhbGlhcyBvciBhbiBleHRlbnNpb24gKElzc3VlICMzODY2LFxuICogICBgR0hfVU5LTk9XTl9DT01NQU5EYCkgcHJlY2lzZWx5IGJlY2F1c2UgaXQgY2Fubm90IHNlZSB0aGUgcmVhbCBjb21tYW5kO1xuICogICByZWZ1c2luZyB0byAqd3JpdGUqIG9uZSBjbG9zZXMgdGhlIHNhbWUgZ2FwIGF0IHRoZSBvdGhlciBlbmQuXG4gKlxuICogTm9uZSBvZiB0aGVzZSBoYXMgYSBsZWdpdGltYXRlIHVzZSBkdXJpbmcgYSBydW46IGNyZWRlbnRpYWxzIGFyZSBwcm92aXNpb25lZFxuICogb25jZSwgbm9uLWludGVyYWN0aXZlbHksIGJ5IGBzZXR1cC5zaGAgKHNlZSBgY3JlZGVudGlhbF9wcmVmbGlnaHQudHNgKSBhbmRcbiAqIGNvbnN1bWVkIHJlYWQtb25seSDigJQgdGhlIHNhbWUgdW5hdHRlbmRlZC1vcGVyYXRpb24gaW52YXJpYW50XG4gKiBgaW50ZXJhY3RpdmVfbG9naW5fc2Nhbm5lci50c2AgaG9sZHMgdGhlIHdvcmtlcidzIG93biBzb3VyY2UgdG8sIGFwcGxpZWQgaGVyZVxuICogYXQgdGhlIHJ1bnRpbWUgZ3VhcmQuIFJlYWQgdmVyYnMgKGBnaCBhdXRoIHN0YXR1c2AsIGBnaCBjb25maWcgZ2V0YCxcbiAqIGBnaCBhbGlhcyBsaXN0YCwgYGdoIGV4dGVuc2lvbiBsaXN0YCkgYXJlIHVudG91Y2hlZDsgdGhlIHdvcmtlcidzIG93biBoZWFsdGhcbiAqIGNoZWNrcyBkZXBlbmQgb24gdGhlbS4gVGhlIG9uZSByZWFkIHRoYXQgaXMgbm90IGJlbmlnbiDigJQgYGdoIGF1dGggdG9rZW5gLFxuICogd2hpY2ggcHJpbnRzIHRoZSBjcmVkZW50aWFsIHJhdGhlciB0aGFuIHJld3JpdGluZyBpdCDigJQgaXMgcmVmdXNlZCBieVxuICogYGdoX2NyZWRlbnRpYWxfZGlzY2xvc3VyZV9ndWFyZC50c2AgKElzc3VlICMxMzcxKSBpbnN0ZWFkLlxuICpcbiAqIFB1cmUgYnkgZGVzaWduIOKAlCBpdCBydW5zIGluc2lkZSB0aGUgZ3VhcmQncyBzaG9ydC1saXZlZCBjaGlsZCBwcm9jZXNzLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7XG4gIEdIX0VYVEVOU0lPTl9ST09UUyxcbiAgZ2hSb290Q29tbWFuZCxcbiAgZ2hTdWJWZXJiLFxufSBmcm9tIFwiLi9hdWRpdF9tdXRhdGlvbl9jbGFzc2lmaWVyLnRzXCI7XG5pbXBvcnQgeyBub3JtYWxpc2VHaEFyZ3MgfSBmcm9tIFwiLi9naF9mbGFnX3BhcnNlci50c1wiO1xuXG4vKipcbiAqIFN1Yi12ZXJicyB0aGF0IHJld3JpdGUgbG9jYWwgYGdoYCBzdGF0ZSwgcGVyIHJvb3QgY29tbWFuZC5cbiAqXG4gKiBBIHBvc2l0aXZlIGRlbnlsaXN0IHJhdGhlciB0aGFuIFwiZXZlcnl0aGluZyBidXQgdGhlIGtub3duIHJlYWRzXCI6IGEgZnV0dXJlXG4gKiBgZ2hgIHJlbGVhc2UgYWRkaW5nIGEgcmVhZCB2ZXJiIG11c3Qgbm90IGJlIHJlZnVzZWQsIGFuZCB0aGUgcm9vdHMgaGVyZSBhcmVcbiAqIHNtYWxsIGFuZCBzdGFibGUuIEV2ZXJ5IHZlcmIgbGlzdGVkIHdyaXRlcyB0byBgR0hfQ09ORklHX0RJUmAgKG9yLCBmb3JcbiAqIGBzZXR1cC1naXRgLCB0byB0aGUgZ2l0IGNvbmZpZyBpdCBwb2ludHMgYXQpLlxuICovXG5leHBvcnQgY29uc3QgR0hfTE9DQUxfU1RBVEVfVkVSQlM6IFJlYWRvbmx5PFxuICBSZWNvcmQ8c3RyaW5nLCBSZWFkb25seVNldDxzdHJpbmc+PlxuPiA9IHtcbiAgLy8gQ3JlZGVudGlhbCBzdG9yZS4gYHN0YXR1c2AgaXMgYSByZWFkIGFuZCBzdGF5cyBhbGxvd2VkOyBgdG9rZW5gIOKAlCBhbmRcbiAgLy8gYHN0YXR1cyAtLXNob3ctdG9rZW5gIOKAlCBpcyBhIGNyZWRlbnRpYWwgZGlzY2xvc3VyZSByZWZ1c2VkIHNlcGFyYXRlbHlcbiAgLy8gYnkgYGdoX2NyZWRlbnRpYWxfZGlzY2xvc3VyZV9ndWFyZC50c2AgKElzc3VlICMxMzcxKS5cbiAgYXV0aDogbmV3IFNldChbXCJsb2dpblwiLCBcImxvZ291dFwiLCBcInN3aXRjaFwiLCBcInJlZnJlc2hcIiwgXCJzZXR1cC1naXRcIl0pLFxuICAvLyBDb25maWcgZmlsZS4gYGdldGAgYW5kIGBsaXN0YCBhcmUgcmVhZHMuXG4gIGNvbmZpZzogbmV3IFNldChbXCJzZXRcIiwgXCJjbGVhci1jYWNoZVwiXSksXG4gIC8vIEFsaWFzIHRhYmxlIOKAlCB3aGF0IGEgbGF0ZXIgYGdoIDxuYW1lPmAgZXhwYW5kcyB0by5cbiAgYWxpYXM6IG5ldyBTZXQoW1wic2V0XCIsIFwiZGVsZXRlXCIsIFwiaW1wb3J0XCJdKSxcbiAgLy8gSW5zdGFsbGVkIGV4dGVuc2lvbnMg4oCUIHdoYXQgYSBsYXRlciBgZ2ggPG5hbWU+YCBleGVjdXRlcy4gYGV4ZWNgIHJ1bnMgb25lXG4gIC8vIGRpcmVjdGx5LCB3aGljaCBpcyB0aGUgc2FtZSB1bnNlZW4gY29tbWFuZCBieSBhbm90aGVyIHNwZWxsaW5nLlxuICBleHRlbnNpb246IG5ldyBTZXQoW1wiaW5zdGFsbFwiLCBcInVwZ3JhZGVcIiwgXCJyZW1vdmVcIiwgXCJleGVjXCJdKSxcbn07XG5cbi8qKiBgZ2hgIHJvb3QgY29tbWFuZHMgd2hvc2UgbG9jYWwtc3RhdGUgdmVyYnMgYXJlIGRlbmllZCB0byB0aGUgYWdlbnQuICovXG5jb25zdCBHVUFSREVEX1JPT1RTOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA9IHtcbiAgYXV0aDogXCJ0aGUgY3JlZGVudGlhbCBzdG9yZVwiLFxuICBjb25maWc6IFwidGhlIGdoIGNvbmZpZ3VyYXRpb25cIixcbiAgYWxpYXM6IFwidGhlIGFsaWFzIHRhYmxlXCIsXG4gIGV4dGVuc2lvbjogXCJ0aGUgaW5zdGFsbGVkIGV4dGVuc2lvbnNcIixcbn07XG5cbi8qKlxuICogTm9ybWFsaXNlIGEgcm9vdCBzcGVsbGluZyB0byBpdHMgY2Fub25pY2FsIGZvcm0uXG4gKlxuICogVGhlIGBnaCBleHRlbnNpb25gIGFsaWFzZXMgY29tZSBmcm9tIHtAbGluayBHSF9FWFRFTlNJT05fUk9PVFN9IHJhdGhlciB0aGFuXG4gKiBhIHNlY29uZCBjb3B5IGtlcHQgaGVyZSAoSXNzdWUgIzEzOTYpIOKAlCBvbmUgbGlzdCBvZiB0aGUgc3BlbGxpbmdzIHRoZSByZWFsXG4gKiBiaW5hcnkgYWNjZXB0cywgc28gdGhlIGd1YXJkIGFuZCB0aGUgbXV0YXRpb24gY2xhc3NpZmllciBjYW5ub3QgZHJpZnQgaW50b1xuICogcmVmdXNpbmcgYGdoIGV4dCBpbnN0YWxsYCBpbiBvbmUgYW5kIHdhdmluZyBpdCB0aHJvdWdoIGluIHRoZSBvdGhlci5cbiAqL1xuZnVuY3Rpb24gY2Fub25pY2FsUm9vdChyb290OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gR0hfRVhURU5TSU9OX1JPT1RTLmhhcyhyb290KSA/IFwiZXh0ZW5zaW9uXCIgOiByb290O1xufVxuXG4vKiogT25lIGNsYXNzaWZpZWQgYXR0ZW1wdCB0byByZXdyaXRlIGxvY2FsIGBnaGAgc3RhdGUuICovXG5leHBvcnQgaW50ZXJmYWNlIEdoTG9jYWxTdGF0ZUNoYW5nZSB7XG4gIC8qKiBDYW5vbmljYWwgcm9vdCBjb21tYW5kIOKAlCBgYXV0aGAsIGBjb25maWdgLCBgYWxpYXNgLCBgZXh0ZW5zaW9uYC4gKi9cbiAgcm9vdDogc3RyaW5nO1xuICAvKiogVGhlIHN1Yi12ZXJiIGFzIHNwZWxsZWQgb24gdGhlIGNvbW1hbmQgbGluZS4gKi9cbiAgdmVyYjogc3RyaW5nO1xuICAvKiogV2hpY2ggbG9jYWwgc3RvcmUgdGhlIGNvbW1hbmQgcmV3cml0ZXMsIGZvciB0aGUgcmVmdXNhbCBtZXNzYWdlLiAqL1xuICB0YXJnZXQ6IHN0cmluZztcbn1cblxuLyoqXG4gKiBDbGFzc2lmeSBhIGBnaGAgYXJndW1lbnQgdmVjdG9yIGFzIGEgbG9jYWwtc3RhdGUgcmV3cml0ZS5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBhYm91dCB0byBiZSBwYXNzZWQgdG8gdGhlIGBnaGAgYmluYXJ5LlxuICogQHJldHVybnMgVGhlIGNoYW5nZSwgb3IgYHVuZGVmaW5lZGAgd2hlbiB0aGUgY29tbWFuZCByZXdyaXRlcyBubyBsb2NhbCBgZ2hgXG4gKiAgIHN0YXRlIChhIHJlYWQsIG9yIGFueSBvdGhlciByb290IGNvbW1hbmQpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhc3NpZnlHaExvY2FsU3RhdGVDaGFuZ2UoXG4gIHJhd0FyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogR2hMb2NhbFN0YXRlQ2hhbmdlIHwgdW5kZWZpbmVkIHtcbiAgLy8gSXNzdWUgIzM4Njc6IHBmbGFnJ3MgYXR0YWNoZWQgc2hvcnRoYW5kIHNwZWxsaW5ncyBhcmUgcmV3cml0dGVuIHRvIHRoZWlyXG4gIC8vIHNlcGFyYXRlZCBmb3JtIGZpcnN0LCBzbyB0aGUgcm9vdC92ZXJiIHNjYW4gc2VlcyB0aGUgb25lIHNwZWxsaW5nLlxuICBjb25zdCBhcmdzID0gbm9ybWFsaXNlR2hBcmdzKHJhd0FyZ3MpO1xuICBjb25zdCByYXdSb290ID0gZ2hSb290Q29tbWFuZChhcmdzKT8udG9Mb3dlckNhc2UoKTtcbiAgaWYgKHJhd1Jvb3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3Qgcm9vdCA9IGNhbm9uaWNhbFJvb3QocmF3Um9vdCk7XG4gIGNvbnN0IHRhcmdldCA9IEdVQVJERURfUk9PVFNbcm9vdF07XG4gIGlmICh0YXJnZXQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICBjb25zdCB2ZXJiID0gZ2hTdWJWZXJiKGFyZ3MpO1xuICBpZiAodmVyYiA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICBpZiAoIUdIX0xPQ0FMX1NUQVRFX1ZFUkJTW3Jvb3RdPy5oYXModmVyYi50b0xvd2VyQ2FzZSgpKSkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICByZXR1cm4geyByb290LCB2ZXJiLCB0YXJnZXQgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0NDLEdBRUQsU0FDRSxrQkFBa0IsRUFDbEIsYUFBYSxFQUNiLFNBQVMsUUFDSixpQ0FBaUM7QUFDeEMsU0FBUyxlQUFlLFFBQVEsc0JBQXNCO0FBRXREOzs7Ozs7O0NBT0MsR0FDRCxPQUFPLE1BQU0sdUJBRVQ7RUFDRix3RUFBd0U7RUFDeEUsd0VBQXdFO0VBQ3hFLHdEQUF3RDtFQUN4RCxNQUFNLElBQUksSUFBSTtJQUFDO0lBQVM7SUFBVTtJQUFVO0lBQVc7R0FBWTtFQUNuRSwyQ0FBMkM7RUFDM0MsUUFBUSxJQUFJLElBQUk7SUFBQztJQUFPO0dBQWM7RUFDdEMscURBQXFEO0VBQ3JELE9BQU8sSUFBSSxJQUFJO0lBQUM7SUFBTztJQUFVO0dBQVM7RUFDMUMsNEVBQTRFO0VBQzVFLGtFQUFrRTtFQUNsRSxXQUFXLElBQUksSUFBSTtJQUFDO0lBQVc7SUFBVztJQUFVO0dBQU87QUFDN0QsRUFBRTtBQUVGLHdFQUF3RSxHQUN4RSxNQUFNLGdCQUFrRDtFQUN0RCxNQUFNO0VBQ04sUUFBUTtFQUNSLE9BQU87RUFDUCxXQUFXO0FBQ2I7QUFFQTs7Ozs7OztDQU9DLEdBQ0QsU0FBUyxjQUFjLElBQVk7RUFDakMsT0FBTyxtQkFBbUIsR0FBRyxDQUFDLFFBQVEsY0FBYztBQUN0RDtBQVlBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUywyQkFDZCxPQUEwQjtFQUUxQiwyRUFBMkU7RUFDM0UscUVBQXFFO0VBQ3JFLE1BQU0sT0FBTyxnQkFBZ0I7RUFDN0IsTUFBTSxVQUFVLGNBQWMsT0FBTztFQUNyQyxJQUFJLFlBQVksV0FBVyxPQUFPO0VBQ2xDLE1BQU0sT0FBTyxjQUFjO0VBQzNCLE1BQU0sU0FBUyxhQUFhLENBQUMsS0FBSztFQUNsQyxJQUFJLFdBQVcsV0FBVyxPQUFPO0VBRWpDLE1BQU0sT0FBTyxVQUFVO0VBQ3ZCLElBQUksU0FBUyxXQUFXLE9BQU87RUFDL0IsSUFBSSxDQUFDLG9CQUFvQixDQUFDLEtBQUssRUFBRSxJQUFJLEtBQUssV0FBVyxLQUFLLE9BQU87RUFFakUsT0FBTztJQUFFO0lBQU07SUFBTTtFQUFPO0FBQzlCIn0=
// denoCacheMetadata=7528063427389980252,11354259831108460939