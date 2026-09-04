/**
 * Environment stubbing for tests (Issue #378).
 *
 * The worker container exports its own runtime configuration — `WORK_DIR`,
 * `VIBE_IMAGE_AGENT_PROVIDERS`, `UPDATE_GH_USER_STATUS` and friends — into
 * every `deno test` invocation. A test that saves and
 * restores only *some* of the variables its code path reads therefore
 * inherits the rest from whichever machine runs the suite: green on a
 * developer host, red inside the container, and useless as a gate either way.
 *
 * {@link withEnv} snapshots, replaces and restores a named set.
 * {@link withCleanEnv} goes further and hides *every* variable the caller did
 * not name, so a code path can only ever see what the test declared.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

/** Restore one variable to a captured value; `undefined` means "was unset". */
function restoreVar(name: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
}

/**
 * Variables kept by {@link withCleanEnv}: the ones the Deno runtime, the
 * temp-directory helpers and any spawned subprocess need to function. Nothing
 * here configures the worker, so keeping them cannot leak worker state into a
 * code path under test.
 */
export const RUNTIME_ENV_KEEP: readonly string[] = [
  "HOME",
  "PATH",
  "PWD",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "NO_COLOR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/**
 * Name prefixes kept by {@link withCleanEnv} alongside
 * {@link RUNTIME_ENV_KEEP} — Deno's own configuration (module cache, install
 * root) and the locale/XDG families that resolve it.
 */
export const RUNTIME_ENV_KEEP_PREFIXES: readonly string[] = [
  "DENO_",
  "LC_",
  "XDG_",
];

/** Is this variable part of the runtime the test itself runs on? */
function isRuntimeVar(name: string): boolean {
  return RUNTIME_ENV_KEEP.includes(name) ||
    RUNTIME_ENV_KEEP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Run `body` with the named environment variables replaced, then restore the
 * previous values — including deleting one that was previously unset.
 *
 * @param values - Name → value; `undefined` deletes the variable
 * @param body - The test body to run with the stubbed environment
 * @returns Whatever `body` returns
 */
export async function withEnv<T>(
  values: Record<string, string | undefined>,
  body: () => T | Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Deno.env.get(name));
    restoreVar(name, value);
  }
  try {
    return await body();
  } finally {
    for (const [name, value] of previous) restoreVar(name, value);
  }
}

/**
 * Run `body` with an environment holding `values` plus the runtime variables
 * of {@link RUNTIME_ENV_KEEP} — and nothing else. Every other variable the
 * process carries is removed for the duration and restored afterwards, so the
 * result cannot depend on the ambient worker configuration of the machine
 * running the suite.
 *
 * @param values - Name → value the code path under test is allowed to see
 * @param body - The test body to run with the cleaned environment
 * @returns Whatever `body` returns
 */
export async function withCleanEnv<T>(
  values: Record<string, string | undefined>,
  body: () => T | Promise<T>,
): Promise<T> {
  const cleared: Record<string, string | undefined> = {};
  for (const name of Object.keys(Deno.env.toObject())) {
    if (isRuntimeVar(name)) continue;
    cleared[name] = undefined;
  }
  return await withEnv({ ...cleared, ...values }, body);
}
