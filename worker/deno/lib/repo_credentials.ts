/**
 * Credentials a repository's own checks need, scoped to that repository and
 * minted per run where possible (Issues #573, #574).
 *
 * Two problems meet here.
 *
 * **Scope.** The fleet had no per-repo credential concept, so whatever was in
 * the host's environment was in scope for every repository it built — a key
 * that exists because one repo's quality gate needs it was also present while
 * the fleet built an unrelated public repository and ran its dependencies'
 * install hooks. Issue #572 closed that by building the child environment from
 * an allowlist instead of inheriting it, which means a repository that
 * genuinely needs a credential must now say so. This module is where it says
 * it.
 *
 * **Lifetime.** The incident that prompted all of this was a long-lived AWS
 * access key: disabled after AWS noticed, then a day of tracing where it had
 * escaped. That day is the cost of a credential that stays valid until someone
 * revokes it. A credential minted per run and expiring within the hour is
 * worthless by the time it reaches a log archive or a scraper — the leak is an
 * incident with a clock on it rather than an open door.
 *
 * So a repository declares either:
 *
 *   - `mint` — a command run once per use whose stdout is `KEY=value` lines.
 *     Provider-agnostic by design: `aws sts assume-role`, `gcloud auth
 *     print-access-token`, `vault read`, or a script of the operator's own.
 *     This is the preferred form and the one Issue #574 asks for.
 *   - `passthrough` — names taken from the worker's own environment. Static
 *     and long-lived by construction, so it is reported as such: it exists for
 *     what cannot yet be minted, not as an equal choice.
 *
 * Values never reach a log. Only names are ever reported, which is the same
 * rule the credential preflight follows.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";

/** What one repository's checks need. */
export interface RepoCredentialSpec {
  /**
   * Command whose stdout is `KEY=value` lines, run once per use.
   *
   * Preferred: a credential that expires is one a leak cannot spend.
   */
  mint?: string;
  /**
   * Variable names passed through from the worker's own environment.
   *
   * Long-lived by construction. Declared so it is deliberate and visible,
   * never ambient.
   */
  passthrough?: string[];
}

/** The resolved credentials, plus what the operator should know about them. */
export interface ResolvedRepoCredentials {
  /** Variables to place in the child environment. */
  env: Record<string, string>;
  /** Names only — a value never leaves this module. */
  names: string[];
  /** True when any name came from `passthrough` rather than `mint`. */
  usedLongLived: boolean;
}

/** Injected seams so no test ever runs a real credential command. */
export interface RepoCredentialDeps {
  /** Runs the mint command; resolves with its exit code and streams. */
  run: (
    command: string,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Reads a variable from the worker's own environment. */
  readEnv?: (name: string) => string | undefined;
  /** Warnings — names only, never values. */
  warn?: (message: string) => void;
}

/**
 * Parse `KEY=value` lines from a mint command's stdout.
 *
 * Blank lines and `#` comments are ignored so a script can explain itself.
 * A line without `=`, or with an empty name, is skipped rather than guessed
 * at — a malformed line must not become a variable with a surprising name.
 *
 * `export FOO=bar` is accepted because a shell script that can be `eval`ed is
 * the natural thing for an operator to write.
 */
export function parseMintedCredentials(stdout: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(separator + 1).trim();
    // A shell script's own quoting, removed once — the value is data.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[name] = value;
  }
  return env;
}

/**
 * Resolve the credentials one repository's checks may see.
 *
 * @returns The variables, or an error when a declared mint command failed —
 *   loudly, because a check that silently runs without its credential fails
 *   later and further from the cause.
 */
export async function resolveRepoCredentials(
  repo: string,
  spec: RepoCredentialSpec | undefined,
  deps: RepoCredentialDeps,
): Promise<Result<ResolvedRepoCredentials>> {
  const empty: ResolvedRepoCredentials = {
    env: {},
    names: [],
    usedLongLived: false,
  };
  if (!spec || (!spec.mint && !(spec.passthrough ?? []).length)) {
    return { ok: true, value: empty };
  }

  const env: Record<string, string> = {};
  let usedLongLived = false;

  if (spec.mint) {
    const outcome = await deps.run(spec.mint);
    if (outcome.code !== 0) {
      return {
        ok: false,
        error: new Error(
          `Minting credentials for ${repo} failed (exit ${outcome.code}): ` +
            `${outcome.stderr.trim().split("\n").slice(0, 3).join(" | ")}`,
        ),
      };
    }
    const minted = parseMintedCredentials(outcome.stdout);
    if (Object.keys(minted).length === 0) {
      return {
        ok: false,
        error: new Error(
          `The credential command for ${repo} produced no KEY=value lines — ` +
            `its checks would run without the credential they declared`,
        ),
      };
    }
    Object.assign(env, minted);
  }

  const readEnv = deps.readEnv ?? ((name: string) => Deno.env.get(name));
  for (const name of spec.passthrough ?? []) {
    const value = readEnv(name);
    if (value === undefined) continue;
    env[name] = value;
    usedLongLived = true;
  }

  if (usedLongLived) {
    deps.warn?.(
      `[SECURITY] ${repo} passes long-lived credentials to its checks ` +
        `(${
          (spec.passthrough ?? []).join(", ")
        }). A credential minted per run expires before a leak can be ` +
        `spent — prefer a \`mint\` command where the provider offers one ` +
        `(Issue #574).`,
    );
  }

  return {
    ok: true,
    value: { env, names: Object.keys(env).sort(), usedLongLived },
  };
}
