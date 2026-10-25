/**
 * Local evaluation of useful-and-secure code (Issue #4368).
 *
 * Scores fixture implementations with authoritative tests that live outside
 * the implementation directory. Functionality and security are separate.
 * Empty output, a TODO stub, unconditional success, deny-all and an unwired
 * helper fail functional acceptance. A working insecure implementation fails
 * security. A secure implementation passes both.
 *
 * This is not a fleet scheduler and it does not import SecurityEval. A live
 * model comparison is recorded as partial when no model run is configured.
 * A missing cost is unknown, never zero.
 *
 * Australian English throughout (authorise, behaviour).
 *
 * @module
 */

import { loadTrustedCapabilityBundle } from "./capability_security_guidance.ts";
import { commandOutputWithTimeout } from "./subprocess_timeout.ts";

export const EVAL_FIXTURE_REVISION = "2026-10-26.1";

export const EVAL_ARMS = [
  "empty",
  "stub",
  "deny_all",
  "unwired",
  "unconditional",
  "insecure",
  "secure",
] as const;

export type EvalArm = typeof EVAL_ARMS[number];

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
) => Promise<CommandResult>;

export interface DimensionScore {
  pass: boolean;
  executed: boolean;
}

export interface ArmOutcome {
  task: string;
  arm: string;
  functional: DimensionScore;
  security: DimensionScore;
  joint: boolean;
  detail: string;
  retries: number;
}

export interface EvalArtefact {
  revision: {
    guidance: string | null;
    fixtures: string;
    scanner: string;
  };
  liveComparison: "partial";
  liveBlocker: string;
  retryPath: string;
  winner: null;
  cost: { status: "unknown"; reason: string };
  outcomes: ArmOutcome[];
  skips: { arm: string; reason: string }[];
}

export function repoRootFromModule(): string {
  return decodeURIComponent(new URL("../../../", import.meta.url).pathname);
}

/** Parse Deno or Cargo test output into per-dimension scores. */
function stripAnsi(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 27) {
      out += text[i] ?? "";
      continue;
    }
    if (text[i + 1] === "[") {
      i += 2;
      while (i < text.length && text[i] !== "m") i++;
    }
  }
  return out;
}

export function scoreTestOutput(output: string, spawned: boolean): {
  functional: DimensionScore;
  security: DimensionScore;
  detail: string;
} {
  if (!spawned) {
    const failed = { pass: false, executed: false };
    return {
      functional: failed,
      security: failed,
      detail: "acceptance tests were not executed",
    };
  }
  const plain = stripAnsi(output);
  const typescript = plain.includes("functional:");
  const rust = plain.includes("functional_authorised_update_persists");
  if (!typescript && !rust) {
    const failed = { pass: false, executed: false };
    return {
      functional: failed,
      security: failed,
      detail: "acceptance tests did not report a result",
    };
  }
  const functionalNames = typescript
    ? ["functional: authorised update persists"]
    : ["functional_authorised_update_persists"];
  const securityNames = typescript
    ? ["security: cross-tenant rejected", "security: privileged field rejected"]
    : ["security_cross_tenant_rejected", "security_privileged_field_rejected"];
  return {
    functional: dimension(plain, functionalNames),
    security: dimension(plain, securityNames),
    detail: "acceptance tests executed",
  };
}

function dimension(output: string, names: readonly string[]): DimensionScore {
  const executed = names.some((name) => output.includes(name));
  return {
    pass: names.every((name) => linePassed(output, name)),
    executed,
  };
}

function linePassed(output: string, name: string): boolean {
  for (const line of output.split("\n")) {
    if (!line.includes(name)) continue;
    if (/\bFAILED\b|\bfailed\b|\bpanic\b/.test(line)) return false;
    if (/\bok\b/.test(line)) return true;
  }
  return false;
}

async function sha256File(path: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashTree(paths: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const path of paths) parts.push(`${path}\0${await sha256File(path)}`);
  return parts.join("\n");
}

export const defaultCommandRunner: CommandRunner = async (
  command,
  args,
  cwd,
  env,
) => {
  try {
    const out = await commandOutputWithTimeout(command, {
      timeoutMs: 60_000,
      args,
      cwd,
      env: { ...Deno.env.toObject(), ...env },
      stdout: "piped",
      stderr: "piped",
    });
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (error) {
    return {
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

async function runOnceWithRetry(
  runner: CommandRunner,
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ result: CommandResult; retries: number }> {
  const first = await runner(command, args, cwd, env);
  if (first.code !== null) return { result: first, retries: 0 };
  const second = await runner(command, args, cwd, env);
  return { result: second, retries: 1 };
}

async function copyFile(from: string, to: string): Promise<void> {
  await Deno.mkdir(to.slice(0, to.lastIndexOf("/")), { recursive: true });
  await Deno.copyFile(from, to);
}

export async function runCapabilitySecurityEval(options: {
  root?: string;
  runner?: CommandRunner;
  outPath?: string;
} = {}): Promise<EvalArtefact> {
  const root = options.root ?? repoRootFromModule();
  const runner = options.runner ?? defaultCommandRunner;
  const guidance = await loadTrustedCapabilityBundle();
  const guidanceRevision = guidance.kind === "loaded"
    ? guidance.bundle.revision
    : null;
  const outcomes: ArmOutcome[] = [];
  const skips: { arm: string; reason: string }[] = [
    {
      arm: "current-guidance",
      reason:
        "Live model arm skipped: no model invocation is configured. Retry the same command when a subscription-backed provider is available.",
    },
    {
      arm: "generic-secure-coding",
      reason:
        "Live model arm skipped: no model invocation is configured. Retry the same command when a subscription-backed provider is available.",
    },
    {
      arm: "codeguard-derived",
      reason:
        "Live model arm skipped: no model invocation is configured. Retry the same command when a subscription-backed provider is available.",
    },
  ];

  for (const arm of EVAL_ARMS) {
    outcomes.push(await scoreTypescriptArm(root, arm, runner));
    outcomes.push(await scoreRustArm(root, arm, runner, skips));
  }

  const artefact: EvalArtefact = {
    revision: {
      guidance: guidanceRevision,
      fixtures: EVAL_FIXTURE_REVISION,
      scanner: EVAL_FIXTURE_REVISION,
    },
    liveComparison: "partial",
    liveBlocker:
      "No live model invocation is configured for this command. Fixture arms were executed; model arms were not.",
    retryPath:
      "Re-run this command when a subscription-backed provider is available. Do not record a winner until a matched comparison finishes.",
    winner: null,
    cost: {
      status: "unknown",
      reason:
        "A dry run does not call a model. A missing cost is unknown, never zero.",
    },
    outcomes,
    skips,
  };
  if (options.outPath) {
    await Deno.mkdir(
      options.outPath.slice(0, options.outPath.lastIndexOf("/")),
      {
        recursive: true,
      },
    );
    await Deno.writeTextFile(
      options.outPath,
      `${JSON.stringify(artefact, null, 2)}\n`,
    );
  }
  return artefact;
}

async function scoreTypescriptArm(
  root: string,
  arm: EvalArm,
  runner: CommandRunner,
): Promise<ArmOutcome> {
  const task = "ts-resource-update";
  const accept =
    `${root}/evals/capability_security/accept/ts_resource_update_test.ts`;
  const impl = `${root}/evals/capability_security/impls/ts/${arm}.ts`;
  const tmp = await Deno.makeTempDir({ prefix: "capsec-eval-ts-" });
  try {
    const acceptCopy = `${tmp}/accept_test.ts`;
    const implCopy = `${tmp}/impl.ts`;
    await copyFile(accept, acceptCopy);
    await copyFile(impl, implCopy);
    const before = await hashTree([acceptCopy]);
    const { result, retries } = await runOnceWithRetry(
      runner,
      "deno",
      ["test", "--allow-env", "--allow-read", acceptCopy],
      tmp,
      { CAPSEC_IMPL: implCopy },
    );
    const after = await hashTree([acceptCopy]);
    if (before !== after) {
      return blocked(task, arm, "acceptance tests were modified", retries);
    }
    if (result.code === null) {
      return blocked(
        task,
        arm,
        `deno could not be started: ${result.stderr}`,
        retries,
      );
    }
    const scored = scoreTestOutput(`${result.stdout}\n${result.stderr}`, true);
    return {
      task,
      arm,
      ...scored,
      joint: scored.functional.pass && scored.security.pass,
      retries,
    };
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

async function scoreRustArm(
  root: string,
  arm: EvalArm,
  runner: CommandRunner,
  skips: { arm: string; reason: string }[],
): Promise<ArmOutcome> {
  const task = "rust-resource-update";
  const acceptDir = `${root}/evals/capability_security/accept/rust`;
  const impl = `${root}/evals/capability_security/impls/rust/${arm}/lib.rs`;
  const tmp = await Deno.makeTempDir({ prefix: "capsec-eval-rs-" });
  try {
    await copyFile(
      `${acceptDir}/Cargo.toml`,
      `${tmp}/Cargo.toml`,
    );
    await copyFile(
      `${acceptDir}/tests/accept.rs`,
      `${tmp}/tests/accept.rs`,
    );
    await copyFile(impl, `${tmp}/src/lib.rs`);
    const before = await hashTree([`${tmp}/tests/accept.rs`]);
    const { result, retries } = await runOnceWithRetry(
      runner,
      "cargo",
      ["test", "--offline", "--color", "never"],
      tmp,
    );
    const after = await hashTree([`${tmp}/tests/accept.rs`]);
    if (before !== after) {
      return blocked(task, arm, "acceptance tests were modified", retries);
    }
    if (result.code === null) {
      const reason = `cargo could not be started: ${result.stderr}`;
      skips.push({ arm: `${task}/${arm}`, reason });
      return blocked(task, arm, reason, retries);
    }
    const spawned = !/could not find `cargo`|No such file|not found/i.test(
      result.stderr,
    );
    if (!spawned) {
      const reason =
        "cargo is not available; rust acceptance tests were not executed";
      skips.push({ arm: `${task}/${arm}`, reason });
      return blocked(task, arm, reason, retries);
    }
    const scored = scoreTestOutput(`${result.stdout}\n${result.stderr}`, true);
    return {
      task,
      arm,
      ...scored,
      joint: scored.functional.pass && scored.security.pass,
      retries,
    };
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

function blocked(
  task: string,
  arm: string,
  detail: string,
  retries: number,
): ArmOutcome {
  const failed = { pass: false, executed: false };
  return {
    task,
    arm,
    functional: failed,
    security: failed,
    joint: false,
    detail,
    retries,
  };
}
