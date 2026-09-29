/**
 * Tests for escalated_cleanup.ts — the sweep that clears the retired PR
 * escalation's `escalated` labels and fleet-filed `PR #N cannot land:` issues
 * (Issue #2805).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ESCALATED_LABEL,
  sweepEscalatedLeftovers,
} from "../lib/escalated_cleanup.ts";
import type { Logger } from "../types.ts";

const REPO = "owner/repo";
const FLEET_LOGIN = "vibe-coder-bot";
const FLEET: readonly string[] = [FLEET_LOGIN];
const HUMAN = "a-human";

interface Issue {
  number: number;
  title: string;
  author: string;
}

/** A fake GitHub holding open escalated PRs and open issues, with state. */
function fakeGitHub(
  state: { escalatedPrs: number[]; issues: Issue[] },
  fail: (args: string[]) => boolean = () => false,
) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (fail(args)) return Promise.reject(new Error("gh exploded"));
    const [noun, verb] = args;
    if (noun === "pr" && verb === "list") {
      return Promise.resolve(
        JSON.stringify(state.escalatedPrs.map((number) => ({ number }))),
      );
    }
    if (noun === "pr" && verb === "edit") {
      const n = Number(args[2]);
      state.escalatedPrs = state.escalatedPrs.filter((p) => p !== n);
      return Promise.resolve("");
    }
    if (noun === "issue" && verb === "list") {
      return Promise.resolve(JSON.stringify(
        state.issues.map((i) => ({
          number: i.number,
          title: i.title,
          author: { login: i.author },
        })),
      ));
    }
    if (noun === "issue" && verb === "close") {
      const n = Number(args[2]);
      state.issues = state.issues.filter((i) => i.number !== n);
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
  const writes = () => calls.filter((c) => c[1] !== "list");
  return { gh, calls, writes, state };
}

function recordingLogger() {
  const warnings: { message: string; context?: Record<string, unknown> }[] = [];
  const noop = () => {};
  const logger: Logger = {
    info: noop,
    warn: (message, context) => warnings.push({ message, context }),
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  return { logger, warnings };
}

function sweep(gh: (args: string[]) => Promise<string>, logger: Logger) {
  return sweepEscalatedLeftovers(REPO, {
    ghCommandFn: gh,
    logger,
    fleetAuthors: FLEET,
  });
}

Deno.test("escalated cleanup - removes the escalated label from an open PR", async () => {
  const github = fakeGitHub({ escalatedPrs: [41], issues: [] });

  const outcome = await sweep(github.gh, recordingLogger().logger);

  assertEquals(github.writes(), [[
    "pr",
    "edit",
    "41",
    "--repo",
    REPO,
    "--remove-label",
    ESCALATED_LABEL,
  ]]);
  assertEquals(outcome.labelsRemoved, [41]);
  assertEquals(outcome.failures, 0);
});

Deno.test("escalated cleanup - comments once on and closes a fleet-filed cannot-land issue", async () => {
  const title = "PR #41 cannot land: CI has been red for 2h";
  const github = fakeGitHub({
    escalatedPrs: [],
    issues: [
      { number: 90, title, author: FLEET_LOGIN },
      { number: 91, title, author: HUMAN },
      { number: 92, title: "Why can PR #41 not land?", author: FLEET_LOGIN },
    ],
  });

  const outcome = await sweep(github.gh, recordingLogger().logger);

  const writes = github.writes();
  assertEquals(writes.length, 1, "only the fleet-filed issue is written to");
  const close = writes[0] ?? [];
  assertEquals(close.slice(0, 5), ["issue", "close", "90", "--repo", REPO]);
  assertEquals(
    close.filter((arg) => arg === "--comment").length,
    1,
    "the close carries exactly one comment",
  );
  const comment = close[close.indexOf("--comment") + 1] ?? "";
  assertStringIncludes(comment, "#41");
  assertStringIncludes(comment, "stall self-repair");
  assertEquals(outcome.issuesClosed, [90]);
  assertEquals(
    github.state.issues.map((i) => i.number),
    [91, 92],
    "the human-filed issue and an unrelated title are untouched",
  );
});

Deno.test("escalated cleanup - a second sweep over a clean repo makes no write calls", async () => {
  const github = fakeGitHub({
    escalatedPrs: [41, 42],
    issues: [{
      number: 90,
      title: "PR #41 cannot land: CI has been red for 2h",
      author: FLEET_LOGIN,
    }],
  });
  const { logger } = recordingLogger();
  await sweep(github.gh, logger);
  const firstWrites = github.writes().length;
  assertEquals(firstWrites, 3);

  const outcome = await sweep(github.gh, logger);

  assertEquals(github.writes().length, firstWrites, "no new writes");
  assertEquals(outcome.labelsRemoved, []);
  assertEquals(outcome.issuesClosed, []);
  assertEquals(outcome.failures, 0);
});

Deno.test("escalated cleanup - every gh failure is logged with repo and number and counted", async () => {
  const github = fakeGitHub(
    {
      escalatedPrs: [41],
      issues: [{
        number: 90,
        title: "PR #41 cannot land: CI has been red for 2h",
        author: FLEET_LOGIN,
      }],
    },
    (args) => args[1] === "edit" || args[1] === "close",
  );
  const { logger, warnings } = recordingLogger();

  const outcome = await sweep(github.gh, logger);

  assertEquals(outcome.failures, 2);
  assertEquals(outcome.labelsRemoved, []);
  assertEquals(outcome.issuesClosed, []);
  assertEquals(warnings.map((e) => e.context?.repo), [REPO, REPO]);
  assertEquals(warnings[0]?.context?.pr, 41);
  assertEquals(warnings[1]?.context?.issue, 90);
});

Deno.test("escalated cleanup - a failed listing is counted, not read as a clean repo", async () => {
  const github = fakeGitHub(
    { escalatedPrs: [], issues: [] },
    (args) => args[1] === "list",
  );
  const { logger, warnings } = recordingLogger();

  const outcome = await sweep(github.gh, logger);

  assertEquals(outcome.failures, 2);
  assertEquals(warnings.length, 2);
});

Deno.test("escalated cleanup - defers without a gh call when the repo is leased elsewhere", async () => {
  const github = fakeGitHub({ escalatedPrs: [41], issues: [] });

  const outcome = await sweepEscalatedLeftovers(REPO, {
    ghCommandFn: github.gh,
    logger: recordingLogger().logger,
    fleetAuthors: FLEET,
    acquireLease: () => null,
  });

  assert(outcome.deferred);
  assertEquals(github.calls, []);
});
