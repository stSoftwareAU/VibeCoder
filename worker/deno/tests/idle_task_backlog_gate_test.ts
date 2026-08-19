/**
 * Tests for the idle-task backlog gate helper (Issue #2082).
 *
 * The helper counts open issues on a target repo carrying a given
 * label, capped at the backlog threshold. The caller in
 * `maybe_file_idle_task.ts` uses the result to skip a repo whose
 * previous batch of output issues is still un-triaged.
 *
 * The tests stub the gh runner so they never touch the network and
 * cover:
 *   - happy path: counts the JSON array length
 *   - cap is forwarded to gh via `--limit`
 *   - gh failure degrades to 0
 *   - malformed JSON degrades to 0
 *   - non-array JSON degrades to 0
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import {
  BACKLOG_THRESHOLD,
  countOpenIssuesByLabel,
} from "../lib/idle_task_backlog_gate.ts";

interface RecordedCall {
  args: string[];
}

function makeStub(returns: string | Error) {
  const calls: RecordedCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    if (returns instanceof Error) return Promise.reject(returns);
    return Promise.resolve(returns);
  };
  return { fn, calls };
}

Deno.test("countOpenIssuesByLabel - returns the array length on a clean response", async () => {
  const items = JSON.stringify([
    { number: 1 },
    { number: 2 },
    { number: 3 },
  ]);
  const gh = makeStub(items);

  const count = await countOpenIssuesByLabel({
    repo: "org/foo",
    label: "security",
    ghCommandFn: gh.fn,
  });

  assertEquals(count, 3);

  // gh was called with the expected flags. Repo, label, state=open, and
  // --json number form the contract.
  assertEquals(gh.calls.length, 1);
  const args = gh.calls[0]!.args;
  assertEquals(args.includes("--repo"), true);
  assertEquals(args[args.indexOf("--repo") + 1], "org/foo");
  assertEquals(args.includes("--label"), true);
  assertEquals(args[args.indexOf("--label") + 1], "security");
  assertEquals(args.includes("--state"), true);
  assertEquals(args[args.indexOf("--state") + 1], "open");
});

Deno.test("countOpenIssuesByLabel - cap is forwarded to gh via --limit (default = BACKLOG_THRESHOLD)", async () => {
  const gh = makeStub("[]");
  await countOpenIssuesByLabel({
    repo: "org/foo",
    label: "security",
    ghCommandFn: gh.fn,
  });
  const args = gh.calls[0]!.args;
  const idx = args.indexOf("--limit");
  assert(idx !== -1, "expected --limit flag");
  assertEquals(args[idx + 1], String(BACKLOG_THRESHOLD));
});

Deno.test("countOpenIssuesByLabel - explicit cap overrides the default", async () => {
  const gh = makeStub("[]");
  await countOpenIssuesByLabel({
    repo: "org/foo",
    label: "security",
    cap: 42,
    ghCommandFn: gh.fn,
  });
  const args = gh.calls[0]!.args;
  assertEquals(args[args.indexOf("--limit") + 1], "42");
});

Deno.test("countOpenIssuesByLabel - gh failure degrades to 0", async () => {
  const gh = makeStub(new Error("gh exploded"));
  const count = await countOpenIssuesByLabel({
    repo: "org/foo",
    label: "security",
    ghCommandFn: gh.fn,
  });
  assertEquals(count, 0);
});

Deno.test("countOpenIssuesByLabel - malformed JSON degrades to 0", async () => {
  const gh = makeStub("not json at all");
  const count = await countOpenIssuesByLabel({
    repo: "org/foo",
    label: "security",
    ghCommandFn: gh.fn,
  });
  assertEquals(count, 0);
});

Deno.test("countOpenIssuesByLabel - non-array JSON degrades to 0", async () => {
  const gh = makeStub(`{"number": 1}`);
  const count = await countOpenIssuesByLabel({
    repo: "org/foo",
    label: "security",
    ghCommandFn: gh.fn,
  });
  assertEquals(count, 0);
});

Deno.test("BACKLOG_THRESHOLD is fixed at 6 (Issue #2082)", () => {
  // The issue scope explicitly fixes the threshold at 6 across every
  // template (KISS). Guard against accidental bumps.
  assertEquals(BACKLOG_THRESHOLD, 6);
});
