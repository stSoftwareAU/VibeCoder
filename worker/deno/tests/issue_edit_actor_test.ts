/**
 * Tests for the issue edit-actor resolver (Issue #3715).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolveLastIssueEditor } from "../lib/issue_edit_actor.ts";

interface GraphPayload {
  contentEdits?: Array<
    {
      editedAt?: string | null;
      diff?: string;
      editor?: { login?: string } | null;
    }
  >;
  renames?: Array<
    { createdAt?: string | null; actor?: { login?: string } | null }
  >;
}

function graphMock(
  payload: GraphPayload,
  captured?: string[][],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    captured?.push(args);
    return Promise.resolve(JSON.stringify({
      data: {
        repository: {
          issue: {
            userContentEdits: {
              totalCount: payload.contentEdits?.length ?? 0,
              nodes: payload.contentEdits ?? [],
            },
            timelineItems: { nodes: payload.renames ?? [] },
          },
        },
      },
    }));
  };
}

Deno.test("issue_edit_actor - returns the body editor when it is the newest edit", async () => {
  const gh = graphMock({
    contentEdits: [
      { editedAt: "2026-05-01T10:00:00Z", editor: { login: "alice" } },
      { editedAt: "2026-05-01T12:00:00Z", editor: { login: "mallory" } },
    ],
    renames: [
      { createdAt: "2026-05-01T09:00:00Z", actor: { login: "alice" } },
    ],
  });

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.actor?.login, "mallory");
  assertEquals(result.actor?.source, "content-edit");
  assertEquals(
    result.actor?.editedAt,
    Math.floor(Date.parse("2026-05-01T12:00:00Z") / 1000),
  );
});

Deno.test("issue_edit_actor - returns the renamer when a title edit is the newest", async () => {
  const gh = graphMock({
    contentEdits: [
      { editedAt: "2026-05-01T10:00:00Z", editor: { login: "alice" } },
    ],
    renames: [
      { createdAt: "2026-05-01T18:30:00Z", actor: { login: "mallory" } },
    ],
  });

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.actor?.login, "mallory");
  assertEquals(result.actor?.source, "rename");
});

Deno.test("issue_edit_actor - returns a null actor when the issue was never edited", async () => {
  const result = await resolveLastIssueEditor("owner/repo", 42, graphMock({}));

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.actor, null);
});

Deno.test("issue_edit_actor - pairs ordered body snapshots and fails closed on ambiguous history", async () => {
  const lookup = (contentEdits: GraphPayload["contentEdits"]) =>
    resolveLastIssueEditor("owner/repo", 42, graphMock({ contentEdits }), {
      includeDiff: true,
    });
  const earlier = {
    editedAt: "2026-05-01T10:00:00Z",
    diff: "original",
    editor: { login: "a" },
  };
  const later = {
    editedAt: "2026-05-01T11:00:00Z",
    diff: "new body",
    editor: { login: "b" },
  };
  const ordered = await lookup([later, earlier]);
  assertEquals(ordered.ok && ordered.actors[0]?.previousDiff, "original");
  const sameTime = await lookup([earlier, {
    ...later,
    editedAt: earlier.editedAt,
  }]);
  assertEquals(
    sameTime.ok && sameTime.actors.every((a) => a.previousDiff === undefined),
    true,
  );
  const malformed = await lookup([
    earlier,
    { ...later, editedAt: "bad" },
    later,
  ]);
  assertEquals(
    malformed.ok && malformed.actors.every((a) => a.previousDiff === undefined),
    true,
  );
});

Deno.test("issue_edit_actor - yields an empty login when GitHub records no editor", async () => {
  // A deleted or anonymised account leaves the edit but drops the actor;
  // an unattributable edit must never read as a trusted login.
  const gh = graphMock({
    contentEdits: [{ editedAt: "2026-05-01T10:00:00Z", editor: null }],
  });

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.actor?.login, "");
});

Deno.test("issue_edit_actor - skips edits with an unparseable timestamp", async () => {
  const gh = graphMock({
    contentEdits: [
      { editedAt: "not-a-date", editor: { login: "mallory" } },
      { editedAt: "2026-05-01T10:00:00Z", editor: { login: "alice" } },
    ],
  });

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.actor?.login, "alice");
});

Deno.test("issue_edit_actor - surfaces an untrusted body edit hidden behind a later rename (Issue #3879)", async () => {
  // The attack shape: mallory rewrites the body, a maintainer later fixes a
  // typo in the title. Collapsing to the newest actor reported only alice.
  const gh = graphMock({
    contentEdits: [
      { editedAt: "2026-05-01T10:00:00Z", editor: { login: "mallory" } },
    ],
    renames: [
      { createdAt: "2026-05-01T18:30:00Z", actor: { login: "alice" } },
    ],
  });

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.actors.length, 2);
  assertEquals(
    result.actors.map((a) => a.login),
    ["alice", "mallory"],
    "History is returned newest first, both actors preserved",
  );
  assertEquals(result.actors.map((a) => a.source), ["rename", "content-edit"]);
  assertEquals(result.actor?.login, "alice");
});

Deno.test("issue_edit_actor - orders equal timestamps by source then login (Issue #3879)", async () => {
  // Ties used to resolve to GraphQL node order. The rule is now explicit:
  // content-edit before rename, then login ascending.
  const gh = graphMock({
    contentEdits: [
      { editedAt: "2026-05-01T10:00:00Z", editor: { login: "mallory" } },
      { editedAt: "2026-05-01T10:00:00Z", editor: { login: "alice" } },
    ],
    renames: [
      { createdAt: "2026-05-01T10:00:00Z", actor: { login: "bob" } },
    ],
  });

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(
    result.actors.map((a) => `${a.source}:${a.login}`),
    ["content-edit:alice", "content-edit:mallory", "rename:bob"],
  );
  assertEquals(result.actor?.login, "alice");
});

Deno.test("issue_edit_actor - returns an empty history when the issue was never edited (Issue #3879)", async () => {
  const result = await resolveLastIssueEditor("owner/repo", 42, graphMock({}));

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.actors, []);
  assertEquals(result.actor, null);
});

Deno.test("issue_edit_actor - omits edits with an unparseable timestamp from the history (Issue #3879)", async () => {
  const gh = graphMock({
    contentEdits: [
      { editedAt: "not-a-date", editor: { login: "mallory" } },
      { editedAt: "2026-05-01T10:00:00Z", editor: { login: "alice" } },
    ],
  });

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.actors.map((a) => a.login), ["alice"]);
});

Deno.test("issue_edit_actor - reports an error when the gh call fails", async () => {
  const gh = () => Promise.reject(new Error("gh: API rate limit exceeded"));

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "rate limit");
});

Deno.test("issue_edit_actor - reports an error on unparseable JSON", async () => {
  const gh = () => Promise.resolve("{not json");

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, false);
});

Deno.test("issue_edit_actor - reports an error on empty output", async () => {
  const gh = () => Promise.resolve("");

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, false);
});

Deno.test("issue_edit_actor - reports an error when GraphQL returns errors", async () => {
  const gh = () =>
    Promise.resolve(JSON.stringify({
      errors: [{ message: "Could not resolve to a Repository" }],
    }));

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "Could not resolve");
});

Deno.test("issue_edit_actor - reports an error when the issue node is absent", async () => {
  const gh = () =>
    Promise.resolve(JSON.stringify({ data: { repository: { issue: null } } }));

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, false);
});

Deno.test("issue_edit_actor - rejects a malformed repository without calling gh", async () => {
  let called = false;
  const gh = () => {
    called = true;
    return Promise.resolve("");
  };

  const result = await resolveLastIssueEditor("not-a-repo", 42, gh);

  assertEquals(result.ok, false);
  assertEquals(called, false);
});

Deno.test("issue_edit_actor - passes owner, name and number to the GraphQL call", async () => {
  const captured: string[][] = [];
  const gh = graphMock({}, captured);

  await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(captured.length, 1);
  const args = captured[0] ?? [];
  assertEquals(args[0], "api");
  assertEquals(args[1], "graphql");
  assertEquals(args.includes("owner=owner"), true);
  assertEquals(args.includes("name=repo"), true);
  assertEquals(args.includes("number=42"), true);
});

Deno.test("issue_edit_actor - includeDiff asks for and returns each body edit's diff (Issue #4763)", async () => {
  const captured: string[][] = [];
  const gh = graphMock({
    contentEdits: [
      { editedAt: "2026-05-01T10:00:00Z", diff: "+x", editor: { login: "a" } },
    ],
    renames: [{ createdAt: "2026-05-01T09:00:00Z", actor: { login: "a" } }],
  }, captured);

  const withDiff = await resolveLastIssueEditor("owner/repo", 42, gh, {
    includeDiff: true,
  });
  assertEquals(withDiff.ok, true);
  if (withDiff.ok) {
    assertEquals(
      withDiff.actors.map((a) => [a.source, a.diff]),
      [["content-edit", "+x"], ["rename", undefined]],
    );
  }
  assertStringIncludes(captured[0]!.join(" "), "editedAt diff editor");

  // Default: the query and the result stay as the content gate expects.
  const plain = await resolveLastIssueEditor("owner/repo", 42, gh);
  assertEquals(
    plain.ok && plain.actors.every((a) => a.diff === undefined),
    true,
  );
  assertEquals(captured[1]!.join(" ").includes("diff"), false);
});

/**
 * A GraphQL fake for an issue with `count` body edits, stored oldest first
 * (edit `i` is `user${i}`, one minute after edit `i - 1`). It serves the window
 * GitHub would: `first:N` from the newest end, `last:N` from the oldest end,
 * with `totalCount` covering the whole connection (Issue #4804).
 */
function windowedGraphMock(
  count: number,
  captured?: string[][],
): (args: string[]) => Promise<string> {
  const oldestFirst = Array.from({ length: count }, (_, i) => ({
    editedAt: new Date(Date.UTC(2026, 4, 1) + i * 60_000).toISOString(),
    editor: { login: `user${i}` },
  }));
  return (args: string[]) => {
    captured?.push(args);
    const query = args.join(" ");
    const first = /userContentEdits\(first:(\d+)\)/.exec(query);
    const last = /userContentEdits\(last:(\d+)\)/.exec(query);
    const nodes = first
      ? [...oldestFirst].reverse().slice(0, Number(first[1]))
      : last
      ? oldestFirst.slice(Math.max(0, count - Number(last[1])))
      : [];
    return Promise.resolve(JSON.stringify({
      data: {
        repository: {
          issue: {
            userContentEdits: { totalCount: count, nodes },
            timelineItems: { nodes: [] },
          },
        },
      },
    }));
  };
}

Deno.test("issue_edit_actor - asks for the newest 100 body edits by default (Issue #4804)", async () => {
  const captured: string[][] = [];

  await resolveLastIssueEditor(
    "owner/repo",
    42,
    windowedGraphMock(3, captured),
  );

  assertStringIncludes(
    captured[0]!.join(" "),
    "userContentEdits(first:100){totalCount nodes{editedAt editor{login}}}",
  );
});

Deno.test("issue_edit_actor - keeps the newest 100 of 150 body edits and reports truncation (Issue #4804)", async () => {
  const result = await resolveLastIssueEditor(
    "owner/repo",
    42,
    windowedGraphMock(150),
  );

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.bodyHistoryTruncated, true);
  assertEquals(result.actor?.login, "user149");
  assertEquals(
    result.actor?.editedAt,
    Math.floor(Date.parse("2026-05-01T02:29:00Z") / 1000),
  );
  assertEquals(result.actors.length, 100);
  assertEquals(
    result.actors.every((a) => a.source === "content-edit"),
    true,
  );
  assertEquals(result.actors[0]?.login, "user149");
  assertEquals(result.actors.at(-1)?.login, "user50");
  assertEquals(
    result.actors.at(-1)?.editedAt,
    Math.floor(Date.parse("2026-05-01T00:50:00Z") / 1000),
  );
  assertEquals(result.actors.some((a) => a.login === "user49"), false);
});

Deno.test("issue_edit_actor - reports no truncation for a 3-edit history (Issue #4804)", async () => {
  const result = await resolveLastIssueEditor(
    "owner/repo",
    42,
    windowedGraphMock(3),
  );

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.bodyHistoryTruncated, false);
  assertEquals(result.actors.map((a) => a.login), [
    "user2",
    "user1",
    "user0",
  ]);
});

Deno.test("issue_edit_actor - rejects a body connection without totalCount (Issue #4804)", async () => {
  const gh = () =>
    Promise.resolve(JSON.stringify({
      data: {
        repository: {
          issue: {
            userContentEdits: {
              nodes: [{
                editedAt: "2026-05-01T10:00:00Z",
                editor: { login: "alice" },
              }],
            },
            timelineItems: { nodes: [] },
          },
        },
      },
    }));

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "totalCount");
});

Deno.test("issue_edit_actor - rejects a totalCount smaller than the returned nodes (Issue #4804)", async () => {
  const gh = () =>
    Promise.resolve(JSON.stringify({
      data: {
        repository: {
          issue: {
            userContentEdits: {
              totalCount: 1,
              nodes: [
                {
                  editedAt: "2026-05-01T10:00:00Z",
                  editor: { login: "alice" },
                },
                {
                  editedAt: "2026-05-01T11:00:00Z",
                  editor: { login: "bob" },
                },
              ],
            },
            timelineItems: { nodes: [] },
          },
        },
      },
    }));

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "totalCount");
});

Deno.test("issue_edit_actor - fails closed when a truncated history has an unparseable editedAt (Issue #4804)", async () => {
  // 101 edits exist but only 2 are returned, one with a garbage timestamp:
  // the older edits cannot be placed against the snapshot, so reject.
  const gh = () =>
    Promise.resolve(JSON.stringify({
      data: {
        repository: {
          issue: {
            userContentEdits: {
              totalCount: 101,
              nodes: [
                {
                  editedAt: "2026-05-01T11:00:00Z",
                  editor: { login: "alice" },
                },
                {
                  editedAt: "not-a-date",
                  editor: { login: "mallory" },
                },
              ],
            },
            timelineItems: { nodes: [] },
          },
        },
      },
    }));

  const result = await resolveLastIssueEditor("owner/repo", 42, gh);

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "unparseable editedAt");
});
