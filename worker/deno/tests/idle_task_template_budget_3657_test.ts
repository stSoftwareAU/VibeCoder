/**
 * Idle-task scans must never inherit the 4-hour library default
 * (SEC-2d46e408d10c, Issue #3657).
 *
 * Two guards:
 *
 *  1. A behavioural test of `runSecurityScan` — the one idle-task scan whose
 *     Claude invocation is reachable through injectable deps — asserting both
 *     bounds arrive at the runner, and that an explicit override still wins.
 *  2. An architectural guard over `lib/idle_task_templates/`: every template
 *     invokes Claude through `runIdleTaskClaude`, never `runClaudeWithRetry` /
 *     `runClaudeWithTimeout` directly, so a new template cannot silently
 *     reintroduce the fall-through. The 12 templates' own Claude runners are
 *     private module functions with no injection seam, so this import
 *     invariant is what keeps them on the budgeted path.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import type { Result } from "../types.ts";
import type {
  ClaudeRunResult,
  RunClaudeOptions,
} from "../lib/claude_runner.ts";
import { runSecurityScan, type ScannerDeps } from "../lib/security_scanner.ts";
import {
  IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS,
  IDLE_TASK_TIMEOUT_SECONDS,
} from "../lib/idle_task_claude_budget.ts";

// ---------------------------------------------------------------------------
// 1. Behavioural — runSecurityScan
// ---------------------------------------------------------------------------

/** Deps that record the options handed to the runner and report success. */
function capturingDeps(captured: RunClaudeOptions[]): ScannerDeps {
  return {
    loadPromptFn: () => Promise.resolve({ ok: true, value: "PROMPT BODY" }),
    runClaudeFn: (opts: RunClaudeOptions): Promise<Result<ClaudeRunResult>> => {
      captured.push(opts);
      return Promise.resolve({
        ok: true,
        value: { exitCode: 0, output: "", timedOut: false },
      });
    },
    detectLlmUsageFn: () => Promise.resolve({ isLlmUsing: false, signals: [] }),
  };
}

Deno.test("security scan bounds both the hard cap and the silence watchdog", async () => {
  const captured: RunClaudeOptions[] = [];
  const result = await runSecurityScan({
    repo: "owner/repo",
    workDir: "/tmp/repo",
    knownOpenFindingIds: [],
    suppressedIds: [],
  }, capturingDeps(captured));

  assert(result.ok, "expected the stubbed scan to succeed");
  assertEquals(captured.length, 1);
  const opts = captured[0]!;
  assertEquals(opts.timeoutSeconds, IDLE_TASK_TIMEOUT_SECONDS);
  assertEquals(opts.noOutputTimeout, IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS);
});

Deno.test("security scan honours explicit timeout overrides", async () => {
  const captured: RunClaudeOptions[] = [];
  await runSecurityScan({
    repo: "owner/repo",
    workDir: "/tmp/repo",
    knownOpenFindingIds: [],
    suppressedIds: [],
    timeoutSeconds: 1200,
    noOutputTimeout: 90,
  }, capturingDeps(captured));

  const opts = captured[0]!;
  assertEquals(opts.timeoutSeconds, 1200);
  assertEquals(opts.noOutputTimeout, 90);
});

// ---------------------------------------------------------------------------
// 2. Architectural guard — every template uses the budgeted wrapper
// ---------------------------------------------------------------------------

const TEMPLATES_DIR = new URL("../lib/idle_task_templates/", import.meta.url);

/** Every `*_template.ts` module under `lib/idle_task_templates/`. */
async function templateFiles(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(TEMPLATES_DIR)) {
    if (entry.isFile && entry.name.endsWith(".ts")) names.push(entry.name);
  }
  return names.sort();
}

Deno.test({
  name: "no idle-task template calls the unbudgeted Claude runner directly",
  permissions: { read: true },
  async fn() {
    const offenders: string[] = [];
    for (const name of await templateFiles()) {
      const source = await Deno.readTextFile(new URL(name, TEMPLATES_DIR));
      if (/\b(runClaudeWithRetry|runClaudeWithTimeout)\s*\(/.test(source)) {
        offenders.push(name);
      }
    }
    assertEquals(
      offenders,
      [],
      `these templates bypass runIdleTaskClaude and would inherit the 4-hour ` +
        `default with the silence watchdog disabled: ${offenders.join(", ")}`,
    );
  },
});

Deno.test({
  name: "every Claude-invoking idle-task template routes via runIdleTaskClaude",
  permissions: { read: true },
  async fn() {
    let budgeted = 0;
    for (const name of await templateFiles()) {
      const source = await Deno.readTextFile(new URL(name, TEMPLATES_DIR));
      if (!source.includes("runIdleTaskClaude")) continue;
      budgeted++;
      assert(
        source.includes(
          'import { runIdleTaskClaude } from "../idle_task_claude_budget.ts";',
        ),
        `${name} uses runIdleTaskClaude but does not import it from the ` +
          `shared budget module`,
      );
    }
    // The 12 Claude-driven templates named in Issue #3657. A new one lifts
    // this floor; none may drop off it.
    assert(
      budgeted >= 12,
      `expected at least 12 budgeted templates, found ${budgeted}`,
    );
  },
});
