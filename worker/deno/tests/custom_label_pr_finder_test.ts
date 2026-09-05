/**
 * Tests for the PR-phase custom-label finder (Issue #1009, part of #938).
 *
 * Discovery is trivial; the **trust gate** is the whole of this module's
 * risk. A `pr`-phase custom label hands an operator-supplied prompt a full
 * checkout plus `gh`, so a finder that returns every labelled PR would hand
 * an unallowlisted actor a privileged agent run. The load-bearing cases here
 * are therefore the three refusals — untrusted adder, unattributable add,
 * fleet-login adder — plus the `--state open` argument assertion and the
 * zero-call case for an unconfigured fleet.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { findCustomLabelPrCandidates } from "../lib/custom_label_pr_finder.ts";
import type { CustomLabelPromptMapping, Logger } from "../types.ts";

/** A mapping for the given label and phase; the path is never read here. */
function mapping(
  label: string,
  targetPhase: "issue" | "pr" = "pr",
): CustomLabelPromptMapping {
  return { label, promptPath: `/srv/private/${label}.md`, targetPhase };
}

/** A logger that records every line, so a skip reason can be asserted. */
function recordingLogger(lines: string[]): Logger {
  const push = (level: string) => (message: string, context?: unknown) =>
    lines.push(
      `${level}: ${message}${context ? ` ${JSON.stringify(context)}` : ""}`,
    );
  return {
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    debug: push("debug"),
    security: (event: string, details: string) =>
      lines.push(`security: ${event} ${details}`),
    skipReason: (code: string, details: string) =>
      lines.push(`skip: ${code} ${details}`),
  } as unknown as Logger;
}

/** One PR as `gh pr list --json` renders it. */
interface FakePr {
  number: number;
  headRefName: string;
  title: string;
  url: string;
  isDraft: boolean;
  author: { login: string };
  updatedAt: string;
}

function fakePr(number: number, overrides: Partial<FakePr> = {}): FakePr {
  return {
    number,
    headRefName: `feature/${number}`,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    isDraft: false,
    author: { login: "someone" },
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** A `labeled` timeline event, as the REST timeline renders it. */
function labelled(label: string, actor: string | null) {
  return {
    event: "labeled",
    label: { name: label },
    actor: actor === null ? null : { login: actor },
  };
}

interface FakeGhOptions {
  /** PRs returned per `gh pr list`, keyed `repo::label`. */
  prs?: Record<string, FakePr[]>;
  /** Timeline events per PR number. */
  timelines?: Record<number, unknown[]>;
  /** PR numbers whose timeline read throws. */
  timelineThrows?: number[];
}

/** A fake `gh` that records its argv and answers list and timeline reads. */
function fakeGh(options: FakeGhOptions = {}) {
  const calls: string[][] = [];
  const run = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      const repo = args[args.indexOf("--repo") + 1]!;
      const label = args[args.indexOf("--label") + 1]!;
      return Promise.resolve(
        JSON.stringify(options.prs?.[`${repo}::${label}`] ?? []),
      );
    }
    if (args[0] === "api") {
      const match = /issues\/(\d+)\/timeline/.exec(args[1] ?? "");
      const number = Number(match?.[1]);
      if (options.timelineThrows?.includes(number)) {
        return Promise.reject(new Error("gh: API rate limit exceeded"));
      }
      const page = Number(/[?&]page=(\d+)/.exec(args[1] ?? "")?.[1] ?? "1");
      const events = page === 1 ? options.timelines?.[number] ?? [] : [];
      return Promise.resolve(JSON.stringify(events));
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { calls, run };
}

Deno.test("pr finder - a trusted collaborator's label on an open PR is a candidate", async () => {
  const gh = fakeGh({
    prs: { "acme/widgets::secret-squirrel": [fakePr(42)] },
    timelines: { 42: [labelled("secret-squirrel", "trusted-human")] },
  });
  const lines: string[] = [];

  const candidates = await findCustomLabelPrCandidates({
    repos: ["acme/widgets"],
    mappings: [mapping("secret-squirrel")],
    allowedAuthors: ["trusted-human"],
    fleetWorkerLogins: ["vibe-worker"],
    ghCommandFn: gh.run,
    logger: recordingLogger(lines),
  });

  assertEquals(candidates.length, 1);
  assertEquals(candidates[0]?.prNumber, 42);
  assertEquals(candidates[0]?.repo, "acme/widgets");
  assertEquals(candidates[0]?.headRefName, "feature/42");
  assertEquals(candidates[0]?.mapping.label, "secret-squirrel");
});

Deno.test("pr finder - an untrusted actor's label yields no candidate and says so", async () => {
  const gh = fakeGh({
    prs: { "acme/widgets::secret-squirrel": [fakePr(42)] },
    timelines: { 42: [labelled("secret-squirrel", "drive-by")] },
  });
  const lines: string[] = [];

  const candidates = await findCustomLabelPrCandidates({
    repos: ["acme/widgets"],
    mappings: [mapping("secret-squirrel")],
    allowedAuthors: ["trusted-human"],
    ghCommandFn: gh.run,
    logger: recordingLogger(lines),
  });

  assertEquals(candidates, []);
  assert(
    lines.some((l) =>
      l.includes("label-adder-not-allowed") && l.includes("42")
    ),
    `expected a logged skip reason, got: ${lines.join("\n")}`,
  );
});

Deno.test("pr finder - an unattributable label add fails closed and logs the reason", async () => {
  const gh = fakeGh({
    prs: { "acme/widgets::secret-squirrel": [fakePr(42), fakePr(43)] },
    // 42: a `labeled` event with a null actor. 43: the timeline read throws.
    timelines: { 42: [labelled("secret-squirrel", null)] },
    timelineThrows: [43],
  });
  const lines: string[] = [];

  const candidates = await findCustomLabelPrCandidates({
    repos: ["acme/widgets"],
    mappings: [mapping("secret-squirrel")],
    allowedAuthors: ["trusted-human"],
    ghCommandFn: gh.run,
    logger: recordingLogger(lines),
  });

  assertEquals(candidates, []);
  assert(
    lines.some((l) =>
      l.includes("label-adder-unverifiable") && l.includes("43")
    ),
    `expected an unverifiable skip reason, got: ${lines.join("\n")}`,
  );
});

Deno.test("pr finder - a fleet worker cannot self-dispatch by labelling its own PR", async () => {
  const gh = fakeGh({
    prs: {
      "acme/widgets::secret-squirrel": [fakePr(42, {
        author: { login: "vibe-worker" },
      })],
    },
    timelines: { 42: [labelled("secret-squirrel", "vibe-worker")] },
  });
  const lines: string[] = [];

  const candidates = await findCustomLabelPrCandidates({
    repos: ["acme/widgets"],
    mappings: [mapping("secret-squirrel")],
    // The fleet login sits in allowedAuthors for PR-dedup, exactly as it does
    // in production — the fleet exclusion is what must refuse it.
    allowedAuthors: ["trusted-human", "vibe-worker"],
    fleetWorkerLogins: ["vibe-worker"],
    ghCommandFn: gh.run,
    logger: recordingLogger(lines),
  });

  assertEquals(candidates, []);
});

Deno.test("pr finder - the gh pr list invocation carries --state open", async () => {
  const gh = fakeGh({ prs: { "acme/widgets::secret-squirrel": [] } });

  await findCustomLabelPrCandidates({
    repos: ["acme/widgets"],
    mappings: [mapping("secret-squirrel")],
    allowedAuthors: ["trusted-human"],
    ghCommandFn: gh.run,
    logger: recordingLogger([]),
  });

  const listCall = gh.calls.find((c) => c[0] === "pr" && c[1] === "list");
  assert(listCall, "the finder must list PRs");
  const stateIndex = listCall.indexOf("--state");
  assert(stateIndex >= 0, `no --state in ${listCall.join(" ")}`);
  assertEquals(listCall[stateIndex + 1], "open");
  assertEquals(listCall[listCall.indexOf("--label") + 1], "secret-squirrel");
  assertEquals(listCall[listCall.indexOf("--repo") + 1], "acme/widgets");
});

Deno.test("pr finder - issue-phase labels are never scanned against PRs", async () => {
  const gh = fakeGh({ prs: {} });

  const candidates = await findCustomLabelPrCandidates({
    repos: ["acme/widgets"],
    mappings: [mapping("issue-only-label", "issue")],
    allowedAuthors: ["trusted-human"],
    ghCommandFn: gh.run,
    logger: recordingLogger([]),
  });

  assertEquals(candidates, []);
  assertEquals(gh.calls.length, 0, "an issue-phase label must cost no gh call");
});

Deno.test("pr finder - with no pr-phase mappings the finder issues zero gh calls", async () => {
  const gh = fakeGh();

  const candidates = await findCustomLabelPrCandidates({
    repos: ["acme/widgets", "acme/gadgets"],
    mappings: [],
    allowedAuthors: ["trusted-human"],
    ghCommandFn: gh.run,
    logger: recordingLogger([]),
  });

  assertEquals(candidates, []);
  assertEquals(gh.calls.length, 0);
});

Deno.test("pr finder - candidates come back in configuration order, oldest-updated first", async () => {
  const gh = fakeGh({
    prs: {
      "acme/widgets::second-label": [fakePr(10)],
      "acme/widgets::first-label": [
        fakePr(20, { updatedAt: "2026-03-01T00:00:00Z" }),
        fakePr(21, { updatedAt: "2026-01-01T00:00:00Z" }),
      ],
    },
    timelines: {
      10: [labelled("second-label", "trusted-human")],
      20: [labelled("first-label", "trusted-human")],
      21: [labelled("first-label", "trusted-human")],
    },
  });

  const candidates = await findCustomLabelPrCandidates({
    repos: ["acme/widgets"],
    mappings: [mapping("first-label"), mapping("second-label")],
    allowedAuthors: ["trusted-human"],
    ghCommandFn: gh.run,
    logger: recordingLogger([]),
  });

  assertEquals(candidates.map((c) => c.prNumber), [21, 20, 10]);
});

Deno.test("pr finder - a PR carrying two configured labels yields one candidate per label", async () => {
  const gh = fakeGh({
    prs: {
      "acme/widgets::first-label": [fakePr(42)],
      "acme/widgets::second-label": [fakePr(42)],
    },
    timelines: {
      42: [
        labelled("first-label", "trusted-human"),
        labelled("second-label", "trusted-human"),
      ],
    },
  });

  const candidates = await findCustomLabelPrCandidates({
    repos: ["acme/widgets"],
    mappings: [mapping("first-label"), mapping("second-label")],
    allowedAuthors: ["trusted-human"],
    ghCommandFn: gh.run,
    logger: recordingLogger([]),
  });

  assertEquals(candidates.length, 2);
  assertEquals(candidates.map((c) => c.mapping.label), [
    "first-label",
    "second-label",
  ]);
});

Deno.test("pr finder - a gh pr list failure is logged and does not stop the scan", async () => {
  const lines: string[] = [];
  const calls: string[][] = [];
  const run = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("acme/broken")) {
      return Promise.reject(new Error("gh: could not resolve to a Repository"));
    }
    if (args[0] === "pr") return Promise.resolve(JSON.stringify([fakePr(7)]));
    return Promise.resolve(
      JSON.stringify(
        /[?&]page=1$/.test(args[1] ?? "")
          ? [labelled("secret-squirrel", "trusted-human")]
          : [],
      ),
    );
  };

  const candidates = await findCustomLabelPrCandidates({
    repos: ["acme/broken", "acme/widgets"],
    mappings: [mapping("secret-squirrel")],
    allowedAuthors: ["trusted-human"],
    ghCommandFn: run,
    logger: recordingLogger(lines),
  });

  assertEquals(candidates.map((c) => c.repo), ["acme/widgets"]);
  assert(
    lines.some((l) => l.startsWith("error:") && l.includes("acme/broken")),
    `expected the failure to be surfaced, got: ${lines.join("\n")}`,
  );
});
