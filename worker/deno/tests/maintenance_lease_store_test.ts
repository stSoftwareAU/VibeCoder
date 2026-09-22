/**
 * Tests for the maintenance-lease store — the per-repository anchor issue and
 * the lease marker comment on it (Issue #2450, Decision 2 of #2443).
 *
 * Every test drives the real `maintenance_lease_store.ts` functions with a
 * fake `gh` and a temporary work directory, then asserts on the returned
 * holder, the recorded argv, the pin file or the degraded log line. No test
 * reaches GitHub.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatMaintenanceLeaseMarker,
  MAINTENANCE_LEASE_SECONDS,
} from "../lib/maintenance_lease.ts";
import {
  formatMaintenanceLeaseAnchorMarker,
  MAINTENANCE_LEASE_ANCHOR_TITLE,
  maintenanceLeaseAnchorPinPath,
  type MaintenanceLeaseIo,
  readMaintenanceLease,
  refreshMaintenanceLease,
  resolveMaintenanceLeaseAnchor,
} from "../lib/maintenance_lease_store.ts";

const REPO = "stSoftwareAU/VibeCoder";
const HOST = "vibe-coder-abc-1079448c-0b73-4259-ad4e-e2f5dd922657";
const INSTALL = "1079448c-0b73-4259-ad4e-e2f5dd922657";
const OTHER_INSTALL = "ffffffff-0000-1111-2222-333344445555";
const FLEET = "vibe-coder-bot";
const NOW = 1_700_000_000;
const ANCHOR = 42;

/** One fake `gh` invocation, with the argv it was called with. */
interface FakeGh {
  calls: string[][];
  ghCommandFn: (args: string[]) => Promise<string>;
}

/** A fake `gh` that records every argv and answers from `handler`. */
function fakeGh(
  handler: (args: string[]) => string | Promise<string>,
): FakeGh {
  const calls: string[][] = [];
  return {
    calls,
    ghCommandFn: async (args: string[]) => {
      calls.push(args);
      return await handler(args);
    },
  };
}

/** The payload `gh api --paginate --jq` prints for a comment read. */
function commentsPayload(
  rows: Array<{ id: number; body: string; author: string }>,
): string {
  return JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      body: row.body,
      created_at: "2026-01-01T00:00:00Z",
      author: row.author,
    })),
  );
}

/** The payload the anchor search's `--jq` projection prints. */
function searchPayload(
  rows: Array<{ number: number; body: string; author: string }>,
): string {
  return JSON.stringify(
    rows.map((row) => ({
      number: row.number,
      body: row.body,
      author: row.author,
    })),
  );
}

/** Is this argv the REST anchor search? */
function isAnchorSearch(args: string[]): boolean {
  return args[0] === "api" && args.includes("search/issues");
}

/** Is this argv the REST anchor creation? */
function isAnchorCreate(args: string[]): boolean {
  return args[0] === "api" && args[1] === `repos/${REPO}/issues` &&
    args.includes("POST");
}

/** Is this argv a comment post on the anchor? */
function isCommentPost(args: string[]): boolean {
  return args[0] === "api" &&
    (args[1] ?? "").endsWith(`/issues/${ANCHOR}/comments`) &&
    args.includes("POST");
}

/** The value of the `-f <name>=…` field in this argv. */
function field(args: string[], name: string): string {
  const prefix = `${name}=`;
  return (args.find((arg) => arg.startsWith(prefix)) ?? "").slice(
    prefix.length,
  );
}

/** A fake anchor thread — the service the store talks to, in memory. */
interface FakeThread extends FakeGh {
  /** The comments currently on the anchor, as GitHub would hold them. */
  comments: Array<{ id: number; body: string; author: string }>;
}

/**
 * A fake `gh` that models the anchor thread rather than a canned reply.
 *
 * A POST really appends a comment, a PATCH really rewrites one and a DELETE
 * really removes it, so a marker the store writes is readable by the store's
 * own next read — the round trip no canned payload can prove.
 */
function fakeAnchorThread(
  seed: Array<{ id: number; body: string; author: string }> = [],
  writeAuthor: string = FLEET,
): FakeThread {
  const comments = [...seed];
  let nextId = 1000;
  const gh = fakeGh((args) => {
    const endpoint = args[1] ?? "";
    if (isAnchorSearch(args)) return searchPayload([]);
    if (isAnchorCreate(args)) return `${ANCHOR}\n`;
    if (isCommentRead(args, ANCHOR)) {
      return commentsPayload(comments);
    }
    const body = field(args, "body");
    if (isCommentPost(args)) {
      const id = nextId++;
      comments.push({ id, body, author: writeAuthor });
      return JSON.stringify({ id });
    }
    if (args.includes("PATCH")) {
      const id = Number(endpoint.split("/").at(-1));
      const target = comments.find((comment) => comment.id === id);
      if (target === undefined) throw new Error(`gh: 404 comment ${id}`);
      target.body = body;
      return JSON.stringify({ id });
    }
    if (args.includes("DELETE")) {
      const id = Number((args.at(-1) ?? "").split("/").at(-1));
      const index = comments.findIndex((comment) => comment.id === id);
      if (index < 0) throw new Error(`gh: 404 comment ${id}`);
      comments.splice(index, 1);
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  });
  return { calls: gh.calls, ghCommandFn: gh.ghCommandFn, comments };
}

/** Does this argv read the comment thread of `issueNumber`? */
function isCommentRead(args: string[], issueNumber: number): boolean {
  return args[0] === "api" &&
    (args[1] ?? "").startsWith(
      `repos/${REPO}/issues/${issueNumber}/comments`,
    ) &&
    args.includes("--paginate");
}

/** Run `body` with a temporary work directory, then remove it. */
async function withWorkDir(
  body: (workDir: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "maintenance-lease-" });
  try {
    await body(workDir);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

/** The injected io, with the log lines captured for assertions. */
function makeIo(
  workDir: string,
  gh: FakeGh,
  overrides: Partial<MaintenanceLeaseIo> = {},
): { io: MaintenanceLeaseIo; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    io: {
      ghCommandFn: gh.ghCommandFn,
      trustedAuthors: [FLEET],
      workDir,
      log: (line: string) => logs.push(line),
      ...overrides,
    },
  };
}

/** A trusted lease marker comment for `host`, stamped at `atEpoch`. */
function leaseComment(
  id: number,
  host: string,
  atEpoch: number,
  author: string = FLEET,
): { id: number; body: string; author: string } {
  return {
    id,
    body: `${formatMaintenanceLeaseMarker(REPO, host, atEpoch)}\nheld`,
    author,
  };
}

// ---------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------

Deno.test("maintenance lease anchor - no anchor exists, so it is created and pinned", async () => {
  await withWorkDir(async (workDir) => {
    const gh = fakeGh((args) => {
      if (isAnchorSearch(args)) return searchPayload([]);
      if (isAnchorCreate(args)) return `${ANCHOR}\n`;
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io, logs } = makeIo(workDir, gh);

    assertEquals(await resolveMaintenanceLeaseAnchor(REPO, io), ANCHOR);

    const create = gh.calls.find(isAnchorCreate);
    assert(create !== undefined, "the anchor issue must be created");
    assertEquals(field(create, "title"), MAINTENANCE_LEASE_ANCHOR_TITLE);
    assertStringIncludes(
      field(create, "body"),
      formatMaintenanceLeaseAnchorMarker(REPO),
    );
    assertEquals(
      create.some((arg) => arg.startsWith("labels")),
      false,
      "the anchor never carries a discovery label",
    );

    const pinned = await Deno.readTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
    );
    assertEquals(pinned.trim(), String(ANCHOR));
    assertEquals(logs.filter((l) => l.includes("degraded")), []);
  });
});

Deno.test("maintenance lease anchor - the pinned number is reused without a search", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    const gh = fakeGh((args) => {
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io } = makeIo(workDir, gh);

    assertEquals(await resolveMaintenanceLeaseAnchor(REPO, io), ANCHOR);
    assertEquals(gh.calls, [], "a pinned anchor costs no GitHub call at all");
  });
});

Deno.test("maintenance lease anchor - an existing anchor by a fleet author is adopted, not duplicated", async () => {
  await withWorkDir(async (workDir) => {
    const gh = fakeGh((args) => {
      if (isAnchorSearch(args)) {
        return searchPayload([
          // An impostor's anchor is ignored; the fleet-authored one is adopted.
          {
            number: 7,
            body: formatMaintenanceLeaseAnchorMarker(REPO),
            author: "attacker",
          },
          {
            number: ANCHOR,
            body: formatMaintenanceLeaseAnchorMarker(REPO),
            author: FLEET,
          },
        ]);
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io } = makeIo(workDir, gh);

    assertEquals(await resolveMaintenanceLeaseAnchor(REPO, io), ANCHOR);
    assertEquals(
      gh.calls.some(isAnchorCreate),
      false,
      "an adopted anchor is never re-created",
    );
    const pinned = await Deno.readTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
    );
    assertEquals(pinned.trim(), String(ANCHOR));
  });
});

Deno.test("maintenance lease anchor - the per-repo config override wins over the pin", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      "5\n",
    );
    const gh = fakeGh((args) => {
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io } = makeIo(workDir, gh, {
      repoConfigs: { [REPO]: { maintenanceLeaseIssue: 314 } },
    });

    assertEquals(await resolveMaintenanceLeaseAnchor(REPO, io), 314);
    assertEquals(gh.calls, []);
  });
});

Deno.test("maintenance lease anchor - a non-positive or non-integer override is ignored", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      const gh = fakeGh((args) => {
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      });
      const { io } = makeIo(workDir, gh, {
        repoConfigs: { [REPO]: { maintenanceLeaseIssue: bad } },
      });
      assertEquals(
        await resolveMaintenanceLeaseAnchor(REPO, io),
        ANCHOR,
        `override ${bad} must fall through to the pinned anchor`,
      );
    }
  });
});

Deno.test("maintenance lease anchor - an unparseable create result degrades rather than guessing", async () => {
  await withWorkDir(async (workDir) => {
    const gh = fakeGh((args) => {
      if (isAnchorSearch(args)) return searchPayload([]);
      // A response the `--jq .number` projection could not reduce to a number.
      if (isAnchorCreate(args)) return "null\n";
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io, logs } = makeIo(workDir, gh);

    assertEquals(await resolveMaintenanceLeaseAnchor(REPO, io), null);
    assert(
      logs.some((line) =>
        line.startsWith("maintenance-lease: degraded — ") &&
        line.includes("could not be created")
      ),
      `expected a degraded log line, got ${JSON.stringify(logs)}`,
    );
  });
});

Deno.test("maintenance lease anchor - a failed search never files a duplicate anchor", async () => {
  await withWorkDir(async (workDir) => {
    const gh = fakeGh((args) => {
      if (isAnchorSearch(args)) {
        throw new Error("gh: API rate limit exceeded");
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io, logs } = makeIo(workDir, gh);

    assertEquals(await resolveMaintenanceLeaseAnchor(REPO, io), null);
    assertEquals(gh.calls.some(isAnchorCreate), false);
    assert(
      logs.some((line) =>
        line.startsWith("maintenance-lease: degraded — ") &&
        line.includes("rate limit")
      ),
      `expected a degraded log line, got ${JSON.stringify(logs)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// readMaintenanceLease
// ---------------------------------------------------------------------------

Deno.test("maintenance lease read - a marker from a non-trusted author is ignored", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    const gh = fakeGh((args) => {
      if (isCommentRead(args, ANCHOR)) {
        return commentsPayload([
          leaseComment(1, OTHER_INSTALL, NOW, "attacker"),
        ]);
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io } = makeIo(workDir, gh);

    assertEquals(await readMaintenanceLease(REPO, io), null);
  });
});

Deno.test("maintenance lease read - the freshest marker wins", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    const gh = fakeGh((args) => {
      if (isCommentRead(args, ANCHOR)) {
        return commentsPayload([
          leaseComment(1, OTHER_INSTALL, NOW - 600),
          leaseComment(2, INSTALL, NOW - 30),
          leaseComment(3, OTHER_INSTALL, NOW - 300),
        ]);
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io } = makeIo(workDir, gh);

    const holder = await readMaintenanceLease(REPO, io);
    assert(holder !== null);
    assertEquals(holder.host, INSTALL);
    assertEquals(holder.atEpoch, NOW - 30);
  });
});

Deno.test("maintenance lease read - an API failure degrades to null without throwing", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    const gh = fakeGh(() => {
      throw new Error("gh: 503 Service Unavailable");
    });
    const { io, logs } = makeIo(workDir, gh);

    assertEquals(await readMaintenanceLease(REPO, io), null);
    assert(
      logs.some((line) =>
        line.startsWith("maintenance-lease: degraded — ") &&
        line.includes("503")
      ),
      `expected a degraded log line, got ${JSON.stringify(logs)}`,
    );
  });
});

Deno.test("maintenance lease read - a pin pointing at a deleted anchor is dropped so the next cycle recovers", async () => {
  await withWorkDir(async (workDir) => {
    const pin = maintenanceLeaseAnchorPinPath(workDir, REPO);
    await Deno.writeTextFile(pin, `${ANCHOR}\n`);
    const gh = fakeGh(() => {
      throw new Error("gh: HTTP 404: Not Found");
    });
    const { io } = makeIo(workDir, gh);

    assertEquals(await readMaintenanceLease(REPO, io), null);
    assertEquals(
      await Deno.stat(pin).then(() => true).catch(() => false),
      false,
      "a pin GitHub says is gone must not be kept and re-read for ever",
    );
  });
});

Deno.test("maintenance lease read - a transient failure keeps the pin", async () => {
  await withWorkDir(async (workDir) => {
    const pin = maintenanceLeaseAnchorPinPath(workDir, REPO);
    await Deno.writeTextFile(pin, `${ANCHOR}\n`);
    const gh = fakeGh(() => {
      throw new Error("gh: 503 Service Unavailable");
    });
    const { io } = makeIo(workDir, gh);

    assertEquals(await readMaintenanceLease(REPO, io), null);
    assertEquals(
      (await Deno.readTextFile(pin)).trim(),
      String(ANCHOR),
      "a transient error is not evidence the anchor is gone",
    );
  });
});

Deno.test("maintenance lease read - a malformed repository name degrades instead of building a path", async () => {
  await withWorkDir(async (workDir) => {
    const gh = fakeGh((args) => {
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io, logs } = makeIo(workDir, gh);

    assertEquals(await readMaintenanceLease("../../etc/passwd", io), null);
    assertEquals(gh.calls, []);
    assert(logs.some((line) => line.includes("degraded")));
  });
});

// ---------------------------------------------------------------------------
// refreshMaintenanceLease
// ---------------------------------------------------------------------------

Deno.test("maintenance lease refresh - the first hold posts a new marker comment", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    const gh = fakeAnchorThread();
    const { io, logs } = makeIo(workDir, gh);

    assertEquals(await refreshMaintenanceLease(REPO, HOST, NOW, io), true);

    const post = gh.calls.find(isCommentPost);
    assert(post !== undefined, "the first hold posts the marker");
    assertEquals(post[1], `repos/${REPO}/issues/${ANCHOR}/comments`);
    const body = field(post, "body");
    assertStringIncludes(body, `host=${INSTALL}`);
    assertStringIncludes(body, `at=${NOW}`);
    assert(
      body.replace(/<!--[\s\S]*?-->/gu, "").trim().length > 0,
      "the comment carries a visible line as well as the marker",
    );
    assertEquals(gh.comments.length, 1, "exactly one marker is on the anchor");
    assertEquals(logs.filter((l) => l.includes("degraded")), []);
  });
});

Deno.test("maintenance lease refresh - the marker written is the marker read back", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    const gh = fakeAnchorThread();
    const { io } = makeIo(workDir, gh);

    assertEquals(await refreshMaintenanceLease(REPO, HOST, NOW, io), true);

    const holder = await readMaintenanceLease(REPO, io);
    assert(holder !== null, "the lease this host just took must be readable");
    assertEquals(holder.host, INSTALL);
    assertEquals(holder.atEpoch, NOW);

    // The next cycle refreshes the same comment, and the read follows it.
    assertEquals(
      await refreshMaintenanceLease(REPO, HOST, NOW + 300, io),
      true,
    );
    assertEquals(gh.comments.length, 1, "the anchor keeps one marker per host");
    assertEquals((await readMaintenanceLease(REPO, io))?.atEpoch, NOW + 300);
  });
});

Deno.test("maintenance lease refresh - the host's own marker is patched, never re-posted", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    // Stamped by the same install under an older hostname (Issue #2403).
    const gh = fakeAnchorThread([leaseComment(88, INSTALL, NOW - 120)]);
    const { io } = makeIo(workDir, gh);

    assertEquals(await refreshMaintenanceLease(REPO, HOST, NOW, io), true);

    const patch = gh.calls.find((args) => args.includes("PATCH"));
    assert(patch !== undefined, "the own marker is patched in place");
    assertEquals(patch[1], `repos/${REPO}/issues/comments/88`);
    assertEquals(
      gh.calls.some(isCommentPost),
      false,
      "a second comment is never posted for the same host",
    );
    assertEquals(gh.comments.length, 1);
    assertStringIncludes(gh.comments[0]?.body ?? "", `at=${NOW}`);
  });
});

Deno.test("maintenance lease refresh - a duplicate of this host's own marker is deleted", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    // Two markers for one install — a raced double-post.
    const gh = fakeAnchorThread([
      leaseComment(88, INSTALL, NOW - 120),
      leaseComment(89, INSTALL, NOW - 60),
    ]);
    const { io } = makeIo(workDir, gh);

    assertEquals(await refreshMaintenanceLease(REPO, HOST, NOW, io), true);
    assertEquals(
      gh.comments.map((comment) => comment.id),
      [88],
      "the first own marker is kept and refreshed; the duplicate goes",
    );
  });
});

Deno.test("maintenance lease refresh - an expired foreign marker is deleted", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    const gh = fakeAnchorThread([
      leaseComment(11, OTHER_INSTALL, NOW - MAINTENANCE_LEASE_SECONDS),
    ]);
    const { io } = makeIo(workDir, gh);

    assertEquals(await refreshMaintenanceLease(REPO, HOST, NOW, io), true);

    const deletes = gh.calls.filter((args) => args.includes("DELETE"));
    assertEquals(deletes.length, 1, "the dead holder's marker is deleted");
    assertEquals(deletes[0]?.at(-1), `repos/${REPO}/issues/comments/11`);
    assertEquals(
      gh.comments.map((comment) => comment.id),
      [1000],
      "this host's new marker is all that is left",
    );
  });
});

Deno.test("maintenance lease refresh - a fresh foreign holder is never overwritten", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    const gh = fakeAnchorThread([leaseComment(12, OTHER_INSTALL, NOW - 10)]);
    const { io, logs } = makeIo(workDir, gh);

    assertEquals(await refreshMaintenanceLease(REPO, HOST, NOW, io), false);
    assertEquals(
      gh.comments.map((comment) => comment.id),
      [12],
      "the holder's marker is untouched and no second marker is posted",
    );
    assert(
      logs.some((line) => line.includes(`held by ${OTHER_INSTALL}`)),
      `expected a held-elsewhere log line, got ${JSON.stringify(logs)}`,
    );
  });
});

Deno.test("maintenance lease refresh - a foreign marker whose author differs only in case is this host's fleet", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    // GitHub logins are case-insensitive, so `Vibe-Coder-Bot` is `vibe-coder-bot`.
    const gh = fakeAnchorThread([
      leaseComment(88, INSTALL, NOW - 120, FLEET.toUpperCase()),
    ]);
    const { io } = makeIo(workDir, gh);

    assertEquals(await refreshMaintenanceLease(REPO, HOST, NOW, io), true);
    assertEquals(
      gh.calls.some(isCommentPost),
      false,
      "the marker is recognised as this host's own and patched, not duplicated",
    );
  });
});

Deno.test("maintenance lease refresh - a failed write degrades to false without throwing", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    const gh = fakeGh((args) => {
      if (isCommentRead(args, ANCHOR)) return commentsPayload([]);
      throw new Error("gh: 422 Unprocessable Entity");
    });
    const { io, logs } = makeIo(workDir, gh);

    assertEquals(await refreshMaintenanceLease(REPO, HOST, NOW, io), false);
    assert(
      logs.some((line) =>
        line.startsWith("maintenance-lease: degraded — ") &&
        line.includes("422")
      ),
      `expected a degraded log line, got ${JSON.stringify(logs)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// No GraphQL — the lease must not cost what it saves
// ---------------------------------------------------------------------------

Deno.test("maintenance lease store - every gh call is REST, never GraphQL", async () => {
  await withWorkDir(async (workDir) => {
    // Anchor creation, the comment read, the post and the expired-marker
    // delete — every path the store has, in one pass.
    const gh = fakeAnchorThread([
      leaseComment(11, OTHER_INSTALL, NOW - MAINTENANCE_LEASE_SECONDS),
    ]);
    const { io } = makeIo(workDir, gh);

    await refreshMaintenanceLease(REPO, HOST, NOW, io);
    await readMaintenanceLease(REPO, io);

    assert(gh.calls.length > 0, "the fake gh must have been exercised");
    for (const args of gh.calls) {
      assertEquals(
        args.includes("graphql"),
        false,
        `GraphQL argv: ${args.join(" ")}`,
      );
      assertEquals(
        args.some((arg) => arg.includes("query {") || arg.includes("query(")),
        false,
        `GraphQL document in argv: ${args.join(" ")}`,
      );
      // `gh api` is the only REST-backed verb; every other sub-command goes
      // through GraphQL (`gh_argv.ts`), `issue list`/`issue create` included.
      assertEquals(args[0], "api", `not a REST call: ${args.join(" ")}`);
    }
  });
});
