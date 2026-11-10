/**
 * The environment repository-controlled code runs with (Issue #572).
 *
 * The worker executes code it did not write: the repo's own quality command,
 * its test suite, its build, and every install hook those reach —
 * `deno install`, `npm install --package-lock-only`, `cargo generate-lockfile`.
 * Those spawns inherited the worker's whole environment, which carries the
 * provider credentials the run exports:
 *
 *     [SECURITY] provider credentials exported to the run environment:
 *     CLAUDE_CODE_OAUTH_TOKEN
 *
 * and, on the fleets that maintain repositories whose checks need them, cloud
 * credentials too. So `echo $AWS_SECRET_ACCESS_KEY` in a postinstall script
 * was the whole exploit — no compromise of the model required, just an
 * ordinary supply-chain dependency in a public repository the fleet builds.
 *
 * An environment variable is also the hardest kind of secret to contain: every
 * descendant inherits it, any same-uid process can read `/proc/<pid>/environ`,
 * and it lands in crash dumps, `ps` output and diagnostic bundles. It cannot
 * be revoked mid-run. A file can be permission-scoped and taken away.
 *
 * So the environment for those spawns is BUILT, never inherited. This is an
 * allowlist by name: a variable the build genuinely needs is named here, and
 * anything else — including every credential — is simply absent. A denylist
 * would have to predict the next credential's name, and would be wrong the
 * first time one is added.
 *
 * Scope note: this bounds what UNTRUSTED code sees. It does not separate the
 * worker from its own coding agent, which still runs as the same uid and can
 * read the credential files directly (Issue #571). That is the control that
 * actually holds, and it is a different change.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */ import { runGitArgv } from "./git_timeout.ts";
import { commandOutputWithTimeout, isCommandTimeoutError } from "./subprocess_timeout.ts";
/** `id` and `sudo` probes. Seconds. A timeout must not look like "no agent account". */ const UNTRUSTED_PROBE_TIMEOUT_MS = 10_000;
/**
 * Variables a build legitimately needs, by name.
 *
 * Deliberately short. Anything not here is absent from the child, so adding a
 * name is a decision about what repository-controlled code may see.
 */ export const ALLOWED_ENV_NAMES = [
  // Finding and running tools at all.
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  // Where temporary files go — the container relocates this (Issue #515).
  "TMPDIR",
  // Locale and terminal: test output and date formatting depend on them.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  // Toolchain caches. Without these every quality run re-downloads its
  // dependencies, which is slow enough to change behaviour under a timeout.
  "DENO_DIR",
  "DENO_INSTALL_ROOT",
  "CARGO_HOME",
  // Cargo's job cap. The container entrypoint sets it (Issue #4225); this
  // list only forwards a value the parent already has. It does not choose
  // the number, and a host run that never set it stays uncapped.
  "CARGO_BUILD_JOBS",
  // Where cargo writes its build output. On a runtime that refuses to trim
  // the work volume the worker points this at the container's own ephemeral
  // layer (Issue #2247); an operator who sets it keeps it.
  "CARGO_TARGET_DIR",
  "RUSTUP_HOME",
  "GOPATH",
  "GOCACHE",
  "GOMODCACHE",
  "PNPM_HOME",
  "npm_config_cache",
  // Ruby: without these `bundle exec` cannot resolve the gems the repository
  // pinned, and the check that needs them reports SKIPPED (Issue #1226).
  "GEM_HOME",
  "GEM_PATH",
  "BUNDLE_PATH",
  "BUNDLE_APP_CONFIG",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // Egress, where the host requires a proxy to reach a registry at all.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Tools branch on this, and a build that behaves differently under CI than
  // under the worker is a build whose result does not transfer.
  "CI"
];
/** Name fragments that mark a variable as carrying a credential. */ const CREDENTIAL_NAME_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /\bkey\b/i,
  /api[_-]?key/i,
  /credential/i,
  /auth/i,
  /session/i
];
/**
 * Whether a variable's NAME marks it as a credential.
 *
 * Used by the guard test rather than by the builder: the allowlist is the
 * control, and this is how "no credential survived" is asserted without
 * naming each one.
 */ export function isCredentialVariableName(name) {
  return CREDENTIAL_NAME_PATTERNS.some((pattern)=>pattern.test(name));
}
/**
 * Build the environment for a command the worker does not control.
 *
 * @returns Only the allowlisted names present in the source, plus overrides.
 */ export function buildUntrustedCommandEnv(options = {}) {
  const source = options.source ?? readEnvironment();
  const allowed = new Set([
    ...ALLOWED_ENV_NAMES,
    ...options.extraNames ?? []
  ]);
  const env = {};
  for (const name of allowed){
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    ...options.overrides ?? {}
  };
}
/** The process environment, or an empty object where it cannot be read. */ function readEnvironment() {
  try {
    return Deno.env.toObject();
  } catch  {
    return {};
  }
}
// ---------------------------------------------------------------------------
// Running as a different account (Issue #571)
// ---------------------------------------------------------------------------
/**
 * The unprivileged account untrusted commands run as.
 *
 * Separate from the worker's own account so that file permissions actually
 * separate them. The worker's credentials are `0700 vibe`, so the moment the
 * command runs as somebody else it cannot read them — which is the whole
 * point, and something no environment allowlist can achieve on its own: same
 * uid means same access to every credential file, whatever the environment
 * says.
 */ export const UNTRUSTED_USER = "agent";
/**
 * Wrap a command so it runs as {@link UNTRUSTED_USER}.
 *
 * The container process holds NO capabilities (`CapEff: 0`), so it cannot
 * change uid by itself — a setuid helper is required, and `sudo` with a
 * single narrow rule is the one the operator chose:
 *
 *     vibe ALL=(agent) NOPASSWD: <the pinned binaries>
 *
 * `-n` never prompts: without the rule the command fails immediately and
 * loudly rather than hanging on a password nobody can type.
 *
 * @param cmd - The command as spawned today.
 * @param options.enabled - False leaves the command untouched, which is the
 *   behaviour on any host whose image predates the `agent` account.
 * @returns The command to spawn.
 */ export function asUntrustedUser(cmd, options = {
  enabled: false
}) {
  if (!options.enabled || cmd.length === 0) return [
    ...cmd
  ];
  return [
    "sudo",
    "-n",
    "-u",
    options.user ?? UNTRUSTED_USER,
    "--",
    ...cmd
  ];
}
/**
 * Whether this container can run a command as the separate account.
 *
 * Both halves are required and both are checked, because either alone fails
 * at spawn time with a message that does not name the cause: the account must
 * exist, and `sudo` must be present to reach it.
 */ export async function canRunAsUntrustedUser(probe = defaultProbe) {
  if (!await probe([
    "id",
    "-u",
    UNTRUSTED_USER
  ])) return false;
  return await probe([
    "sudo",
    "-n",
    "-u",
    UNTRUSTED_USER,
    "--",
    "true"
  ]);
}
/**
 * Runs a command, reporting only whether it succeeded.
 *
 * Issue #1553: the binary is the head of the argv, so a `git` probe is
 * delegated to the chokepoint rather than spawned here without a timeout.
 * A timeout is thrown: returning false would drop the untrusted account and
 * run the repository's command as the worker.
 */ export async function probeCommandSuccess(cmd, timeoutMs = UNTRUSTED_PROBE_TIMEOUT_MS) {
  if (cmd[0] === "git") return (await runGitArgv(cmd)).success;
  try {
    const output = await commandOutputWithTimeout(cmd[0] ?? "", {
      args: cmd.slice(1),
      stdout: "null",
      stderr: "null",
      stdin: "null",
      timeoutMs
    });
    return output.success;
  } catch (error) {
    if (isCommandTimeoutError(error)) throw error;
    return false;
  }
}
async function defaultProbe(cmd) {
  return await probeCommandSuccess(cmd);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi91bnRydXN0ZWRfY29tbWFuZF9lbnYudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUaGUgZW52aXJvbm1lbnQgcmVwb3NpdG9yeS1jb250cm9sbGVkIGNvZGUgcnVucyB3aXRoIChJc3N1ZSAjNTcyKS5cbiAqXG4gKiBUaGUgd29ya2VyIGV4ZWN1dGVzIGNvZGUgaXQgZGlkIG5vdCB3cml0ZTogdGhlIHJlcG8ncyBvd24gcXVhbGl0eSBjb21tYW5kLFxuICogaXRzIHRlc3Qgc3VpdGUsIGl0cyBidWlsZCwgYW5kIGV2ZXJ5IGluc3RhbGwgaG9vayB0aG9zZSByZWFjaCDigJRcbiAqIGBkZW5vIGluc3RhbGxgLCBgbnBtIGluc3RhbGwgLS1wYWNrYWdlLWxvY2stb25seWAsIGBjYXJnbyBnZW5lcmF0ZS1sb2NrZmlsZWAuXG4gKiBUaG9zZSBzcGF3bnMgaW5oZXJpdGVkIHRoZSB3b3JrZXIncyB3aG9sZSBlbnZpcm9ubWVudCwgd2hpY2ggY2FycmllcyB0aGVcbiAqIHByb3ZpZGVyIGNyZWRlbnRpYWxzIHRoZSBydW4gZXhwb3J0czpcbiAqXG4gKiAgICAgW1NFQ1VSSVRZXSBwcm92aWRlciBjcmVkZW50aWFscyBleHBvcnRlZCB0byB0aGUgcnVuIGVudmlyb25tZW50OlxuICogICAgIENMQVVERV9DT0RFX09BVVRIX1RPS0VOXG4gKlxuICogYW5kLCBvbiB0aGUgZmxlZXRzIHRoYXQgbWFpbnRhaW4gcmVwb3NpdG9yaWVzIHdob3NlIGNoZWNrcyBuZWVkIHRoZW0sIGNsb3VkXG4gKiBjcmVkZW50aWFscyB0b28uIFNvIGBlY2hvICRBV1NfU0VDUkVUX0FDQ0VTU19LRVlgIGluIGEgcG9zdGluc3RhbGwgc2NyaXB0XG4gKiB3YXMgdGhlIHdob2xlIGV4cGxvaXQg4oCUIG5vIGNvbXByb21pc2Ugb2YgdGhlIG1vZGVsIHJlcXVpcmVkLCBqdXN0IGFuXG4gKiBvcmRpbmFyeSBzdXBwbHktY2hhaW4gZGVwZW5kZW5jeSBpbiBhIHB1YmxpYyByZXBvc2l0b3J5IHRoZSBmbGVldCBidWlsZHMuXG4gKlxuICogQW4gZW52aXJvbm1lbnQgdmFyaWFibGUgaXMgYWxzbyB0aGUgaGFyZGVzdCBraW5kIG9mIHNlY3JldCB0byBjb250YWluOiBldmVyeVxuICogZGVzY2VuZGFudCBpbmhlcml0cyBpdCwgYW55IHNhbWUtdWlkIHByb2Nlc3MgY2FuIHJlYWQgYC9wcm9jLzxwaWQ+L2Vudmlyb25gLFxuICogYW5kIGl0IGxhbmRzIGluIGNyYXNoIGR1bXBzLCBgcHNgIG91dHB1dCBhbmQgZGlhZ25vc3RpYyBidW5kbGVzLiBJdCBjYW5ub3RcbiAqIGJlIHJldm9rZWQgbWlkLXJ1bi4gQSBmaWxlIGNhbiBiZSBwZXJtaXNzaW9uLXNjb3BlZCBhbmQgdGFrZW4gYXdheS5cbiAqXG4gKiBTbyB0aGUgZW52aXJvbm1lbnQgZm9yIHRob3NlIHNwYXducyBpcyBCVUlMVCwgbmV2ZXIgaW5oZXJpdGVkLiBUaGlzIGlzIGFuXG4gKiBhbGxvd2xpc3QgYnkgbmFtZTogYSB2YXJpYWJsZSB0aGUgYnVpbGQgZ2VudWluZWx5IG5lZWRzIGlzIG5hbWVkIGhlcmUsIGFuZFxuICogYW55dGhpbmcgZWxzZSDigJQgaW5jbHVkaW5nIGV2ZXJ5IGNyZWRlbnRpYWwg4oCUIGlzIHNpbXBseSBhYnNlbnQuIEEgZGVueWxpc3RcbiAqIHdvdWxkIGhhdmUgdG8gcHJlZGljdCB0aGUgbmV4dCBjcmVkZW50aWFsJ3MgbmFtZSwgYW5kIHdvdWxkIGJlIHdyb25nIHRoZVxuICogZmlyc3QgdGltZSBvbmUgaXMgYWRkZWQuXG4gKlxuICogU2NvcGUgbm90ZTogdGhpcyBib3VuZHMgd2hhdCBVTlRSVVNURUQgY29kZSBzZWVzLiBJdCBkb2VzIG5vdCBzZXBhcmF0ZSB0aGVcbiAqIHdvcmtlciBmcm9tIGl0cyBvd24gY29kaW5nIGFnZW50LCB3aGljaCBzdGlsbCBydW5zIGFzIHRoZSBzYW1lIHVpZCBhbmQgY2FuXG4gKiByZWFkIHRoZSBjcmVkZW50aWFsIGZpbGVzIGRpcmVjdGx5IChJc3N1ZSAjNTcxKS4gVGhhdCBpcyB0aGUgY29udHJvbCB0aGF0XG4gKiBhY3R1YWxseSBob2xkcywgYW5kIGl0IGlzIGEgZGlmZmVyZW50IGNoYW5nZS5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB7IHJ1bkdpdEFyZ3YgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHtcbiAgY29tbWFuZE91dHB1dFdpdGhUaW1lb3V0LFxuICBpc0NvbW1hbmRUaW1lb3V0RXJyb3IsXG59IGZyb20gXCIuL3N1YnByb2Nlc3NfdGltZW91dC50c1wiO1xuXG4vKiogYGlkYCBhbmQgYHN1ZG9gIHByb2Jlcy4gU2Vjb25kcy4gQSB0aW1lb3V0IG11c3Qgbm90IGxvb2sgbGlrZSBcIm5vIGFnZW50IGFjY291bnRcIi4gKi9cbmNvbnN0IFVOVFJVU1RFRF9QUk9CRV9USU1FT1VUX01TID0gMTBfMDAwO1xuXG4vKipcbiAqIFZhcmlhYmxlcyBhIGJ1aWxkIGxlZ2l0aW1hdGVseSBuZWVkcywgYnkgbmFtZS5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgc2hvcnQuIEFueXRoaW5nIG5vdCBoZXJlIGlzIGFic2VudCBmcm9tIHRoZSBjaGlsZCwgc28gYWRkaW5nIGFcbiAqIG5hbWUgaXMgYSBkZWNpc2lvbiBhYm91dCB3aGF0IHJlcG9zaXRvcnktY29udHJvbGxlZCBjb2RlIG1heSBzZWUuXG4gKi9cbmV4cG9ydCBjb25zdCBBTExPV0VEX0VOVl9OQU1FUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIC8vIEZpbmRpbmcgYW5kIHJ1bm5pbmcgdG9vbHMgYXQgYWxsLlxuICBcIlBBVEhcIixcbiAgXCJIT01FXCIsXG4gIFwiU0hFTExcIixcbiAgXCJVU0VSXCIsXG4gIFwiTE9HTkFNRVwiLFxuICAvLyBXaGVyZSB0ZW1wb3JhcnkgZmlsZXMgZ28g4oCUIHRoZSBjb250YWluZXIgcmVsb2NhdGVzIHRoaXMgKElzc3VlICM1MTUpLlxuICBcIlRNUERJUlwiLFxuICAvLyBMb2NhbGUgYW5kIHRlcm1pbmFsOiB0ZXN0IG91dHB1dCBhbmQgZGF0ZSBmb3JtYXR0aW5nIGRlcGVuZCBvbiB0aGVtLlxuICBcIkxBTkdcIixcbiAgXCJMQ19BTExcIixcbiAgXCJMQ19DVFlQRVwiLFxuICBcIlRaXCIsXG4gIFwiVEVSTVwiLFxuICAvLyBUb29sY2hhaW4gY2FjaGVzLiBXaXRob3V0IHRoZXNlIGV2ZXJ5IHF1YWxpdHkgcnVuIHJlLWRvd25sb2FkcyBpdHNcbiAgLy8gZGVwZW5kZW5jaWVzLCB3aGljaCBpcyBzbG93IGVub3VnaCB0byBjaGFuZ2UgYmVoYXZpb3VyIHVuZGVyIGEgdGltZW91dC5cbiAgXCJERU5PX0RJUlwiLFxuICBcIkRFTk9fSU5TVEFMTF9ST09UXCIsXG4gIFwiQ0FSR09fSE9NRVwiLFxuICAvLyBDYXJnbydzIGpvYiBjYXAuIFRoZSBjb250YWluZXIgZW50cnlwb2ludCBzZXRzIGl0IChJc3N1ZSAjNDIyNSk7IHRoaXNcbiAgLy8gbGlzdCBvbmx5IGZvcndhcmRzIGEgdmFsdWUgdGhlIHBhcmVudCBhbHJlYWR5IGhhcy4gSXQgZG9lcyBub3QgY2hvb3NlXG4gIC8vIHRoZSBudW1iZXIsIGFuZCBhIGhvc3QgcnVuIHRoYXQgbmV2ZXIgc2V0IGl0IHN0YXlzIHVuY2FwcGVkLlxuICBcIkNBUkdPX0JVSUxEX0pPQlNcIixcbiAgLy8gV2hlcmUgY2FyZ28gd3JpdGVzIGl0cyBidWlsZCBvdXRwdXQuIE9uIGEgcnVudGltZSB0aGF0IHJlZnVzZXMgdG8gdHJpbVxuICAvLyB0aGUgd29yayB2b2x1bWUgdGhlIHdvcmtlciBwb2ludHMgdGhpcyBhdCB0aGUgY29udGFpbmVyJ3Mgb3duIGVwaGVtZXJhbFxuICAvLyBsYXllciAoSXNzdWUgIzIyNDcpOyBhbiBvcGVyYXRvciB3aG8gc2V0cyBpdCBrZWVwcyBpdC5cbiAgXCJDQVJHT19UQVJHRVRfRElSXCIsXG4gIFwiUlVTVFVQX0hPTUVcIixcbiAgXCJHT1BBVEhcIixcbiAgXCJHT0NBQ0hFXCIsXG4gIFwiR09NT0RDQUNIRVwiLFxuICBcIlBOUE1fSE9NRVwiLFxuICBcIm5wbV9jb25maWdfY2FjaGVcIixcbiAgLy8gUnVieTogd2l0aG91dCB0aGVzZSBgYnVuZGxlIGV4ZWNgIGNhbm5vdCByZXNvbHZlIHRoZSBnZW1zIHRoZSByZXBvc2l0b3J5XG4gIC8vIHBpbm5lZCwgYW5kIHRoZSBjaGVjayB0aGF0IG5lZWRzIHRoZW0gcmVwb3J0cyBTS0lQUEVEIChJc3N1ZSAjMTIyNikuXG4gIFwiR0VNX0hPTUVcIixcbiAgXCJHRU1fUEFUSFwiLFxuICBcIkJVTkRMRV9QQVRIXCIsXG4gIFwiQlVORExFX0FQUF9DT05GSUdcIixcbiAgXCJYREdfQ0FDSEVfSE9NRVwiLFxuICBcIlhER19DT05GSUdfSE9NRVwiLFxuICBcIlhER19EQVRBX0hPTUVcIixcbiAgLy8gRWdyZXNzLCB3aGVyZSB0aGUgaG9zdCByZXF1aXJlcyBhIHByb3h5IHRvIHJlYWNoIGEgcmVnaXN0cnkgYXQgYWxsLlxuICBcIkhUVFBfUFJPWFlcIixcbiAgXCJIVFRQU19QUk9YWVwiLFxuICBcIk5PX1BST1hZXCIsXG4gIFwiaHR0cF9wcm94eVwiLFxuICBcImh0dHBzX3Byb3h5XCIsXG4gIFwibm9fcHJveHlcIixcbiAgLy8gVG9vbHMgYnJhbmNoIG9uIHRoaXMsIGFuZCBhIGJ1aWxkIHRoYXQgYmVoYXZlcyBkaWZmZXJlbnRseSB1bmRlciBDSSB0aGFuXG4gIC8vIHVuZGVyIHRoZSB3b3JrZXIgaXMgYSBidWlsZCB3aG9zZSByZXN1bHQgZG9lcyBub3QgdHJhbnNmZXIuXG4gIFwiQ0lcIixcbl07XG5cbi8qKiBOYW1lIGZyYWdtZW50cyB0aGF0IG1hcmsgYSB2YXJpYWJsZSBhcyBjYXJyeWluZyBhIGNyZWRlbnRpYWwuICovXG5jb25zdCBDUkVERU5USUFMX05BTUVfUEFUVEVSTlM6IHJlYWRvbmx5IFJlZ0V4cFtdID0gW1xuICAvdG9rZW4vaSxcbiAgL3NlY3JldC9pLFxuICAvcGFzc3dvcmQvaSxcbiAgL3Bhc3N3ZC9pLFxuICAvXFxia2V5XFxiL2ksXG4gIC9hcGlbXy1dP2tleS9pLFxuICAvY3JlZGVudGlhbC9pLFxuICAvYXV0aC9pLFxuICAvc2Vzc2lvbi9pLFxuXTtcblxuLyoqXG4gKiBXaGV0aGVyIGEgdmFyaWFibGUncyBOQU1FIG1hcmtzIGl0IGFzIGEgY3JlZGVudGlhbC5cbiAqXG4gKiBVc2VkIGJ5IHRoZSBndWFyZCB0ZXN0IHJhdGhlciB0aGFuIGJ5IHRoZSBidWlsZGVyOiB0aGUgYWxsb3dsaXN0IGlzIHRoZVxuICogY29udHJvbCwgYW5kIHRoaXMgaXMgaG93IFwibm8gY3JlZGVudGlhbCBzdXJ2aXZlZFwiIGlzIGFzc2VydGVkIHdpdGhvdXRcbiAqIG5hbWluZyBlYWNoIG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQ3JlZGVudGlhbFZhcmlhYmxlTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIENSRURFTlRJQUxfTkFNRV9QQVRURVJOUy5zb21lKChwYXR0ZXJuKSA9PiBwYXR0ZXJuLnRlc3QobmFtZSkpO1xufVxuXG4vKiogT3B0aW9ucyBmb3Ige0BsaW5rIGJ1aWxkVW50cnVzdGVkQ29tbWFuZEVudn0uICovXG5leHBvcnQgaW50ZXJmYWNlIFVudHJ1c3RlZENvbW1hbmRFbnZPcHRpb25zIHtcbiAgLyoqXG4gICAqIEV4dHJhIHZhcmlhYmxlIG5hbWVzIHRoaXMgcmVwb3NpdG9yeSdzIGNoZWNrcyBkZWNsYXJlIGEgbmVlZCBmb3IuXG4gICAqXG4gICAqIFBlci1yZXBvIGNyZWRlbnRpYWwgc2NvcGluZyBpcyBJc3N1ZSAjNTczOyB0aGlzIGlzIHRoZSBzZWFtIGl0IHdpbGwgdXNlLFxuICAgKiBzbyBhIHJlcG9zaXRvcnkgdGhhdCBnZW51aW5lbHkgbmVlZHMgYSBjbG91ZCBjcmVkZW50aWFsIG5hbWVzIGl0IHRoZXJlXG4gICAqIHJhdGhlciB0aGFuIGV2ZXJ5IHJlcG9zaXRvcnkgaW5oZXJpdGluZyBpdC5cbiAgICovXG4gIGV4dHJhTmFtZXM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIFZhbHVlcyB0byBzZXQgb3V0cmlnaHQsIGFmdGVyIHRoZSBhbGxvd2xpc3QgaXMgYXBwbGllZC4gKi9cbiAgb3ZlcnJpZGVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgLyoqIEVudmlyb25tZW50IHNvdXJjZS4gSW5qZWN0ZWQgZm9yIHRlc3RzLiAqL1xuICBzb3VyY2U/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBlbnZpcm9ubWVudCBmb3IgYSBjb21tYW5kIHRoZSB3b3JrZXIgZG9lcyBub3QgY29udHJvbC5cbiAqXG4gKiBAcmV0dXJucyBPbmx5IHRoZSBhbGxvd2xpc3RlZCBuYW1lcyBwcmVzZW50IGluIHRoZSBzb3VyY2UsIHBsdXMgb3ZlcnJpZGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRVbnRydXN0ZWRDb21tYW5kRW52KFxuICBvcHRpb25zOiBVbnRydXN0ZWRDb21tYW5kRW52T3B0aW9ucyA9IHt9LFxuKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IHNvdXJjZSA9IG9wdGlvbnMuc291cmNlID8/IHJlYWRFbnZpcm9ubWVudCgpO1xuICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxzdHJpbmc+KFtcbiAgICAuLi5BTExPV0VEX0VOVl9OQU1FUyxcbiAgICAuLi4ob3B0aW9ucy5leHRyYU5hbWVzID8/IFtdKSxcbiAgXSk7XG5cbiAgY29uc3QgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGZvciAoY29uc3QgbmFtZSBvZiBhbGxvd2VkKSB7XG4gICAgY29uc3QgdmFsdWUgPSBzb3VyY2VbbmFtZV07XG4gICAgaWYgKHZhbHVlICE9PSB1bmRlZmluZWQpIGVudltuYW1lXSA9IHZhbHVlO1xuICB9XG4gIHJldHVybiB7IC4uLmVudiwgLi4uKG9wdGlvbnMub3ZlcnJpZGVzID8/IHt9KSB9O1xufVxuXG4vKiogVGhlIHByb2Nlc3MgZW52aXJvbm1lbnQsIG9yIGFuIGVtcHR5IG9iamVjdCB3aGVyZSBpdCBjYW5ub3QgYmUgcmVhZC4gKi9cbmZ1bmN0aW9uIHJlYWRFbnZpcm9ubWVudCgpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gRGVuby5lbnYudG9PYmplY3QoKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUnVubmluZyBhcyBhIGRpZmZlcmVudCBhY2NvdW50IChJc3N1ZSAjNTcxKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogVGhlIHVucHJpdmlsZWdlZCBhY2NvdW50IHVudHJ1c3RlZCBjb21tYW5kcyBydW4gYXMuXG4gKlxuICogU2VwYXJhdGUgZnJvbSB0aGUgd29ya2VyJ3Mgb3duIGFjY291bnQgc28gdGhhdCBmaWxlIHBlcm1pc3Npb25zIGFjdHVhbGx5XG4gKiBzZXBhcmF0ZSB0aGVtLiBUaGUgd29ya2VyJ3MgY3JlZGVudGlhbHMgYXJlIGAwNzAwIHZpYmVgLCBzbyB0aGUgbW9tZW50IHRoZVxuICogY29tbWFuZCBydW5zIGFzIHNvbWVib2R5IGVsc2UgaXQgY2Fubm90IHJlYWQgdGhlbSDigJQgd2hpY2ggaXMgdGhlIHdob2xlXG4gKiBwb2ludCwgYW5kIHNvbWV0aGluZyBubyBlbnZpcm9ubWVudCBhbGxvd2xpc3QgY2FuIGFjaGlldmUgb24gaXRzIG93bjogc2FtZVxuICogdWlkIG1lYW5zIHNhbWUgYWNjZXNzIHRvIGV2ZXJ5IGNyZWRlbnRpYWwgZmlsZSwgd2hhdGV2ZXIgdGhlIGVudmlyb25tZW50XG4gKiBzYXlzLlxuICovXG5leHBvcnQgY29uc3QgVU5UUlVTVEVEX1VTRVIgPSBcImFnZW50XCI7XG5cbi8qKlxuICogV3JhcCBhIGNvbW1hbmQgc28gaXQgcnVucyBhcyB7QGxpbmsgVU5UUlVTVEVEX1VTRVJ9LlxuICpcbiAqIFRoZSBjb250YWluZXIgcHJvY2VzcyBob2xkcyBOTyBjYXBhYmlsaXRpZXMgKGBDYXBFZmY6IDBgKSwgc28gaXQgY2Fubm90XG4gKiBjaGFuZ2UgdWlkIGJ5IGl0c2VsZiDigJQgYSBzZXR1aWQgaGVscGVyIGlzIHJlcXVpcmVkLCBhbmQgYHN1ZG9gIHdpdGggYVxuICogc2luZ2xlIG5hcnJvdyBydWxlIGlzIHRoZSBvbmUgdGhlIG9wZXJhdG9yIGNob3NlOlxuICpcbiAqICAgICB2aWJlIEFMTD0oYWdlbnQpIE5PUEFTU1dEOiA8dGhlIHBpbm5lZCBiaW5hcmllcz5cbiAqXG4gKiBgLW5gIG5ldmVyIHByb21wdHM6IHdpdGhvdXQgdGhlIHJ1bGUgdGhlIGNvbW1hbmQgZmFpbHMgaW1tZWRpYXRlbHkgYW5kXG4gKiBsb3VkbHkgcmF0aGVyIHRoYW4gaGFuZ2luZyBvbiBhIHBhc3N3b3JkIG5vYm9keSBjYW4gdHlwZS5cbiAqXG4gKiBAcGFyYW0gY21kIC0gVGhlIGNvbW1hbmQgYXMgc3Bhd25lZCB0b2RheS5cbiAqIEBwYXJhbSBvcHRpb25zLmVuYWJsZWQgLSBGYWxzZSBsZWF2ZXMgdGhlIGNvbW1hbmQgdW50b3VjaGVkLCB3aGljaCBpcyB0aGVcbiAqICAgYmVoYXZpb3VyIG9uIGFueSBob3N0IHdob3NlIGltYWdlIHByZWRhdGVzIHRoZSBgYWdlbnRgIGFjY291bnQuXG4gKiBAcmV0dXJucyBUaGUgY29tbWFuZCB0byBzcGF3bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzVW50cnVzdGVkVXNlcihcbiAgY21kOiByZWFkb25seSBzdHJpbmdbXSxcbiAgb3B0aW9uczogeyBlbmFibGVkOiBib29sZWFuOyB1c2VyPzogc3RyaW5nIH0gPSB7IGVuYWJsZWQ6IGZhbHNlIH0sXG4pOiBzdHJpbmdbXSB7XG4gIGlmICghb3B0aW9ucy5lbmFibGVkIHx8IGNtZC5sZW5ndGggPT09IDApIHJldHVybiBbLi4uY21kXTtcbiAgcmV0dXJuIFtcInN1ZG9cIiwgXCItblwiLCBcIi11XCIsIG9wdGlvbnMudXNlciA/PyBVTlRSVVNURURfVVNFUiwgXCItLVwiLCAuLi5jbWRdO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgdGhpcyBjb250YWluZXIgY2FuIHJ1biBhIGNvbW1hbmQgYXMgdGhlIHNlcGFyYXRlIGFjY291bnQuXG4gKlxuICogQm90aCBoYWx2ZXMgYXJlIHJlcXVpcmVkIGFuZCBib3RoIGFyZSBjaGVja2VkLCBiZWNhdXNlIGVpdGhlciBhbG9uZSBmYWlsc1xuICogYXQgc3Bhd24gdGltZSB3aXRoIGEgbWVzc2FnZSB0aGF0IGRvZXMgbm90IG5hbWUgdGhlIGNhdXNlOiB0aGUgYWNjb3VudCBtdXN0XG4gKiBleGlzdCwgYW5kIGBzdWRvYCBtdXN0IGJlIHByZXNlbnQgdG8gcmVhY2ggaXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYW5SdW5Bc1VudHJ1c3RlZFVzZXIoXG4gIHByb2JlOiAoY21kOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxib29sZWFuPiA9IGRlZmF1bHRQcm9iZSxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBpZiAoIWF3YWl0IHByb2JlKFtcImlkXCIsIFwiLXVcIiwgVU5UUlVTVEVEX1VTRVJdKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gYXdhaXQgcHJvYmUoW1wic3Vkb1wiLCBcIi1uXCIsIFwiLXVcIiwgVU5UUlVTVEVEX1VTRVIsIFwiLS1cIiwgXCJ0cnVlXCJdKTtcbn1cblxuLyoqXG4gKiBSdW5zIGEgY29tbWFuZCwgcmVwb3J0aW5nIG9ubHkgd2hldGhlciBpdCBzdWNjZWVkZWQuXG4gKlxuICogSXNzdWUgIzE1NTM6IHRoZSBiaW5hcnkgaXMgdGhlIGhlYWQgb2YgdGhlIGFyZ3YsIHNvIGEgYGdpdGAgcHJvYmUgaXNcbiAqIGRlbGVnYXRlZCB0byB0aGUgY2hva2Vwb2ludCByYXRoZXIgdGhhbiBzcGF3bmVkIGhlcmUgd2l0aG91dCBhIHRpbWVvdXQuXG4gKiBBIHRpbWVvdXQgaXMgdGhyb3duOiByZXR1cm5pbmcgZmFsc2Ugd291bGQgZHJvcCB0aGUgdW50cnVzdGVkIGFjY291bnQgYW5kXG4gKiBydW4gdGhlIHJlcG9zaXRvcnkncyBjb21tYW5kIGFzIHRoZSB3b3JrZXIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcm9iZUNvbW1hbmRTdWNjZXNzKFxuICBjbWQ6IHN0cmluZ1tdLFxuICB0aW1lb3V0TXM6IG51bWJlciA9IFVOVFJVU1RFRF9QUk9CRV9USU1FT1VUX01TLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGlmIChjbWRbMF0gPT09IFwiZ2l0XCIpIHJldHVybiAoYXdhaXQgcnVuR2l0QXJndihjbWQpKS5zdWNjZXNzO1xuICB0cnkge1xuICAgIGNvbnN0IG91dHB1dCA9IGF3YWl0IGNvbW1hbmRPdXRwdXRXaXRoVGltZW91dChjbWRbMF0gPz8gXCJcIiwge1xuICAgICAgYXJnczogY21kLnNsaWNlKDEpLFxuICAgICAgc3Rkb3V0OiBcIm51bGxcIixcbiAgICAgIHN0ZGVycjogXCJudWxsXCIsXG4gICAgICBzdGRpbjogXCJudWxsXCIsXG4gICAgICB0aW1lb3V0TXMsXG4gICAgfSk7XG4gICAgcmV0dXJuIG91dHB1dC5zdWNjZXNzO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChpc0NvbW1hbmRUaW1lb3V0RXJyb3IoZXJyb3IpKSB0aHJvdyBlcnJvcjtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZGVmYXVsdFByb2JlKGNtZDogc3RyaW5nW10pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgcmV0dXJuIGF3YWl0IHByb2JlQ29tbWFuZFN1Y2Nlc3MoY21kKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBp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
// denoCacheMetadata=17738141944483501250,711508752624964777