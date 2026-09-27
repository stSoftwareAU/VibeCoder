/**
 * Tests for the fail-loud untrusted `work-on` strip helper (Issue #3575).
 *
 * `stripUntrustedWorkOnLabel` turns the work-on collector's silent skip of an
 * untrusted `work-on` label into a loud, self-correcting action: when the
 * most-recent adder is positively confirmed untrusted, it strips the label and
 * posts one explanatory comment; when the adder cannot be confirmed (or is
 * actually trusted) it does nothing, so a genuine `work-on` is never removed.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Logger } from "../types.ts";
import {
  buildUntrustedWorkOnComment,
  buildUntrustedWorkOnMarker,
  stripUntrustedWorkOnLabel,
} from "../lib/strip_untrusted_work_on.ts";

function silentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** One timeline `labeled` event for `work-on` added by `login`. */
function timelineJson(login: string, label = "work-on"): string {
  return JSON.stringify([
    {
      event: "labeled",
      label: { name: label },
      actor: { login },
      created_at: "2026-07-26T00:00:00Z",
    },
  ]);
}

/**
 * A recording `ghFn` routed by the gh args. `timeline`/`comments` seed the two
 * read endpoints; every `issue comment` and `issue edit` label call is
 * recorded.
 */
function fakeGh(opts: { timeline: string; comments?: string }) {
  const calls: { comments: string[]; removed: string[]; added: string[] } = {
    comments: [],
    removed: [],
    added: [],
  };
  const ghFn = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1]?.includes("/timeline")) {
      return Promise.resolve(opts.timeline);
    }
    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      return Promise.resolve(opts.comments ?? "[]");
    }
    if (args[0] === "issue" && args[1] === "comment") {
      // ["issue","comment",<n>,"--repo",<repo>,"--body",<body>]
      calls.comments.push(args[6] ?? "");
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "edit") {
      // ["issue","edit",<n>,"--repo",<repo>,"--remove-label"|"--add-label",<label>]
      if (args[5] === "--remove-label") calls.removed.push(args[6] ?? "");
      if (args[5] === "--add-label") calls.added.push(args[6] ?? "");
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
  return { ghFn, calls };
}

Deno.test("stripUntrustedWorkOnLabel - untrusted adder: keeps work-on, adds needs-human and posts explanatory comment (Issue #2734)", async () => {
  const { ghFn, calls } = fakeGh({ timeline: timelineJson("rogue-bot") });

  const stripped = await stripUntrustedWorkOnLabel({
    repo: "org/repo",
    issueNumber: 3489,
    workOnLabel: "work-on",
    allowedAuthors: ["trusted-human"],
    ghFn,
    logger: silentLogger(),
  });

  assert(stripped, "expected the label to be stripped");
  assertEquals(calls.removed, [], "work-on is never removed");
  assertEquals(calls.added, ["needs-human"]);
  assertEquals(calls.comments.length, 1);
  assertStringIncludes(calls.comments[0]!, "rogue-bot");
  assertStringIncludes(calls.comments[0]!, buildUntrustedWorkOnMarker(3489));
});

Deno.test("stripUntrustedWorkOnLabel - empty trusted set: fails closed, never strips (Issue #2734)", async () => {
  // Observed 2026-09-27: a host monitoring two organisations with disjoint
  // writers folded its trusted set to nothing, and every human `work-on`
  // across the fleet was stripped as "untrusted". An empty set confirms
  // nothing about the adder; it is a misconfiguration, never evidence.
  const { ghFn, calls } = fakeGh({ timeline: timelineJson("nleck") });
  const warnings: string[] = [];
  const logger = { ...silentLogger(), warn: (m: string) => warnings.push(m) };

  const stripped = await stripUntrustedWorkOnLabel({
    repo: "org/repo",
    issueNumber: 1507,
    workOnLabel: "work-on",
    allowedAuthors: [],
    ghFn,
    logger,
  });

  assertEquals(stripped, false);
  assertEquals(calls.removed, []);
  assertEquals(calls.comments, []);
  assert(
    warnings.some((w) => w.includes("empty")),
    `expected a WARNING naming the empty trusted set, got ${warnings}`,
  );
});

Deno.test("stripUntrustedWorkOnLabel - trusted adder: does nothing (never strips a genuine label)", async () => {
  const { ghFn, calls } = fakeGh({ timeline: timelineJson("trusted-human") });

  const stripped = await stripUntrustedWorkOnLabel({
    repo: "org/repo",
    issueNumber: 5,
    workOnLabel: "work-on",
    allowedAuthors: ["trusted-human"],
    ghFn,
    logger: silentLogger(),
  });

  assert(!stripped, "a trusted label must not be stripped");
  assertEquals(calls.removed.length, 0);
  assertEquals(calls.comments.length, 0);
});

Deno.test("stripUntrustedWorkOnLabel - unconfirmable adder (empty timeline): fails closed", async () => {
  const { ghFn, calls } = fakeGh({ timeline: "[]" });

  const stripped = await stripUntrustedWorkOnLabel({
    repo: "org/repo",
    issueNumber: 9,
    workOnLabel: "work-on",
    allowedAuthors: ["trusted-human"],
    ghFn,
    logger: silentLogger(),
  });

  assert(!stripped, "must not strip when the adder cannot be confirmed");
  assertEquals(calls.removed.length, 0);
  assertEquals(calls.comments.length, 0);
});

Deno.test("stripUntrustedWorkOnLabel - fleet worker adder is untrusted and stripped", async () => {
  const { ghFn, calls } = fakeGh({ timeline: timelineJson("vibe-worker") });

  const stripped = await stripUntrustedWorkOnLabel({
    repo: "org/repo",
    issueNumber: 42,
    workOnLabel: "work-on",
    // A fleet worker must appear in allowedAuthors for PR-dedup, but must not
    // be trusted to self-apply work-on (Issue #3416).
    allowedAuthors: ["trusted-human", "vibe-worker"],
    fleetWorkerLogins: ["vibe-worker"],
    ghFn,
    logger: silentLogger(),
  });

  assert(stripped, "fleet-worker-applied work-on must be stripped");
  assertEquals(calls.removed, [], "work-on is never removed");
  assertEquals(calls.added, ["needs-human"]);
  assertEquals(calls.comments.length, 1);
});

Deno.test("stripUntrustedWorkOnLabel - dedup: existing marker suppresses a second comment but still adds needs-human", async () => {
  const priorComment = JSON.stringify([
    { id: 1, body: buildUntrustedWorkOnMarker(7), user: { login: "worker" } },
  ]);
  const { ghFn, calls } = fakeGh({
    timeline: timelineJson("rogue-bot"),
    comments: priorComment,
  });

  const stripped = await stripUntrustedWorkOnLabel({
    repo: "org/repo",
    issueNumber: 7,
    workOnLabel: "work-on",
    allowedAuthors: ["trusted-human"],
    ghFn,
    logger: silentLogger(),
  });

  assert(stripped, "needs-human is still added on a re-scan");
  assertEquals(calls.removed, []);
  assertEquals(calls.added, ["needs-human"]);
  assertEquals(calls.comments.length, 0, "no duplicate comment on re-scan");
});

Deno.test("stripUntrustedWorkOnLabel - needs-human add failure is non-fatal and returns false", async () => {
  const ghFn = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1]?.includes("/timeline")) {
      return Promise.resolve(timelineJson("rogue-bot"));
    }
    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      return Promise.resolve("[]");
    }
    if (args[0] === "issue" && args[1] === "comment") {
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "edit") {
      return Promise.reject(new Error("edit failed"));
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };

  const stripped = await stripUntrustedWorkOnLabel({
    repo: "org/repo",
    issueNumber: 8,
    workOnLabel: "work-on",
    allowedAuthors: ["trusted-human"],
    ghFn,
    logger: silentLogger(),
  });

  assert(!stripped, "a failed removal reports false, not a throw");
});

Deno.test("buildUntrustedWorkOnComment - explains why and names the adder", () => {
  const body = buildUntrustedWorkOnComment({
    issueNumber: 3489,
    workOnLabel: "work-on",
    addedBy: "rogue-bot",
  });
  assertStringIncludes(body, "rogue-bot");
  assertStringIncludes(body, "work-on");
  assertStringIncludes(body, "trusted-author allowlist");
  assertStringIncludes(body, buildUntrustedWorkOnMarker(3489));
});
