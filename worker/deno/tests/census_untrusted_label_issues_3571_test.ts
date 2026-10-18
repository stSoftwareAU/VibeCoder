/**
 * Unit tests for the census model of the claim scan's label-author gate
 * (Issue #3571).
 *
 * The helper must agree with `wasLabelAddedByAllowedAuthor` on every verdict,
 * so each case drives the real helper through a stub `gh` that answers the
 * timeline call with the shape `gh api repos/<repo>/issues/<n>/timeline`
 * returns: an array of events, each with `event`, `label.name`, `actor.login`.
 *
 * Australian English spelling throughout (behaviour, honour).
 */

import { assert, assertEquals } from "@std/assert";
import { censusUntrustedLabelIssues } from "../lib/census_untrusted_label_issues.ts";

const REPO = "org/census-fixture";
const ALICE = "alice";
const BOT = "github-actions[bot]";
const SIBLING = "worker-sibling";

/** One `labeled` event as the REST timeline returns it. */
function labeled(label: string, login: string) {
  return {
    id: 1,
    event: "labeled",
    label: { name: label },
    actor: { login },
    created_at: "2026-01-01T00:00:00Z",
  };
}

interface StubGh {
  /** Every argv the stub was called with. */
  calls: string[][];
  fn: (args: string[]) => Promise<string>;
}

/**
 * A stub `gh` that answers each issue's timeline from `timelines`. An issue
 * listed in `throwFor` rejects the way a failed `gh api` call does.
 */
function stubGh(
  timelines: Record<number, unknown[]>,
  throwFor: number[] = [],
): StubGh {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    const match = /issues\/(\d+)\/timeline/.exec(args[1] ?? "");
    const issue = match ? Number(match[1]) : NaN;
    if (throwFor.includes(issue)) {
      return Promise.reject(new Error("HTTP 503: service unavailable"));
    }
    return Promise.resolve(JSON.stringify(timelines[issue] ?? []));
  };
  return { calls, fn };
}

Deno.test(
  "census untrusted label issues - a top-priority add by the bot is untrusted (Issue #3571 a)",
  async () => {
    const gh = stubGh({ 1: [labeled("top-priority", BOT)] });
    const untrusted = await censusUntrustedLabelIssues(
      REPO,
      [{ number: 1, labels: ["top-priority"] }],
      [ALICE],
      gh.fn,
      undefined,
      [],
    );
    assert(untrusted.has(1), `expected #1 untrusted, got ${[...untrusted]}`);
    assertEquals(untrusted.size, 1);
  },
);

Deno.test(
  "census untrusted label issues - a top-priority add by an allowed author is trusted (Issue #3571 b)",
  async () => {
    const gh = stubGh({ 1: [labeled("top-priority", ALICE)] });
    const untrusted = await censusUntrustedLabelIssues(
      REPO,
      [{ number: 1, labels: ["top-priority"] }],
      [ALICE],
      gh.fn,
      undefined,
      [],
    );
    assertEquals([...untrusted], []);
  },
);

Deno.test(
  "census untrusted label issues - one trusted priority label makes the issue trusted (Issue #3571 c)",
  async () => {
    const gh = stubGh({
      1: [
        labeled("top-priority", BOT),
        labeled("work-on", ALICE),
      ],
    });
    const untrusted = await censusUntrustedLabelIssues(
      REPO,
      [{ number: 1, labels: ["top-priority", "work-on"] }],
      [ALICE],
      gh.fn,
      undefined,
      [],
    );
    assertEquals([...untrusted], []);
  },
);

Deno.test(
  "census untrusted label issues - an issue with no priority label is skipped without a gh call (Issue #3571 d)",
  async () => {
    const gh = stubGh({});
    const untrusted = await censusUntrustedLabelIssues(
      REPO,
      [{ number: 1, labels: ["idle-task"] }],
      [ALICE],
      gh.fn,
      undefined,
      [],
    );
    assertEquals([...untrusted], []);
    assertEquals(gh.calls.length, 0);
  },
);

Deno.test(
  "census untrusted label issues - a read failure is trusted and warned, naming the issue (Issue #3571 e)",
  async () => {
    const gh = stubGh({}, [7]);
    const logged: string[] = [];
    const untrusted = await censusUntrustedLabelIssues(
      REPO,
      [{ number: 7, labels: ["work-on"] }],
      [ALICE],
      gh.fn,
      undefined,
      [],
      (msg) => logged.push(msg),
    );
    assertEquals([...untrusted], []);
    assertEquals(logged.length, 1, `expected one warning, got ${logged}`);
    const warning = logged[0] ?? "";
    assert(warning.includes("WARNING"), warning);
    assert(warning.includes(`${REPO}#7`), warning);
    // The error's own message, not `String(err)` ("Error: HTTP 503 …").
    assert(warning.includes("(HTTP 503: service unavailable);"), warning);
  },
);

Deno.test(
  "census untrusted label issues - a fleet worker login in allowedAuthors is untrusted (Issue #3571 f)",
  async () => {
    const gh = stubGh({ 1: [labeled("low-priority", SIBLING)] });
    const untrusted = await censusUntrustedLabelIssues(
      REPO,
      [{ number: 1, labels: ["low-priority"] }],
      [ALICE, SIBLING],
      gh.fn,
      undefined,
      [SIBLING],
    );
    assertEquals([...untrusted], [1]);
  },
);
