/**
 * A repair the agent declined because the PR needs a human (a contract-change
 * label and owner approval, for one) is the PR's outcome, not a babysitter
 * fault. It keeps its code blocker class, so the retry budget and escalation
 * are unchanged, but it must not join the pass's AggregateError: that exit
 * code is what the health hook reports as a failed babysitter.
 */

import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { runRepairs } from "../commands/fleet_pr_babysitter.ts";
import {
  BabysitterFailure,
  BabysitterNeedsHuman,
} from "../lib/babysitter_retry_state.ts";

function captureConsole<T>(body: () => Promise<T>) {
  const lines: { level: string; text: string }[] = [];
  const saved = { error: console.error, log: console.log, warn: console.warn };
  for (const level of ["error", "log", "warn"] as const) {
    console[level] = (...args: unknown[]) =>
      lines.push({ level, text: args.map(String).join(" ") });
  }
  return body().finally(() => Object.assign(console, saved)).then(
    (value) => ({ value, lines }),
  );
}

Deno.test("a needs-human repair keeps the code blocker class", () => {
  const failure = new BabysitterNeedsHuman("agent did not report ready");
  assertInstanceOf(failure, BabysitterFailure);
  assertEquals(failure.blockerClass, "code");
});

Deno.test("a needs-human repair is logged once and does not fail the pass", async () => {
  const { lines } = await captureConsole(() =>
    runRepairs([{
      key: "repo#1",
      version: "head",
      run: () =>
        Promise.reject(
          new BabysitterNeedsHuman(
            "agent did not report that its fix was ready; contract-change label needed",
          ),
        ),
    }], 1)
  );
  assertEquals(lines.filter((line) => line.level === "error"), []);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!.text, "needs a human");
  assertStringIncludes(lines[0]!.text, "contract-change");
});

Deno.test("another code failure still fails the pass", async () => {
  await captureConsole(() =>
    assertRejects(
      () =>
        runRepairs([{
          key: "repo#1",
          version: "head",
          run: () =>
            Promise.reject(
              new BabysitterFailure("agent session budget exhausted", "code"),
            ),
        }], 1),
      AggregateError,
    )
  );
});
