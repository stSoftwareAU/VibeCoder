/**
 * Fixture tests for the issue-routing classifier (Issue #3741, part of #3691).
 * The four real issues behind #3691 are stored verbatim under
 * `fixtures/issue_routing/`; every other draft is built inline. No network,
 * no clock. Australian English spelling used throughout.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  classifyIssueRouting,
  type IssueKind,
  type IssueRoutingContext,
  type IssueRoutingDraft,
  type RoutingDecision,
} from "../lib/issue_routing_classifier.ts";
import {
  formatRepoFastFailureMarker,
  formatRepoFastFailureTallyMarker,
} from "../lib/repo_fast_failure_issue.ts";
import { assertLinearGrowth } from "./support/growth.ts";

const VIBE = "stSoftwareAU/VibeCoder";
const AUTOTRADER = "stSoftwareAU/GRQ-AutoTrader";
const GRQ = "stSoftwareAU/GRQ";
const CTX: IssueRoutingContext = {
  vibeCoderRepo: VIBE,
  productRepos: [GRQ, AUTOTRADER],
};
const KINDS: readonly IssueKind[] = [
  "implementation",
  "diagnostic",
  "cross-repo",
  "ambiguous",
];

function fixture(name: string): IssueRoutingDraft {
  const raw = JSON.parse(
    Deno.readTextFileSync(
      new URL(`./fixtures/issue_routing/${name}.json`, import.meta.url),
    ),
  );
  return { title: raw.title, body: raw.body };
}

/** Classify and assert all four audit fields are filled. */
function route(
  draft: IssueRoutingDraft,
  target: string,
  ctx: IssueRoutingContext = CTX,
): RoutingDecision {
  const d = classifyIssueRouting(draft, target, ctx);
  for (
    const [field, value] of [
      ["owner_repository", d.owner_repository],
      ["subject_repository", d.subject_repository],
      ["reason", d.reason],
    ] as const
  ) {
    assert(value.trim().length > 0, `${field} is empty`);
  }
  assert(KINDS.includes(d.issue_kind), `unknown issue_kind ${d.issue_kind}`);
  return d;
}

const REVIEW_FINDING: IssueRoutingDraft = {
  title: "Review finding: doc comments are never checked",
  body:
    "The review brief in prompts/review/prompt.md does not ask the reviewer to check doc comments, so this repository keeps getting stale ones.",
};

const SCORING: IssueRoutingDraft = {
  title: "Scoring bug: GRQ ranks tied stocks in the wrong order",
  body: "GRQ scoring sorts ties by ticker instead of by volume.",
};

const CROSS_REPO: IssueRoutingDraft = {
  title: "Lane worktree heal breaks the GRQ-AutoTrader PWA layout",
  body:
    "worker/deno/lib/lane_worktree.ts and the PWA layout both need a change.",
};

Deno.test("classifyIssueRouting - #3607 drafted in VibeCoder routes to GRQ-AutoTrader as implementation", () => {
  const d = route(fixture("vibecoder_3607"), VIBE);
  assertEquals(d.owner_repository, AUTOTRADER);
  assertEquals(d.subject_repository, AUTOTRADER);
  assertEquals(d.issue_kind, "implementation");
  assertStringIncludes(d.reason, "PWA");
});

Deno.test("classifyIssueRouting - GRQ-AutoTrader#3242 stays in GRQ-AutoTrader as implementation", () => {
  const d = route(fixture("grq_autotrader_3242"), AUTOTRADER);
  assertEquals(d.owner_repository, AUTOTRADER);
  assertEquals(d.issue_kind, "implementation");
  const pair = route(fixture("vibecoder_3607"), VIBE);
  assertEquals(d.owner_repository, pair.owner_repository);
  assertEquals(d.issue_kind, pair.issue_kind);
});

Deno.test("classifyIssueRouting - GRQ-AutoTrader#3184 tally issue stays in GRQ-AutoTrader as a diagnostic", () => {
  const d = route(fixture("grq_autotrader_3184"), AUTOTRADER);
  assertEquals(d.owner_repository, AUTOTRADER);
  assertEquals(d.subject_repository, AUTOTRADER);
  assertEquals(d.issue_kind, "diagnostic");
  assertStringIncludes(d.reason, "#2592");
});

Deno.test("classifyIssueRouting - #3630 worker fix routes to VibeCoder as implementation", () => {
  const d = route(fixture("vibecoder_3630"), VIBE);
  assertEquals(d.owner_repository, VIBE);
  assertEquals(d.subject_repository, AUTOTRADER);
  assertEquals(d.issue_kind, "implementation");
  assertStringIncludes(d.reason, "product signals: none");
});

Deno.test("classifyIssueRouting - a GRQ-AutoTrader review finding about prompt code routes to VibeCoder", () => {
  const d = route(REVIEW_FINDING, AUTOTRADER);
  assertEquals(d.owner_repository, VIBE);
  assertEquals(d.subject_repository, AUTOTRADER);
  assertEquals(d.issue_kind, "implementation");
  assertStringIncludes(d.reason, "prompts/");
});

Deno.test("classifyIssueRouting - a GRQ-AutoTrader review finding about worker wording routes to VibeCoder", () => {
  const d = route({
    title: "Review finding: the coding agent times out",
    body:
      "Every run against this repository is cut off by the coding agent before it pushes.",
  }, AUTOTRADER);
  assertEquals(d.owner_repository, VIBE);
  assertEquals(d.issue_kind, "implementation");
  assertStringIncludes(d.reason, "coding agent");
});

Deno.test("classifyIssueRouting - a GRQ scoring bug routes to GRQ wherever it is drafted", () => {
  for (const target of [VIBE, AUTOTRADER, GRQ]) {
    const d = route(SCORING, target);
    assertEquals(d.owner_repository, GRQ, `target ${target}`);
    assertEquals(d.subject_repository, GRQ, `target ${target}`);
    assertEquals(d.issue_kind, "implementation", `target ${target}`);
  }
});

Deno.test("classifyIssueRouting - a #2592 diagnostic is never reported as belonging to another repository", () => {
  for (
    const marker of [
      formatRepoFastFailureMarker(AUTOTRADER),
      formatRepoFastFailureTallyMarker(AUTOTRADER),
    ]
  ) {
    for (const target of [AUTOTRADER, VIBE, GRQ]) {
      const d = route({
        title:
          "fix(worker): stSoftwareAU/GRQ-AutoTrader keeps failing at setup",
        body:
          `${marker}\nworker/deno/lib/lane_worktree.ts and prompts/issue/prompt.md; the fleet sees the GRQ scoring PWA layout break.`,
      }, target);
      assertEquals(d.owner_repository, AUTOTRADER, `target ${target}`);
      assertEquals(d.subject_repository, AUTOTRADER, `target ${target}`);
      assertEquals(d.issue_kind, "diagnostic", `target ${target}`);
    }
  }
});

Deno.test("classifyIssueRouting - repository names compare case-insensitively", () => {
  // (a) markers in a different case from the target.
  for (
    const marker of [
      formatRepoFastFailureMarker(AUTOTRADER.toLowerCase()),
      formatRepoFastFailureTallyMarker(AUTOTRADER.toUpperCase()),
    ]
  ) {
    const d = route({ title: "Setup keeps failing", body: marker }, AUTOTRADER);
    assertEquals(d.issue_kind, "diagnostic");
    assertEquals(d.owner_repository, AUTOTRADER);
  }
  // (b) target in upper case.
  assertEquals(
    route(fixture("vibecoder_3607"), VIBE.toUpperCase()).owner_repository,
    AUTOTRADER,
  );
  // (c) target in lower case.
  const c = route(fixture("vibecoder_3630"), VIBE.toLowerCase());
  assertEquals(c.owner_repository, VIBE);
  assertEquals(c.issue_kind, "implementation");
  // (d) review finding drafted against a lower-case target.
  assertEquals(
    route(REVIEW_FINDING, AUTOTRADER.toLowerCase()).owner_repository,
    VIBE,
  );
  // (e) product repository configured in upper case.
  assertEquals(
    route(SCORING, VIBE, {
      vibeCoderRepo: VIBE,
      productRepos: [GRQ.toUpperCase(), AUTOTRADER],
    }).owner_repository,
    GRQ.toUpperCase(),
  );
  // (f) cross-repo draft against a lower-case target.
  const f = route(CROSS_REPO, VIBE.toLowerCase());
  assertEquals(f.issue_kind, "cross-repo");
  assertEquals(f.subject_repository, AUTOTRADER);
});

Deno.test("classifyIssueRouting - VibeCoder is never counted as a product repository", () => {
  // #3607 names VibeCoder in prose; listing it among the product repositories
  // must not make the draft name two product repositories.
  const d = route(fixture("vibecoder_3607"), VIBE, {
    vibeCoderRepo: VIBE,
    productRepos: [GRQ, AUTOTRADER, VIBE.toLowerCase()],
  });
  assertEquals(d.owner_repository, AUTOTRADER);
  assertEquals(d.issue_kind, "implementation");
});

Deno.test("classifyIssueRouting - a marker prefix quoted in prose is not a diagnostic", () => {
  const d = route({
    title: "Tally marker is never read",
    body:
      "The tally issue carries VIBE_REPO_FAST_FAILURE_TALLY:stSoftwareAU/GRQ-AutoTrader but worker/deno/lib/x.ts never reads it.",
  }, AUTOTRADER);
  assertEquals(d.issue_kind, "implementation");
  assertEquals(d.owner_repository, VIBE);
});

Deno.test("classifyIssueRouting - a diagnostic drafted against another repository stays in the monitored one", () => {
  const d = route({
    title: "Setup keeps failing",
    body: `${formatRepoFastFailureMarker(GRQ)}\n${
      formatRepoFastFailureTallyMarker(GRQ.toLowerCase())
    }`,
  }, VIBE);
  assertEquals(d.issue_kind, "diagnostic");
  assertEquals(d.owner_repository, GRQ);
  assertEquals(d.subject_repository, GRQ);
  assertStringIncludes(d.reason, "drafted against");
});

Deno.test("classifyIssueRouting - markers for two repositories are ambiguous", () => {
  const d = route({
    title: "Setup keeps failing",
    body: `${formatRepoFastFailureMarker(GRQ)}\n${
      formatRepoFastFailureMarker(AUTOTRADER)
    }`,
  }, VIBE);
  assertEquals(d.issue_kind, "ambiguous");
  assertEquals(d.owner_repository, VIBE);
  assertEquals(d.subject_repository, VIBE);
  assertStringIncludes(d.reason, "several repositories");
});

Deno.test("classifyIssueRouting - a worker and product change drafted in VibeCoder is cross-repo", () => {
  const d = route(CROSS_REPO, VIBE);
  assertEquals(d.issue_kind, "cross-repo");
  assertEquals(d.owner_repository, VIBE);
  assertEquals(d.subject_repository, AUTOTRADER);
  assertStringIncludes(d.reason, "one issue per codebase");
});

Deno.test("classifyIssueRouting - a worker and product change drafted in the product repository is cross-repo", () => {
  const d = route({
    title: "The PWA layout breaks after a run",
    body:
      "The PWA layout breaks because worker/deno/lib/render.ts rewrites it.",
  }, AUTOTRADER);
  assertEquals(d.issue_kind, "cross-repo");
  assertEquals(d.owner_repository, AUTOTRADER);
  assertEquals(d.subject_repository, VIBE);
});

const AMBIGUOUS_CASES: {
  name: string;
  draft: IssueRoutingDraft;
  target: string;
  reasonPart: string;
}[] = [
  {
    name: "no signal in VibeCoder",
    draft: { title: "Tidy up", body: "Something looks off." },
    target: VIBE,
    reasonPart: "no worker or product signal",
  },
  {
    name: "no signal in a product repo",
    draft: { title: "Tidy up", body: "Something looks off." },
    target: AUTOTRADER,
    reasonPart: "no worker or product signal",
  },
  {
    name: "bare repository mention",
    draft: { title: "GRQ-AutoTrader needs attention", body: "" },
    target: VIBE,
    reasonPart: "no worker or product signal",
  },
  {
    name: "several product repositories",
    draft: {
      title: "The GRQ score shown in the GRQ-AutoTrader PWA is stale",
      body: "",
    },
    target: VIBE,
    reasonPart: "several product repositories",
  },
  {
    name: "several product repositories, drafted in one of them",
    draft: {
      title: "The GRQ score shown in the GRQ-AutoTrader PWA is stale",
      body: "",
    },
    target: AUTOTRADER,
    reasonPart: "several product repositories",
  },
  {
    name: "product signal with no repository",
    draft: { title: "The leaderboard chart is blank", body: "" },
    target: VIBE,
    reasonPart: "no product repository",
  },
  {
    name: "worker and product signal with no repository",
    draft: {
      title: "Render tweak",
      body: "worker/deno/lib/x.ts renders the PWA layout.",
    },
    target: VIBE,
    reasonPart: "no product repository",
  },
  {
    name: "worker and product signal, target neither codebase",
    draft: {
      title: "GRQ scoring prompt",
      body: "GRQ scoring needs a new prompts/score/prompt.md.",
    },
    target: AUTOTRADER,
    reasonPart: "neither codebase",
  },
];

Deno.test("classifyIssueRouting - ambiguous drafts stay in their target with the basis stated", () => {
  for (const { name, draft, target, reasonPart } of AMBIGUOUS_CASES) {
    const d = route(draft, target);
    assertEquals(d.issue_kind, "ambiguous", name);
    assertEquals(d.owner_repository, target, name);
    assertEquals(d.subject_repository, target, name);
    assertStringIncludes(d.reason, reasonPart, name);
  }
});

Deno.test("classifyIssueRouting - more than eight marker names is ambiguous; eight are checked", () => {
  const names = (n: number): IssueRoutingDraft => ({
    title: "Many markers",
    body: Array.from(
      { length: n },
      (_, i) => `VIBE_REPO_FAST_FAILURE:owner/repo${i + 1}`,
    ).join("\n") + "\nworker/deno/lib/x.ts",
  });
  const nine = route(names(9), AUTOTRADER);
  assertEquals(nine.issue_kind, "ambiguous");
  assertStringIncludes(nine.reason, "more than 8");
  const eight = route(names(8), AUTOTRADER);
  assertEquals(eight.issue_kind, "implementation");
  assertEquals(eight.owner_repository, VIBE);
});

Deno.test("classifyIssueRouting - every decision fills in all four audit fields", () => {
  const seen = new Set<IssueKind>();
  for (
    const [draft, target] of [
      [fixture("vibecoder_3630"), VIBE],
      [fixture("grq_autotrader_3184"), AUTOTRADER],
      [CROSS_REPO, VIBE],
      [AMBIGUOUS_CASES[0]!.draft, AMBIGUOUS_CASES[0]!.target],
    ] as const
  ) {
    seen.add(route(draft, target).issue_kind);
  }
  assertEquals([...seen].sort(), [...KINDS].sort());
});

Deno.test("classifyIssueRouting - a missing field throws, naming it", () => {
  assertThrows(
    () =>
      classifyIssueRouting(
        { body: "x" } as unknown as IssueRoutingDraft,
        VIBE,
        CTX,
      ),
    Error,
    "draft.title is missing",
  );
  assertThrows(
    () => classifyIssueRouting({ title: "   " }, VIBE, CTX),
    Error,
    "draft.title is missing",
  );
  assertThrows(
    () =>
      classifyIssueRouting(
        { title: "GRQ scoring bug" },
        undefined as unknown as string,
        CTX,
      ),
    Error,
    "targetRepo is missing",
  );
  assertThrows(
    () => classifyIssueRouting({ title: "GRQ scoring bug" }, "  ", CTX),
    Error,
    "targetRepo is missing",
  );
  assertThrows(
    () => classifyIssueRouting({ title: "GRQ scoring bug" }, "not a repo", CTX),
    Error,
    "targetRepo is not an owner/name",
  );
  assertThrows(
    () =>
      classifyIssueRouting({ title: "GRQ scoring bug" }, VIBE, {
        vibeCoderRepo: "",
        productRepos: [GRQ],
      }),
    Error,
    "ctx.vibeCoderRepo is missing",
  );
  assertThrows(
    () =>
      classifyIssueRouting({ title: "GRQ scoring bug" }, VIBE, {
        vibeCoderRepo: VIBE,
        productRepos: ["GRQ"],
      }),
    Error,
    "ctx.productRepos[0]",
  );
  // Positive control: a missing body is fine.
  assertEquals(
    route({ title: "GRQ scoring bug" }, VIBE).owner_repository,
    GRQ,
  );
});

Deno.test("classifyIssueRouting - hostile input stays linear for every pattern", () => {
  const builders: [string, (n: number) => string][] = [
    ["worker path", (n) => "worker/".repeat(Math.floor(n / 7)) + "x"],
    ["worker term", (n) => "lane worktre".repeat(Math.floor(n / 12)) + "x"],
    ["product term", (n) => "-pwa".repeat(Math.floor(n / 4)) + "x"],
    ["product path", (n) => ".".repeat(n) + "cs"],
    [
      "marker candidate",
      (n) => "VIBE_REPO_FAST_FAILURE:" + "a/".repeat(Math.floor(n / 2)) + "<",
    ],
    [
      "marker prefix run",
      (n) => "VIBE_REPO_FAST_FAILURE_TALL".repeat(Math.floor(n / 27)) + "x",
    ],
    ["repository mention", (n) => "GRQ-".repeat(Math.floor(n / 4)) + "x"],
  ];
  for (const [label, build] of builders) {
    const d = assertLinearGrowth(
      label,
      build,
      (input) =>
        classifyIssueRouting({ title: "t", body: input }, AUTOTRADER, CTX),
      { baseChars: 20_000 },
    );
    assert(d.reason.length > 0, `${label}: empty reason`);
  }
});
