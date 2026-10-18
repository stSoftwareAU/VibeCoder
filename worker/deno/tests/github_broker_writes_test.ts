import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type GitHubBrokerWriteContext,
  resolveGitHubBrokerWrite,
} from "../lib/github_broker_writes.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";

const context: GitHubBrokerWriteContext = {
  repositories: ["fixture/allowed"],
  claimedIssue: { repo: "fixture/allowed", issueNumber: 7 },
};
const encoder = new TextEncoder();
const token = "ghp_" + "a".repeat(36);

function write(
  method: string,
  path: string,
  body: unknown,
  hostContext = context,
) {
  return resolveGitHubBrokerWrite(
    new Request(`http://broker.invalid/github/repos/fixture/allowed/${path}`, {
      method,
    }),
    hostContext,
    encoder.encode(JSON.stringify(body)),
  );
}

function denied(result: ReturnType<typeof write>, reason: string): void {
  assertEquals(result, { allowed: false, reason });
}

Deno.test("GitHub broker writes preserve supported ordinary REST bodies and classify their actual targets", () => {
  for (
    const [method, path, body] of [
      ["POST", "issues", {
        title: "Finding",
        body: "Details",
        labels: ["bug", "confidence:high"],
      }],
      ["POST", "issues", { title: "Finding" }],
      ["POST", "issues", { title: "Finding", labels: [] }],
      ["PATCH", "issues/7", { title: "Updated", body: "" }],
      ["PATCH", "issues/7", { body: "Revised" }],
      ["POST", "issues/7/comments", { body: "A comment" }],
      ["PATCH", "issues/comments/10", { body: "Updated comment" }],
      ["POST", "issues/7/labels", { labels: ["bug"] }],
      ["POST", "pulls", {
        title: "Change",
        body: "Details",
        head: "feature",
        base: "main",
        draft: true,
      }],
      ["POST", "pulls", {
        title: "Change",
        head: "owner:feature",
        base: "milestone/121",
        draft: false,
      }],
      ["POST", "pulls", { title: "Change", head: "feature", base: "main" }],
      ["PATCH", "pulls/8", { title: "Updated PR", body: "Details" }],
    ] as const
  ) {
    const result = write(method, path, body);
    assert(result.allowed, `${method} ${path}: ${JSON.stringify(result)}`);
    assertEquals(
      result.upstream.href,
      `https://api.github.com/repos/fixture/allowed/${path}`,
    );
    assertEquals(JSON.parse(new TextDecoder().decode(result.body)), body);
    assertEquals(result.mutation.verb, `api-${method.toLowerCase()}`);
    assertEquals(result.mutation.scope, "explicit");
    assertEquals(result.mutation.repo, "fixture/allowed");
    assertEquals(result.mutation.target, `repos/fixture/allowed/${path}`);
  }
});

Deno.test("GitHub broker writes keep lifecycle, reviews, label removal, git and unknown routes closed", () => {
  for (
    const [method, path] of [
      ["PUT", "pulls/8/merge"],
      ["POST", "pulls/8/reviews"],
      ["PATCH", "git/refs/heads/main"],
      ["POST", "git/refs"],
      ["POST", "releases"],
      ["DELETE", "issues/7/labels"],
      ["DELETE", "issues/7/labels/bug"],
      ["PUT", "issues/7/labels"],
      ["PUT", "issues/7/lock"],
      ["POST", "issues/7/comments/extra"],
      ["GET", "issues"],
      ["HEAD", "issues"],
      ["DELETE", "issues/comments/10"],
      ["POST", "issues/0/comments"],
      ["POST", "issues/07/comments"],
      ["POST", "issues/7/comments?access_token=hidden"],
      ["POST", "issues/7/comments/"],
      ["POST", "issues%2f7%2fcomments"],
    ]
  ) {
    denied(
      write(method!, path!, { body: "text", state: "closed", approved: true }),
      "GitHub write route denied",
    );
  }
  for (
    const path of [
      "/github/graphql",
      "/github/user",
      "/github/repos/fixture/other/issues",
      "/claude/v1/messages",
    ]
  ) {
    const result = resolveGitHubBrokerWrite(
      new Request(`http://broker.invalid${path}`, { method: "POST" }),
      context,
      encoder.encode('{"title":"Finding"}'),
    );
    denied(
      result,
      path.includes("/fixture/other/")
        ? "GitHub write policy denied"
        : "GitHub write route denied",
    );
  }
});

Deno.test("GitHub broker writes deny unknown fields and malformed supported schemas before any publication", () => {
  for (
    const [path, body] of [
      ["issues", {}],
      ["issues", { title: 1 }],
      ["issues", { title: "" }],
      ["issues", { title: "  " }],
      ["issues", { title: "ok", body: null }],
      ["issues", { title: "ok", labels: "bug" }],
      ["issues", { title: "ok", labels: [1] }],
      ["issues", { title: "ok", labels: [{ name: "bug" }] }],
      ["issues", { title: "ok", labels: [""] }],
      ["issues", { title: "ok", labels: [" \u200b "] }],
      ["issues", { title: "ok", role: "worker" }],
      ["issues", { title: "ok", approved: true }],
      ["issues", { title: "ok", allowedRepos: ["fixture/other"] }],
      ["issues/7/comments", {}],
      ["issues/7/comments", { body: 3 }],
      ["issues/7/comments", { body: "" }],
      ["issues/7/labels", {}],
      ["issues/7/labels", { labels: [] }],
      ["pulls", { title: "ok", head: "feature" }],
      ["pulls", { title: "ok", base: "main" }],
      ["pulls", { title: "ok", head: "feature", base: "main", draft: "false" }],
      ["pulls", { title: "ok", head: "", base: "main" }],
      ["pulls", { title: "ok", head: "feature", base: "" }],
      ["pulls", { title: "ok", head: "feature", base: "main", state: "open" }],
    ] as const
  ) denied(write("POST", path, body), "GitHub write body denied");
  for (const path of ["issues/7", "pulls/8"]) {
    for (
      const body of [
        {},
        { state: "closed" },
        { state: "open" },
        { state_reason: "completed" },
        { base: "main" },
        { labels: [] },
        { labels: ["bug"] },
        { approved: true },
      ]
    ) {
      denied(write("PATCH", path, body), "GitHub write body denied");
    }
    denied(write("PATCH", path, { title: "" }), "GitHub write body denied");
  }
});

Deno.test("GitHub broker writes enforce trusted repository scope regardless of request-supplied authority", () => {
  denied(
    write("POST", "issues", { title: "ok" }, { repositories: [] }),
    "GitHub write policy denied",
  );
  denied(
    write("POST", "issues", { title: "ok" }, {
      repositories: ["fixture/other"],
    }),
    "GitHub write policy denied",
  );
  assert(
    write("POST", "issues", { title: "ok" }, {
      repositories: ["Fixture/Allowed"],
    }).allowed,
  );
  const result = resolveGitHubBrokerWrite(
    new Request("https://untrusted.invalid/github/repos/fixture/other/issues", {
      method: "POST",
      headers: {
        "x-broker-role": "worker",
        "x-allowed-repos": "fixture/other",
      },
    }),
    context,
    encoder.encode('{"title":"ok"}'),
  );
  denied(result, "GitHub write policy denied");
});

Deno.test("GitHub broker writes reuse reserved-label guards for every supplied label spelling", () => {
  for (
    const label of [
      "work-on",
      "top-priority",
      "planning",
      "best-model",
      "failed",
      "failed-once",
      " ToP-PrIoRiTy \u00a0",
      "ordinary,work-on",
      "quorum",
    ]
  ) {
    for (const path of ["issues", "issues/7/labels"]) {
      const body = path === "issues"
        ? { title: "Finding", labels: ["bug", label] }
        : { labels: ["bug", label] };
      denied(write("POST", path, body), "GitHub write policy denied");
    }
  }
  assert(
    write("POST", "issues/7/labels", {
      labels: ["@literal", "security", "confidence:high"],
    }).allowed,
  );
});

Deno.test("GitHub broker writes scope needs-human escalation to the existing own-claim policy", () => {
  assert(write("POST", "issues/7/labels", { labels: ["needs-human"] }).allowed);
  denied(
    write("POST", "issues/8/labels", { labels: ["needs-human"] }),
    "GitHub write policy denied",
  );
  denied(
    write("POST", "issues/7/labels", { labels: ["needs-human", "failed"] }),
    "GitHub write policy denied",
  );
  assert(
    write("POST", "issues/8/labels", { labels: ["needs-human"] }, {
      repositories: ["fixture/allowed"],
    }).allowed,
  );
  // An extra caller-style property cannot enlarge the fixed ordinary-write surface.
  const host = {
    ...context,
    claimedIssue: {
      ...context.claimedIssue!,
      allowedVerbs: ["close", "reopen", "merge"],
    },
  };
  denied(
    write("PATCH", "issues/7", { state: "closed" }, host),
    "GitHub write body denied",
  );
});

Deno.test("GitHub broker writes redact publication text and fail closed on secrets in routing or labels", () => {
  for (
    const [method, path, body] of [
      ["POST", "issues", {
        title: `Finding ${token}`,
        body: `Details ${token}`,
      }],
      ["POST", "issues/7/comments", { body: `Details ${token}` }],
      ["PATCH", "issues/comments/10", { body: `Details ${token}` }],
      ["PATCH", "pulls/8", {
        title: `Finding ${token}`,
        body: `Details ${token}`,
      }],
    ] as const
  ) {
    const result = write(method, path, body);
    assert(result.allowed);
    const text = new TextDecoder().decode(result.body);
    assert(!text.includes(token));
    assertStringIncludes(text, REDACTION_PLACEHOLDER);
  }
  const prompt = write("POST", "issues/7/comments", {
    body: "<coding_guidelines>private instructions</coding_guidelines>",
  });
  assert(prompt.allowed);
  assert(
    !new TextDecoder().decode(prompt.body).includes("private instructions"),
  );
  for (
    const body of [{ title: "ok", labels: [token] }, {
      title: "ok",
      labels: ["\u200b ToP-PrIoRiTy \u00a0"],
    }, {
      title: "ok",
      head: token,
      base: "main",
    }, { title: "ok", head: "feature", base: token }]
  ) {
    const path = "labels" in body ? "issues" : "pulls";
    denied(write("POST", path, body), "GitHub write redaction failed");
  }
});

Deno.test("GitHub broker writes bound and strictly decode immutable JSON while canonicalising duplicate keys", () => {
  for (const body of [null, [], "text", 1]) {
    denied(write("POST", "issues", body), "GitHub write body denied");
  }
  const request = new Request(
    "http://broker.invalid/github/repos/fixture/allowed/issues",
    { method: "POST" },
  );
  for (
    const bytes of [
      encoder.encode("{"),
      new Uint8Array([0xff]),
      encoder.encode('{"title":"ok"}'.padEnd(131_073)),
    ]
  ) {
    denied(
      resolveGitHubBrokerWrite(request, context, bytes),
      "GitHub write body denied",
    );
  }
  assert(
    resolveGitHubBrokerWrite(
      request,
      context,
      encoder.encode('{"title":"ok"}'.padEnd(131_072)),
    ).allowed,
  );
  const raw =
    `{"title":"${token}","title":"safe","labels":["work-on"],"labels":["bug"]}`;
  const result = resolveGitHubBrokerWrite(
    request,
    context,
    encoder.encode(raw),
  );
  assert(result.allowed);
  assertEquals(
    new TextDecoder().decode(result.body),
    '{"title":"safe","labels":["bug"]}',
  );
  const reverse = '{"title":"safe","labels":["bug"],"labels":["work-on"]}';
  denied(
    resolveGitHubBrokerWrite(request, context, encoder.encode(reverse)),
    "GitHub write policy denied",
  );
  const malformed = new Uint8Array([
    ...encoder.encode('{"title":"'),
    0xff,
    ...encoder.encode('","title":"safe"}'),
  ]);
  denied(
    resolveGitHubBrokerWrite(request, context, malformed),
    "GitHub write body denied",
  );
});

Deno.test("GitHub broker writes validate required fields after mandatory redaction", () => {
  denied(
    write("POST", "issues", { title: "\u200b" }),
    "GitHub write body denied",
  );
  denied(
    write("POST", "issues/7/comments", { body: "\u200b" }),
    "GitHub write body denied",
  );
});
