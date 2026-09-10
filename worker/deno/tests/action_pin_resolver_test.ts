/**
 * Tests for action_pin_resolver.ts — resolving each catalogue action to the
 * highest release that has cleared the supply-chain quarantine window
 * (Issue #1823).
 *
 * Every test drives the real resolver over a fake runner with a fixed clock
 * and asserts on the returned pins, failures or log lines.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  applyResolvedPins,
  PIN_RESOLUTION_FAILURE_PREFIX,
  resolveActionPins,
} from "../lib/action_pin_resolver.ts";
import { type ActionPin, PINNED_ACTIONS } from "../lib/pinned_actions.ts";
import type { Result } from "../types.ts";

/** Fixed "now" every test evaluates the quarantine window against. */
const NOW = new Date("2026-09-09T12:00:00Z");

/** Action used as the subject of the per-action tests. */
const SUBJECT = "actions/checkout";

/** SHA the default stub resolves every unrelated action to. */
const DEFAULT_SHA = "a".repeat(40);

/** Release listing every unrelated action is stubbed with. */
const DEFAULT_RELEASES = "v9.9.9 2026-01-01T00:00:00Z\n";

type RunOutcome = { exitCode: number; output: string };

/** Stubbed responses for one action's two lookups. */
interface ActionStub {
  releases?: string | RunOutcome | Error;
  commits?: string | RunOutcome | Error;
}

/** ISO timestamp a whole number of hours before {@link NOW}. */
function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

function toResult(
  stub: string | RunOutcome | Error,
): Result<RunOutcome> {
  if (stub instanceof Error) return { ok: false, error: stub };
  if (typeof stub === "string") {
    return { ok: true, value: { exitCode: 0, output: stub } };
  }
  return { ok: true, value: stub };
}

/**
 * A fake `gh api` runner recording every command it was handed.
 *
 * Actions without a stub resolve successfully, so a test's log lines and
 * failures come only from the action it is actually exercising.
 */
function createRunner(stubs: Record<string, ActionStub> = {}) {
  const commands: string[][] = [];
  const runFn = (cmd: string[]): Promise<Result<RunOutcome>> => {
    commands.push([...cmd]);
    const path = cmd[2] ?? "";
    const releases = /^repos\/(.+)\/releases$/.exec(path);
    if (releases) {
      const stub = stubs[releases[1]!]?.releases ?? DEFAULT_RELEASES;
      return Promise.resolve(toResult(stub));
    }
    const commit = /^repos\/(.+)\/commits\/(.+)$/.exec(path);
    if (commit) {
      const stub = stubs[commit[1]!]?.commits ??
        `${DEFAULT_SHA} 2026-01-01T00:00:00Z`;
      return Promise.resolve(toResult(stub));
    }
    return Promise.resolve({
      ok: true,
      value: { exitCode: 1, output: `unexpected path: ${path}` },
    });
  };
  return { runFn, commands };
}

/** Run the resolver over a fake runner, capturing its log lines. */
async function resolve(
  stubs: Record<string, ActionStub> = {},
  quarantineHours = 24,
) {
  const { runFn, commands } = createRunner(stubs);
  const logs: string[] = [];
  const result = await resolveActionPins({
    runFn,
    quarantineHours,
    now: () => NOW,
    log: (message) => logs.push(message),
  });
  return { ...result, commands, logs };
}

/** Log lines naming one action. */
function logsFor(logs: string[], action: string): string[] {
  return logs.filter((line) => line.includes(` ${action} —`));
}

Deno.test("action_pin_resolver - picks the highest release across majors", async () => {
  // v3.1.0 is older by publish date than v2.0.0 but is the higher version.
  const { pins, failures, commands } = await resolve({
    [SUBJECT]: {
      releases: [
        `v2.0.0 ${hoursAgo(48)}`,
        `v3.1.0 ${hoursAgo(720)}`,
        `v1.9.9 ${hoursAgo(2000)}`,
      ].join("\n"),
      commits: `${"b".repeat(40)} 2026-08-01T00:00:00Z`,
    },
  });

  assertEquals(pins[SUBJECT], { sha: "b".repeat(40), version: "v3.1.0" });
  assertEquals(failures, []);
  const commitPaths = commands
    .map((cmd) => cmd[2] ?? "")
    .filter((path) => path.includes(`${SUBJECT}/commits/`));
  assertEquals(commitPaths, [`repos/${SUBJECT}/commits/v3.1.0`]);
});

Deno.test("action_pin_resolver - skips a release still inside the window", async () => {
  const { pins, failures } = await resolve({
    [SUBJECT]: {
      releases: [
        `v4.0.0 ${hoursAgo(23)}`,
        `v3.9.0 ${hoursAgo(100)}`,
      ].join("\n"),
      commits: `${"c".repeat(40)} 2026-09-05T00:00:00Z`,
    },
  });

  // 23h < the 24h quarantine, so the older qualifying release wins.
  assertEquals(pins[SUBJECT], { sha: "c".repeat(40), version: "v3.9.0" });
  assertEquals(failures, []);
});

Deno.test("action_pin_resolver - a backport patch does not beat a newer major", async () => {
  const { pins } = await resolve({
    [SUBJECT]: {
      releases: [
        // Published yesterday, but on the older major line.
        `v1.9.9 ${hoursAgo(30)}`,
        // Published a month ago, but the newer major.
        `v2.0.0 ${hoursAgo(720)}`,
      ].join("\n"),
      commits: `${"d".repeat(40)} 2026-08-10T00:00:00Z`,
    },
  });

  assertEquals(pins[SUBJECT]?.version, "v2.0.0");
});

Deno.test("action_pin_resolver - every release inside the window falls back", async () => {
  const { pins, failures, logs } = await resolve({
    [SUBJECT]: { releases: `v5.0.0 ${hoursAgo(2)}` },
  });

  assertEquals(pins[SUBJECT], PINNED_ACTIONS[SUBJECT]);
  assertEquals(failures.filter((f) => f.action === SUBJECT).length, 1);
  assertEquals(logsFor(logs, SUBJECT).length, 1);
  assertStringIncludes(logsFor(logs, SUBJECT)[0]!, "24h quarantine window");
});

Deno.test("action_pin_resolver - no releases falls back to the catalogue", async () => {
  const { pins, failures, logs } = await resolve({
    [SUBJECT]: { releases: "" },
  });

  assertEquals(pins[SUBJECT], PINNED_ACTIONS[SUBJECT]);
  assertEquals(failures.filter((f) => f.action === SUBJECT).length, 1);
  const lines = logsFor(logs, SUBJECT);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, PIN_RESOLUTION_FAILURE_PREFIX);
  assertStringIncludes(lines[0]!, "no stable MAJOR.MINOR.PATCH release");
});

Deno.test("action_pin_resolver - a runner failure falls back to the catalogue", async () => {
  const { pins, failures, logs } = await resolve({
    [SUBJECT]: { releases: new Error("gh api: connection reset") },
  });

  assertEquals(pins[SUBJECT], PINNED_ACTIONS[SUBJECT]);
  const failure = failures.find((f) => f.action === SUBJECT);
  assert(failure, "expected a recorded failure for the subject action");
  assertStringIncludes(failure.reason, "connection reset");
  assertEquals(logsFor(logs, SUBJECT).length, 1);
});

Deno.test("action_pin_resolver - a rejecting runner falls back rather than throwing", async () => {
  // A runner that throws instead of returning `{ ok: false }` must not abort
  // the catalogue: every remaining action is still resolved.
  const logs: string[] = [];
  const { pins, failures } = await resolveActionPins({
    runFn: (cmd: string[]) => {
      if ((cmd[2] ?? "").includes(SUBJECT)) {
        return Promise.reject(new Error("spawn EAGAIN"));
      }
      return createRunner().runFn(cmd);
    },
    quarantineHours: 24,
    now: () => NOW,
    log: (message) => logs.push(message),
  });

  assertEquals(pins[SUBJECT], PINNED_ACTIONS[SUBJECT]);
  assertStringIncludes(
    failures.find((f) => f.action === SUBJECT)?.reason ?? "",
    "spawn EAGAIN",
  );
  assertEquals(logsFor(logs, SUBJECT).length, 1);
  // The rest of the catalogue still resolved.
  assertEquals(failures.length, 1);
  assertEquals(pins["actions/setup-node"]?.version, "v9.9.9");
});

Deno.test("action_pin_resolver - an unusable window is reported, not silently ignored", async () => {
  const { runFn } = createRunner();
  const logs: string[] = [];
  const { failures } = await resolveActionPins({
    runFn,
    // Zero would switch the embargo off; it must fall back to 24h loudly.
    quarantineHours: 0,
    now: () => NOW,
    log: (message) => logs.push(message),
  });

  assertEquals(failures, []);
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, "positive whole number of hours");
});

Deno.test("action_pin_resolver - a non-zero release lookup falls back", async () => {
  const { pins, failures, logs } = await resolve({
    [SUBJECT]: { releases: { exitCode: 1, output: "HTTP 404" } },
  });

  assertEquals(pins[SUBJECT], PINNED_ACTIONS[SUBJECT]);
  assertStringIncludes(
    failures.find((f) => f.action === SUBJECT)?.reason ?? "",
    "exited 1",
  );
  assertEquals(logsFor(logs, SUBJECT).length, 1);
});

Deno.test("action_pin_resolver - a tag that resolves to a non-SHA falls back", async () => {
  const { pins, failures, logs } = await resolve({
    [SUBJECT]: {
      releases: `v3.0.0 ${hoursAgo(500)}`,
      commits: "refs/tags/v3.0.0 2026-08-01T00:00:00Z",
    },
  });

  assertEquals(pins[SUBJECT], PINNED_ACTIONS[SUBJECT]);
  const lines = logsFor(logs, SUBJECT);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "did not resolve to a 40-character commit");
  assertEquals(failures.filter((f) => f.action === SUBJECT).length, 1);
});

Deno.test("action_pin_resolver - a malformed tag never reaches the runner", async () => {
  const { pins, commands, logs } = await resolve({
    [SUBJECT]: {
      releases: [
        `v1.2.3/../../evil ${hoursAgo(500)}`,
        `../../../etc/passwd ${hoursAgo(500)}`,
        `v1.2.3;rm -rf / ${hoursAgo(500)}`,
      ].join("\n"),
    },
  });

  const paths = commands.map((cmd) => cmd[2] ?? "");
  assertEquals(paths.filter((p) => p.includes("evil")).length, 0);
  assertEquals(paths.filter((p) => p.includes("passwd")).length, 0);
  assertEquals(paths.filter((p) => p.includes("rm -rf")).length, 0);
  // No usable tag survived, so the catalogue pin stands and is logged once.
  assertEquals(pins[SUBJECT], PINNED_ACTIONS[SUBJECT]);
  assertEquals(logsFor(logs, SUBJECT).length, 1);
});

Deno.test('action_pin_resolver - "catalogue" entries are never looked up', async () => {
  const { pins, failures, commands, logs } = await resolve();

  const catalogueOnly = Object.entries(PINNED_ACTIONS)
    .filter(([, pin]) => pin.resolution === "catalogue")
    .map(([action]) => action);
  assert(catalogueOnly.length > 0, "expected at least one catalogue entry");

  const paths = commands.map((cmd) => cmd[2] ?? "");
  for (const action of catalogueOnly) {
    assertEquals(pins[action], PINNED_ACTIONS[action]);
    assertEquals(
      paths.filter((path) => path.includes(action)).length,
      0,
      `${action} must never be looked up`,
    );
    assertEquals(logsFor(logs, action).length, 0, `${action} must not log`);
    assertEquals(failures.filter((f) => f.action === action).length, 0);
  }
});

Deno.test("action_pin_resolver - resolves every catalogue action", async () => {
  const { pins, failures, logs } = await resolve();

  assertEquals(Object.keys(pins).sort(), Object.keys(PINNED_ACTIONS).sort());
  assertEquals(failures, []);
  assertEquals(logs, []);
  for (const [action, pin] of Object.entries(pins)) {
    assert(
      /^[0-9a-f]{40}$/.test(pin.sha),
      `${action}: "${pin.sha}" is not a 40-character commit SHA`,
    );
  }
  // Resolved entries take the stubbed upstream SHA, not the catalogue's.
  assertEquals(pins[SUBJECT], { sha: DEFAULT_SHA, version: "v9.9.9" });
});

Deno.test("action_pin_resolver - a bare tag with no v prefix resolves", async () => {
  const { pins } = await resolve({
    [SUBJECT]: {
      releases: `2.4.0 ${hoursAgo(500)}`,
      commits: `${"e".repeat(40)} 2026-08-01T00:00:00Z`,
    },
  });

  // The version label is the upstream tag verbatim — no `v` is invented.
  assertEquals(pins[SUBJECT], { sha: "e".repeat(40), version: "2.4.0" });
});

Deno.test("action_pin_resolver - a wider window defers a young release", async () => {
  const { pins, failures } = await resolve({
    [SUBJECT]: {
      releases: [
        `v6.0.0 ${hoursAgo(48)}`,
        `v5.0.0 ${hoursAgo(200)}`,
      ].join("\n"),
      commits: `${"f".repeat(40)} 2026-08-01T00:00:00Z`,
    },
  }, 72);

  // 48h is inside a 72h window, so the 200h-old v5.0.0 is the highest eligible.
  assertEquals(pins[SUBJECT], { sha: "f".repeat(40), version: "v5.0.0" });
  assertEquals(failures, []);
});

// ---------------------------------------------------------------------------
// applyResolvedPins
// ---------------------------------------------------------------------------

const RESOLVED: Record<string, ActionPin> = {
  "actions/checkout": { sha: "1".repeat(40), version: "v9.0.0" },
  "actions/setup-node": { sha: "2".repeat(40), version: "v9.1.0" },
};

Deno.test("applyResolvedPins - rewrites only pinned uses: lines", () => {
  const template = [
    "name: Quality",
    "jobs:",
    "  quality:",
    "    steps:",
    `      - uses: actions/checkout@${"0".repeat(40)} # v7.0.1`,
    `      - uses: actions/setup-node@${"0".repeat(40)}`,
    `      - uses: codecov/codecov-action@${"9".repeat(40)} # v7.0.0`,
    "    container:",
    "      image: semgrep/semgrep:1.173.0@sha256:" + "a".repeat(64),
    "      run: echo uses: actions/checkout@main",
  ].join("\n");

  const output = applyResolvedPins(template, RESOLVED);
  const lines = output.split("\n");

  assertEquals(
    lines[4],
    `      - uses: actions/checkout@${"1".repeat(40)} # v9.0.0`,
  );
  assertEquals(
    lines[5],
    `      - uses: actions/setup-node@${"2".repeat(40)} # v9.1.0`,
  );
  // Not in the resolved set — byte-identical.
  assertEquals(
    lines[6],
    `      - uses: codecov/codecov-action@${"9".repeat(40)} # v7.0.0`,
  );
  // The Semgrep image and every other line are untouched.
  assertEquals(lines[8], template.split("\n")[8]);
  assertEquals(lines[9], template.split("\n")[9]);
  assertEquals(lines.length, template.split("\n").length);
});

Deno.test("applyResolvedPins - leaves a floating tag ref untouched", () => {
  const template = "      - uses: actions/checkout@v4 # floating";
  assertEquals(applyResolvedPins(template, RESOLVED), template);
});

Deno.test("applyResolvedPins - leaves an image: reference untouched", () => {
  const template = `      image: actions/checkout@${"0".repeat(40)} # v7.0.1`;
  assertEquals(applyResolvedPins(template, RESOLVED), template);
});

Deno.test("applyResolvedPins - a malformed SHA throws rather than being skipped", () => {
  // Fail loud: silently keeping the stale line would emit a template that
  // reads as freshly pinned while the caller's bad map went unreported.
  const template = `      - uses: actions/checkout@${"0".repeat(40)} # v7.0.1`;
  const error = assertThrows(
    () =>
      applyResolvedPins(template, {
        "actions/checkout": { sha: "not-a-sha", version: "v9.0.0" },
      }),
    Error,
  );
  assertStringIncludes(error.message, "actions/checkout");
  assertStringIncludes(error.message, "not a 40-character commit SHA");
});

Deno.test("applyResolvedPins - an action with no pin is left untouched", () => {
  // Absent is not malformed: an unresolved action keeps its existing ref.
  const template = `      - uses: codecov/codecov-action@${
    "9".repeat(40)
  } # v7`;
  assertEquals(applyResolvedPins(template, RESOLVED), template);
});

Deno.test("applyResolvedPins - an empty pin set returns the template verbatim", () => {
  const template = [
    `      - uses: actions/checkout@${"0".repeat(40)} # v7.0.1`,
    "",
    "      - run: ./quality.sh",
  ].join("\n");
  assertEquals(applyResolvedPins(template, {}), template);
});
