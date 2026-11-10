/**
 * "Am I running inside the worker container image?" — one rule (Issue #1262).
 *
 * The container build stamps the provider set it installed into
 * {@linkcode CONTAINER_IMAGE_STAMP_ENV}, and no host run has it. Every
 * reader spelled the test as `env(...) !== undefined`, a *presence* test,
 * which `VIBE_IMAGE_AGENT_PROVIDERS=` (the empty string) satisfies.
 *
 * That is a mode switch a blank value must not flip. The sharpest case is
 * the `gh` credential fallback in `service_account_env.ts`: in container mode
 * a configured-but-missing `gh_config_dir` falls back to the staged copy,
 * whose first candidate is the ambient `GH_CONFIG_DIR` — so a blank stamp on
 * a HOST run turned a loud failure into a silent fall-through to whatever
 * credential the ambient environment carried (the Issue #3530 leak). The
 * setup suites already encode the intended reading of a blank value: they
 * set it to `""` precisely to simulate a host run.
 *
 * So the rule is value, not presence: the stamp counts only when it is
 * non-blank, and a blank stamp reads exactly like an absent one — host.
 *
 * Every container-mode reader in the worker now asks this module rather than
 * spelling the test itself (Issue #1493): `service_account_env.ts`,
 * `stuck_issue_detector.ts`, `agent_provider.ts`, `run_housekeeping.ts`,
 * `claude_env.ts`, `crash_notification.ts`, `disk_space.ts`,
 * `software_updates.ts`, `prompt_immutability.ts`, `unit_test_passes.ts`,
 * `semgrep_check.ts` and `commands/benchmark.ts`. The two modules that had
 * their own name for the variable — `IN_IMAGE_ENV` and `CONTAINER_MARKER_VAR`
 * — alias {@linkcode CONTAINER_IMAGE_STAMP_ENV} so they cannot drift from it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */ import { processEnvLookup } from "./env_lookup.ts";
/** The provider set the image was built with, stamped in by the build. */ export const CONTAINER_IMAGE_STAMP_ENV = "VIBE_IMAGE_AGENT_PROVIDERS";
/**
 * True when the run carries a non-blank container image stamp.
 *
 * @param env - Environment lookup (defaults to the process environment).
 * @returns `true` only for a stamp with non-whitespace content; `false` when
 *   the variable is absent, empty, or whitespace — all of which are a host
 *   run as far as every container-only behaviour is concerned.
 */ export function runningInContainerImage(env = processEnvLookup) {
  return (env(CONTAINER_IMAGE_STAMP_ENV) ?? "").trim() !== "";
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb250YWluZXJfc3RhbXAudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBcIkFtIEkgcnVubmluZyBpbnNpZGUgdGhlIHdvcmtlciBjb250YWluZXIgaW1hZ2U/XCIg4oCUIG9uZSBydWxlIChJc3N1ZSAjMTI2MikuXG4gKlxuICogVGhlIGNvbnRhaW5lciBidWlsZCBzdGFtcHMgdGhlIHByb3ZpZGVyIHNldCBpdCBpbnN0YWxsZWQgaW50b1xuICoge0BsaW5rY29kZSBDT05UQUlORVJfSU1BR0VfU1RBTVBfRU5WfSwgYW5kIG5vIGhvc3QgcnVuIGhhcyBpdC4gRXZlcnlcbiAqIHJlYWRlciBzcGVsbGVkIHRoZSB0ZXN0IGFzIGBlbnYoLi4uKSAhPT0gdW5kZWZpbmVkYCwgYSAqcHJlc2VuY2UqIHRlc3QsXG4gKiB3aGljaCBgVklCRV9JTUFHRV9BR0VOVF9QUk9WSURFUlM9YCAodGhlIGVtcHR5IHN0cmluZykgc2F0aXNmaWVzLlxuICpcbiAqIFRoYXQgaXMgYSBtb2RlIHN3aXRjaCBhIGJsYW5rIHZhbHVlIG11c3Qgbm90IGZsaXAuIFRoZSBzaGFycGVzdCBjYXNlIGlzXG4gKiB0aGUgYGdoYCBjcmVkZW50aWFsIGZhbGxiYWNrIGluIGBzZXJ2aWNlX2FjY291bnRfZW52LnRzYDogaW4gY29udGFpbmVyIG1vZGVcbiAqIGEgY29uZmlndXJlZC1idXQtbWlzc2luZyBgZ2hfY29uZmlnX2RpcmAgZmFsbHMgYmFjayB0byB0aGUgc3RhZ2VkIGNvcHksXG4gKiB3aG9zZSBmaXJzdCBjYW5kaWRhdGUgaXMgdGhlIGFtYmllbnQgYEdIX0NPTkZJR19ESVJgIOKAlCBzbyBhIGJsYW5rIHN0YW1wIG9uXG4gKiBhIEhPU1QgcnVuIHR1cm5lZCBhIGxvdWQgZmFpbHVyZSBpbnRvIGEgc2lsZW50IGZhbGwtdGhyb3VnaCB0byB3aGF0ZXZlclxuICogY3JlZGVudGlhbCB0aGUgYW1iaWVudCBlbnZpcm9ubWVudCBjYXJyaWVkICh0aGUgSXNzdWUgIzM1MzAgbGVhaykuIFRoZVxuICogc2V0dXAgc3VpdGVzIGFscmVhZHkgZW5jb2RlIHRoZSBpbnRlbmRlZCByZWFkaW5nIG9mIGEgYmxhbmsgdmFsdWU6IHRoZXlcbiAqIHNldCBpdCB0byBgXCJcImAgcHJlY2lzZWx5IHRvIHNpbXVsYXRlIGEgaG9zdCBydW4uXG4gKlxuICogU28gdGhlIHJ1bGUgaXMgdmFsdWUsIG5vdCBwcmVzZW5jZTogdGhlIHN0YW1wIGNvdW50cyBvbmx5IHdoZW4gaXQgaXNcbiAqIG5vbi1ibGFuaywgYW5kIGEgYmxhbmsgc3RhbXAgcmVhZHMgZXhhY3RseSBsaWtlIGFuIGFic2VudCBvbmUg4oCUIGhvc3QuXG4gKlxuICogRXZlcnkgY29udGFpbmVyLW1vZGUgcmVhZGVyIGluIHRoZSB3b3JrZXIgbm93IGFza3MgdGhpcyBtb2R1bGUgcmF0aGVyIHRoYW5cbiAqIHNwZWxsaW5nIHRoZSB0ZXN0IGl0c2VsZiAoSXNzdWUgIzE0OTMpOiBgc2VydmljZV9hY2NvdW50X2Vudi50c2AsXG4gKiBgc3R1Y2tfaXNzdWVfZGV0ZWN0b3IudHNgLCBgYWdlbnRfcHJvdmlkZXIudHNgLCBgcnVuX2hvdXNla2VlcGluZy50c2AsXG4gKiBgY2xhdWRlX2Vudi50c2AsIGBjcmFzaF9ub3RpZmljYXRpb24udHNgLCBgZGlza19zcGFjZS50c2AsXG4gKiBgc29mdHdhcmVfdXBkYXRlcy50c2AsIGBwcm9tcHRfaW1tdXRhYmlsaXR5LnRzYCwgYHVuaXRfdGVzdF9wYXNzZXMudHNgLFxuICogYHNlbWdyZXBfY2hlY2sudHNgIGFuZCBgY29tbWFuZHMvYmVuY2htYXJrLnRzYC4gVGhlIHR3byBtb2R1bGVzIHRoYXQgaGFkXG4gKiB0aGVpciBvd24gbmFtZSBmb3IgdGhlIHZhcmlhYmxlIOKAlCBgSU5fSU1BR0VfRU5WYCBhbmQgYENPTlRBSU5FUl9NQVJLRVJfVkFSYFxuICog4oCUIGFsaWFzIHtAbGlua2NvZGUgQ09OVEFJTkVSX0lNQUdFX1NUQU1QX0VOVn0gc28gdGhleSBjYW5ub3QgZHJpZnQgZnJvbSBpdC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHsgdHlwZSBFbnZMb29rdXAsIHByb2Nlc3NFbnZMb29rdXAgfSBmcm9tIFwiLi9lbnZfbG9va3VwLnRzXCI7XG5cbi8qKiBUaGUgcHJvdmlkZXIgc2V0IHRoZSBpbWFnZSB3YXMgYnVpbHQgd2l0aCwgc3RhbXBlZCBpbiBieSB0aGUgYnVpbGQuICovXG5leHBvcnQgY29uc3QgQ09OVEFJTkVSX0lNQUdFX1NUQU1QX0VOViA9IFwiVklCRV9JTUFHRV9BR0VOVF9QUk9WSURFUlNcIjtcblxuLyoqXG4gKiBUcnVlIHdoZW4gdGhlIHJ1biBjYXJyaWVzIGEgbm9uLWJsYW5rIGNvbnRhaW5lciBpbWFnZSBzdGFtcC5cbiAqXG4gKiBAcGFyYW0gZW52IC0gRW52aXJvbm1lbnQgbG9va3VwIChkZWZhdWx0cyB0byB0aGUgcHJvY2VzcyBlbnZpcm9ubWVudCkuXG4gKiBAcmV0dXJucyBgdHJ1ZWAgb25seSBmb3IgYSBzdGFtcCB3aXRoIG5vbi13aGl0ZXNwYWNlIGNvbnRlbnQ7IGBmYWxzZWAgd2hlblxuICogICB0aGUgdmFyaWFibGUgaXMgYWJzZW50LCBlbXB0eSwgb3Igd2hpdGVzcGFjZSDigJQgYWxsIG9mIHdoaWNoIGFyZSBhIGhvc3RcbiAqICAgcnVuIGFzIGZhciBhcyBldmVyeSBjb250YWluZXItb25seSBiZWhhdmlvdXIgaXMgY29uY2VybmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcnVubmluZ0luQ29udGFpbmVySW1hZ2UoXG4gIGVudjogRW52TG9va3VwID0gcHJvY2Vzc0Vudkxvb2t1cCxcbik6IGJvb2xlYW4ge1xuICByZXR1cm4gKGVudihDT05UQUlORVJfSU1BR0VfU1RBTVBfRU5WKSA/PyBcIlwiKS50cmltKCkgIT09IFwiXCI7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQThCQyxHQUVELFNBQXlCLGdCQUFnQixRQUFRLGtCQUFrQjtBQUVuRSx3RUFBd0UsR0FDeEUsT0FBTyxNQUFNLDRCQUE0Qiw2QkFBNkI7QUFFdEU7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sU0FBUyx3QkFDZCxNQUFpQixnQkFBZ0I7RUFFakMsT0FBTyxDQUFDLElBQUksOEJBQThCLEVBQUUsRUFBRSxJQUFJLE9BQU87QUFDM0QifQ==
// denoCacheMetadata=9792714940773116881,15299623617852684319