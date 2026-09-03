/**
 * Conformance fixture for the post-run callback contract (Issue #807, parent
 * #796).
 *
 * The contract itself lives in {@link file://./run_callbacks.ts} and is
 * documented in [`docs/CALLBACKS.md`](../../../docs/CALLBACKS.md). This module
 * is the **executable proof** of it: a third-party extension runs the fixture
 * where it is actually deployed — inside the container, on that filesystem,
 * with its own hooks — and gets a per-property verdict instead of a promise.
 *
 * ```mermaid
 * flowchart LR
 *     E["Extension author"] --> C["callback-conformance"]
 *     C --> R["Real invokeRunCallbacks<br/>real /bin/sh hooks"]
 *     R --> V["6 verdicts:<br/>PASS / FAIL"]
 * ```
 *
 * Six properties, one check each — the ones an extension's correctness rests
 * on:
 *
 * 1. a successful run fires `success`, then `always`;
 * 2. a failed run fires `failure`, then `always`;
 * 3. a failed *or* timed-out outcome hook still leaves `always` running;
 * 4. a callback fault leaves the original VibeCoder result unchanged;
 * 5. context fields identify the correct concurrent run;
 * 6. the session transcript path, when present, belongs to that run — and its
 *    contents are never exported.
 *
 * Every check drives the **production** runner over **real** subprocesses, so
 * a pass is a statement about this environment rather than about a mock. One
 * seam is injected, and only one: check 6 turns the transcript tee on for the
 * context it builds, because a fixture cannot re-run the agent that would
 * otherwise have written the transcript.
 *
 * ## Which hooks a check uses
 *
 * With no {@link CallbackConformanceOptions.hooks} supplied, the fixture
 * writes its own portable `/bin/sh` hooks and proves the contract. An
 * extension that supplies its own hook paths has them driven for checks 1 and
 * 2, and its `always` hook for check 3, so the verdict covers its executables
 * at the absolute paths the worker will really use.
 *
 * Checks that need a **deliberate fault** (a hook that exits non-zero or
 * hangs) always inject a fixture hook for the faulting side: an extension's
 * hook cannot be asked to fail on demand. Checks 5 and 6 need to observe what
 * a hook *saw*, so they use fixture hooks that record their environment.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  type CallbackInvocation,
  invokeRunCallbacks,
  type IssueRunCallbackContext,
} from "./run_callbacks.ts";
import type { CallbacksConfig } from "./run_callbacks_config.ts";
import { buildIssueRunCallbackContext } from "./run_callback_context.ts";
import { agentTranscriptPath } from "./agent_transcript.ts";

/** The checks the fixture runs, in the order it runs them. */
export const CONFORMANCE_CHECK_IDS = [
  "success-then-always",
  "failure-then-always",
  "always-after-outcome-fault",
  "result-unchanged-by-callback-fault",
  "concurrent-context-isolation",
  "session-log-belongs-to-run",
] as const;

/** One of {@link CONFORMANCE_CHECK_IDS}. */
export type ConformanceCheckId = typeof CONFORMANCE_CHECK_IDS[number];

/** What each check claims, in one line. */
const CHECK_TITLES: Record<ConformanceCheckId, string> = {
  "success-then-always": "a successful run runs success, then always",
  "failure-then-always": "a failed run runs failure, then always",
  "always-after-outcome-fault":
    "always still runs after a failed or timed-out outcome hook",
  "result-unchanged-by-callback-fault":
    "a callback fault leaves the original VibeCoder result unchanged",
  "concurrent-context-isolation":
    "context fields identify the correct concurrent run",
  "session-log-belongs-to-run":
    "the session transcript path, when present, belongs to that run",
};

/** Hook paths an extension wants driven through the contract. */
export interface ConformanceHooks {
  success?: string;
  failure?: string;
  always?: string;
}

/** Inputs to {@link runCallbackConformance}. */
export interface CallbackConformanceOptions {
  /** The extension's own hooks; fixture hooks are used where absent. */
  hooks?: ConformanceHooks;
  /** Wall-clock budget per hook. Defaults to {@link DEFAULT_TIMEOUT_SECONDS}. */
  timeoutSeconds?: number;
}

/** Verdict on one contract property. */
export interface ConformanceCheck {
  id: ConformanceCheckId;
  title: string;
  passed: boolean;
  /** What was observed — the evidence behind the verdict, pass or fail. */
  detail: string;
}

/** The fixture's full result. */
export interface CallbackConformanceReport {
  /** True only when every check passed. */
  passed: boolean;
  checks: ConformanceCheck[];
  /** Hook paths the extension supplied, echoed back. */
  hooks: ConformanceHooks;
}

/** Default per-hook budget: generous enough for a slow filesystem. */
export const DEFAULT_TIMEOUT_SECONDS = 10;

/** Budget used by the scenario that deliberately hangs a hook. */
const HANG_TIMEOUT_SECONDS = 1;

/**
 * Write an executable POSIX hook and return its absolute path.
 *
 * Exported because the fixture's own tests write extension-side hooks the
 * same way, and two copies of the mode/`chmod` pairing would be one too many.
 */
export async function writeHook(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  // Written and set explicitly: an inherited umask can strip the execute bit
  // from the mode above, and a hook that cannot be spawned would look like a
  // contract failure rather than a fixture bug.
  await Deno.chmod(path, 0o700);
  return path;
}

/** Fixture hook body: append this event to the check's evidence file. */
function recordEvent(dir: string, event: string): string {
  return `echo "${event}" >> "${dir}/evidence.txt"`;
}

/**
 * Events a fixture hook recorded, in order.
 *
 * "No file" is the meaningful answer "no hook ran". Any other read fault is
 * the fixture failing, not the contract, and is raised rather than flattened
 * into an empty list that would read as a contract failure.
 */
async function evidence(dir: string): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(`${dir}/evidence.txt`);
    return text.split("\n").filter((line) => line !== "");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

/** A scenario context; overrides name whatever the scenario varies. */
function scenarioContext(
  overrides: Partial<IssueRunCallbackContext> = {},
): IssueRunCallbackContext {
  return {
    runId: "vibe-conformance-1",
    result: "success",
    repository: "example/extension",
    issueNumber: 807,
    host: "conformance-host",
    startedAt: "2026-09-03T00:00:00.000Z",
    finishedAt: "2026-09-03T00:00:30.000Z",
    durationSeconds: 30,
    exitCode: 0,
    ...overrides,
  };
}

/** One invocation of the production runner, with its logs captured. */
async function invoke(
  callbacks: CallbacksConfig,
  context: IssueRunCallbackContext,
): Promise<{
  invocations: CallbackInvocation[];
  logs: string[];
  errors: string[];
}> {
  const logs: string[] = [];
  const errors: string[] = [];
  const invocations = await invokeRunCallbacks({
    callbacks,
    context,
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
  });
  return { invocations, logs, errors };
}

/** How an invocation reads in a failure detail. */
function describe(invocation: CallbackInvocation | undefined): string {
  if (!invocation) return "no invocation";
  return `${invocation.event}=${invocation.status}(exit ${invocation.exitCode})`;
}

/** The sequence of invocations, for a detail line. */
function describeAll(invocations: CallbackInvocation[]): string {
  return invocations.length === 0
    ? "nothing ran"
    : invocations.map((one) => describe(one)).join(" → ");
}

/** Collects what a check found wanting; empty means the property held. */
class Faults {
  private readonly found: string[] = [];

  /** Record a fault unless the condition held. */
  expect(condition: boolean, fault: string): void {
    if (!condition) this.found.push(fault);
  }

  get problems(): string[] {
    return this.found;
  }
}

/** Turn a check's findings into its verdict. */
function verdict(
  id: ConformanceCheckId,
  faults: Faults,
  evidenceLine: string,
): ConformanceCheck {
  return {
    id,
    title: CHECK_TITLES[id],
    passed: faults.problems.length === 0,
    detail: faults.problems.length === 0
      ? evidenceLine
      : faults.problems.join("; "),
  };
}

/** A sub-directory of the scratch area, one per scenario. */
async function scenarioDir(root: string, name: string): Promise<string> {
  const dir = `${root}/${name}`;
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Checks 1 and 2: the outcome hook matching the result runs, then `always`,
 * each exactly once, and the other outcome hook never runs.
 */
async function checkOutcomeOrder(
  id: "success-then-always" | "failure-then-always",
  result: "success" | "failure",
  root: string,
  options: Required<Pick<CallbackConformanceOptions, "timeoutSeconds">> & {
    hooks: ConformanceHooks;
  },
): Promise<ConformanceCheck> {
  const dir = await scenarioDir(root, id);
  const faults = new Faults();
  // A fixture hook records its event, so "exactly once" is provable on disk;
  // an extension's own hook is proved through the invocation record instead.
  const fixtureEvents: string[] = [];
  const hookFor = async (event: "success" | "failure" | "always") => {
    const supplied = options.hooks[event];
    if (supplied !== undefined) return supplied;
    if (event === result || event === "always") fixtureEvents.push(event);
    return await writeHook(dir, `${event}.sh`, recordEvent(dir, event));
  };

  const callbacks: CallbacksConfig = {
    success: await hookFor("success"),
    failure: await hookFor("failure"),
    always: await hookFor("always"),
    timeoutSeconds: options.timeoutSeconds,
  };

  const { invocations } = await invoke(
    callbacks,
    scenarioContext({ result, exitCode: result === "success" ? 0 : 1 }),
  );

  const expected = [result, "always"];
  faults.expect(
    JSON.stringify(invocations.map((one) => one.event)) ===
      JSON.stringify(expected),
    `expected ${expected.join(" → ")}, got ${describeAll(invocations)}`,
  );
  for (const one of invocations) {
    faults.expect(
      one.status === "ok",
      `${one.event} hook ${one.status}: ${describe(one)} ${one.stderr}`.trim(),
    );
  }
  const recorded = await evidence(dir);
  faults.expect(
    JSON.stringify(recorded) === JSON.stringify(fixtureEvents),
    `fixture hooks recorded ${recorded.join(", ") || "nothing"}, expected ${
      fixtureEvents.join(", ") || "nothing"
    } — each hook must run exactly once`,
  );

  return verdict(id, faults, `${describeAll(invocations)}, exactly once each`);
}

/** Check 3: a faulting outcome hook never cancels `always`. */
async function checkAlwaysAfterFault(
  root: string,
  hooks: ConformanceHooks,
  timeoutSeconds: number,
): Promise<ConformanceCheck> {
  const id = "always-after-outcome-fault" as const;
  const faults = new Faults();
  const observed: string[] = [];

  // Scenario A — the outcome hook exits non-zero.
  const failedDir = await scenarioDir(root, `${id}-exit`);
  const failing = await invoke({
    // Injected: an extension's hook cannot be asked to fail on demand.
    success: await writeHook(failedDir, "success.sh", "exit 7"),
    always: hooks.always ??
      await writeHook(
        failedDir,
        "always.sh",
        recordEvent(failedDir, "always"),
      ),
    timeoutSeconds,
  }, scenarioContext());
  observed.push(`after exit 7: ${describeAll(failing.invocations)}`);
  faults.expect(
    failing.invocations[0]?.status === "failed" &&
      failing.invocations[0]?.exitCode === 7,
    `an outcome hook exiting 7 was recorded as ${
      describe(failing.invocations[0])
    }`,
  );
  faults.expect(
    failing.invocations[1]?.event === "always" &&
      failing.invocations[1]?.status === "ok",
    `always must still run after a failed outcome hook, got ${
      describe(failing.invocations[1])
    }`,
  );

  // Scenario B — the outcome hook hangs past its budget. `exec` so the
  // timeout's signal lands on the sleeping process rather than a shell that
  // outlives it.
  const hungDir = await scenarioDir(root, `${id}-timeout`);
  const hung = await invoke({
    success: await writeHook(hungDir, "success.sh", "exec sleep 30"),
    always: hooks.always ??
      await writeHook(hungDir, "always.sh", recordEvent(hungDir, "always")),
    timeoutSeconds: HANG_TIMEOUT_SECONDS,
  }, scenarioContext());
  observed.push(`after a hang: ${describeAll(hung.invocations)}`);
  faults.expect(
    hung.invocations[0]?.status === "timed_out" &&
      hung.invocations[0]?.exitCode === 124,
    `a hook exceeding its ${HANG_TIMEOUT_SECONDS}s budget was recorded as ${
      describe(hung.invocations[0])
    }`,
  );
  faults.expect(
    hung.invocations[1]?.event === "always" &&
      hung.invocations[1]?.status === "ok",
    `always must still run after a timed-out outcome hook, got ${
      describe(hung.invocations[1])
    }`,
  );

  return verdict(id, faults, observed.join("; "));
}

/** Check 4: a callback fault is reported, never allowed to rewrite the run. */
async function checkResultUnchanged(root: string): Promise<ConformanceCheck> {
  const id = "result-unchanged-by-callback-fault" as const;
  const faults = new Faults();
  const dir = await scenarioDir(root, id);

  // The terminal run as the worker holds it, before any hook is spawned.
  const context = scenarioContext({ result: "failure", exitCode: 1 });
  const before = { result: context.result, exitCode: context.exitCode };

  // A hostile outcome hook: it fails *and* rewrites its own context document
  // to claim the run succeeded. Both hooks fault, so nothing here rests on a
  // hook behaving well.
  const callbacks: CallbacksConfig = {
    failure: await writeHook(
      dir,
      "failure.sh",
      [
        `printf '{"result":"success","exitCode":0}' > "$VIBECODER_CALLBACK_CONTEXT"`,
        "echo boom >&2",
        "exit 9",
      ].join("\n"),
    ),
    always: await writeHook(
      dir,
      "always.sh",
      `cp "$VIBECODER_CALLBACK_CONTEXT" "${dir}/always-context.json"\nexit 5`,
    ),
    timeoutSeconds: HANG_TIMEOUT_SECONDS,
  };

  let threw: string | undefined;
  let invocations: CallbackInvocation[] = [];
  let errors: string[] = [];
  try {
    const attempt = await invoke(callbacks, context);
    invocations = attempt.invocations;
    errors = attempt.errors;
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }

  faults.expect(
    threw === undefined,
    `a callback fault propagated to the caller: ${threw}`,
  );
  faults.expect(
    context.result === before.result && context.exitCode === before.exitCode,
    `the run's own result changed from ${before.result}/${before.exitCode} to ${context.result}/${context.exitCode}`,
  );
  // What the *next* hook was told is the observable proof that the first
  // hook's tampering went nowhere: each invocation gets its own document,
  // built from the run's own facts.
  let handedOn: Record<string, unknown> = {};
  try {
    handedOn = JSON.parse(
      await Deno.readTextFile(`${dir}/always-context.json`),
    );
  } catch (error) {
    faults.expect(false, `the always hook received no context: ${error}`);
  }
  faults.expect(
    handedOn.result === before.result && handedOn.exitCode === before.exitCode,
    `a hook rewrote the next hook's context: it was told ${
      JSON.stringify({
        result: handedOn.result,
        exitCode: handedOn.exitCode,
      })
    }`,
  );
  faults.expect(
    invocations.every((one) => one.status !== "ok"),
    `the faulting hooks were recorded as ${describeAll(invocations)}`,
  );
  faults.expect(
    errors.some((message) => message.includes("unchanged")),
    "a callback fault must be reported loudly, naming the unchanged result",
  );

  return verdict(
    id,
    faults,
    `${
      describeAll(invocations)
    }; result stayed ${before.result} (exit ${before.exitCode})`,
  );
}

/** Check 5: concurrent runs never see each other's context. */
async function checkConcurrentIsolation(
  root: string,
  timeoutSeconds: number,
): Promise<ConformanceCheck> {
  const id = "concurrent-context-isolation" as const;
  const faults = new Faults();
  const dir = await scenarioDir(root, id);

  // Fixture hooks: the property is about what a hook *saw*, so the hook has
  // to report its own environment and context document.
  const report = [
    `echo "$VIBECODER_CALLBACK_EVENT|$VIBECODER_RUN_ID|$VIBECODER_ISSUE_NUMBER|$VIBECODER_RESULT" >> "${dir}/evidence.txt"`,
    `cp "$VIBECODER_CALLBACK_CONTEXT" "${dir}/ctx-$VIBECODER_RUN_ID-$VIBECODER_CALLBACK_EVENT.json"`,
  ].join("\n");
  const callbacks: CallbacksConfig = {
    success: await writeHook(dir, "success.sh", report),
    failure: await writeHook(dir, "failure.sh", report),
    always: await writeHook(dir, "always.sh", report),
    timeoutSeconds,
  };

  const runs = [
    { runId: "vibe-conformance-a", issueNumber: 101, result: "success" },
    { runId: "vibe-conformance-b", issueNumber: 202, result: "failure" },
  ] as const;
  await Promise.all(runs.map((run) =>
    invoke(
      callbacks,
      scenarioContext({
        runId: run.runId,
        issueNumber: run.issueNumber,
        result: run.result,
        exitCode: run.result === "success" ? 0 : 1,
      }),
    )
  ));

  const lines = await evidence(dir);
  faults.expect(
    lines.length === runs.length * 2,
    `expected ${runs.length * 2} hook invocations, saw ${lines.length}`,
  );
  for (const run of runs) {
    for (const event of [run.result, "always"]) {
      const expected = `${event}|${run.runId}|${run.issueNumber}|${run.result}`;
      faults.expect(
        lines.filter((line) => line === expected).length === 1,
        `${run.runId} expected exactly one "${expected}", saw ${
          lines.filter((line) => line.includes(run.runId)).join(" / ") || "none"
        }`,
      );
      const path = `${dir}/ctx-${run.runId}-${event}.json`;
      let document: Record<string, unknown> = {};
      try {
        document = JSON.parse(await Deno.readTextFile(path));
      } catch (error) {
        faults.expect(false, `${path} unreadable: ${error}`);
      }
      faults.expect(
        document.runId === run.runId &&
          document.issueNumber === run.issueNumber &&
          document.result === run.result,
        `the context document for ${run.runId}/${event} named ${
          JSON.stringify({
            runId: document.runId,
            issueNumber: document.issueNumber,
            result: document.result,
          })
        }`,
      );
    }
  }

  return verdict(
    id,
    faults,
    `each concurrent run saw only its own facts (${lines.join(", ")})`,
  );
}

/**
 * Check 6: the transcript path a hook receives is this run's, and only its
 * path — never its contents.
 */
async function checkSessionLogBelongsToRun(
  root: string,
  timeoutSeconds: number,
): Promise<ConformanceCheck> {
  const id = "session-log-belongs-to-run" as const;
  const faults = new Faults();
  const dir = await scenarioDir(root, id);
  const home = await scenarioDir(dir, "home");
  await Deno.mkdir(`${home}/logs`, { recursive: true });

  const withTranscript = {
    runId: "vibe-conformance-transcript",
    issueNumber: 807,
  };
  const secret = "TRANSCRIPT-BODY-MUST-NOT-BE-EXPORTED";
  const transcript = agentTranscriptPath(
    `${home}/logs`,
    withTranscript.runId,
    withTranscript.issueNumber,
  );
  await Deno.writeTextFile(transcript, `{"marker":"${secret}"}\n`);

  const terminalRun = (issueNumber: number) => ({
    repo: "example/extension",
    issueNumber,
    result: "success" as const,
    startedAtEpochMs: 1_772_000_000_000,
    finishedAtEpochMs: 1_772_000_030_000,
  });

  // The run that wrote a transcript publishes its path; a different run, with
  // no transcript of its own, publishes none.
  const present = buildIssueRunCallbackContext(
    terminalRun(withTranscript.issueNumber),
    { runId: withTranscript.runId, host: "conformance-host", home },
    { transcriptEnabled: () => true },
  );
  const absent = buildIssueRunCallbackContext(
    terminalRun(808),
    { runId: "vibe-conformance-no-transcript", host: "conformance-host", home },
    { transcriptEnabled: () => true },
  );

  faults.expect(
    present.sessionLogPath === transcript,
    `the transcript-carrying run published ${present.sessionLogPath} rather than ${transcript}`,
  );
  faults.expect(
    absent.sessionLogPath === undefined,
    `a run with no transcript published ${absent.sessionLogPath}`,
  );

  const callbacks: CallbacksConfig = {
    success: await writeHook(
      dir,
      "success.sh",
      [
        `echo "$VIBECODER_SESSION_LOG_PATH" > "${dir}/path-$VIBECODER_RUN_ID.txt"`,
        `env > "${dir}/env-$VIBECODER_RUN_ID.txt"`,
      ].join("\n"),
    ),
    timeoutSeconds,
  };
  await invoke(callbacks, present);
  await invoke(callbacks, absent);

  // "No file" means the hook wrote nothing, which is a verdict; any other
  // read fault is the fixture's own and is raised rather than hidden.
  const read = async (path: string) => {
    try {
      return (await Deno.readTextFile(path)).trim();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return "";
      throw error;
    }
  };
  const published = await read(`${dir}/path-${withTranscript.runId}.txt`);
  faults.expect(
    published === transcript,
    `the hook received ${published || "no path"} rather than ${transcript}`,
  );
  faults.expect(
    published.includes(withTranscript.runId),
    `${published} does not identify run ${withTranscript.runId}`,
  );
  faults.expect(
    (await read(`${dir}/path-vibe-conformance-no-transcript.txt`)) === "",
    "a run with no transcript must export no path at all",
  );
  const childEnv = await read(`${dir}/env-${withTranscript.runId}.txt`);
  faults.expect(
    !childEnv.includes(secret),
    "transcript contents must never be exported into a hook's environment",
  );

  return verdict(
    id,
    faults,
    `${transcript} published to its own run only; contents never exported`,
  );
}

/**
 * Run the conformance fixture and report a verdict per contract property.
 *
 * Never throws for a failing property — a failure is a `passed: false` check
 * with the evidence in its detail, so a caller reports every fault rather
 * than the first. A fixture that cannot be set up at all (no writable scratch
 * directory) does throw: that is the fixture failing, not the contract.
 */
export async function runCallbackConformance(
  options: CallbackConformanceOptions = {},
): Promise<CallbackConformanceReport> {
  const hooks = options.hooks ?? {};
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const root = await Deno.makeTempDir({
    prefix: "vibe-callback-conformance-",
  });

  try {
    const checks: ConformanceCheck[] = [
      await checkOutcomeOrder("success-then-always", "success", root, {
        hooks,
        timeoutSeconds,
      }),
      await checkOutcomeOrder("failure-then-always", "failure", root, {
        hooks,
        timeoutSeconds,
      }),
      await checkAlwaysAfterFault(root, hooks, timeoutSeconds),
      await checkResultUnchanged(root),
      await checkConcurrentIsolation(root, timeoutSeconds),
      await checkSessionLogBelongsToRun(root, timeoutSeconds),
    ];
    return {
      passed: checks.every((one) => one.passed),
      checks,
      hooks,
    };
  } finally {
    try {
      await Deno.remove(root, { recursive: true });
    } catch (error) {
      // Never fatal — the verdicts are already computed — but never silent
      // either: a scratch tree left behind on every run fills the volume.
      console.warn(
        `[callback-conformance] scratch directory ${root} could not be removed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Render a report for a person reading a terminal. */
export function formatConformanceReport(
  report: CallbackConformanceReport,
): string {
  const passed = report.checks.filter((one) => one.passed).length;
  const lines = report.checks.map((one) =>
    `${
      one.passed ? "PASS" : "FAIL"
    } ${one.id} — ${one.title}\n     ${one.detail}`
  );
  return [
    `Post-run callback conformance: ${passed}/${report.checks.length} checks passed`,
    ...lines,
  ].join("\n");
}
