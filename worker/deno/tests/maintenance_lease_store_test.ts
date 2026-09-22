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

/** The payload `gh issue list --json number,body,author` prints. */
function issueListPayload(
  rows: Array<{ number: number; body: string; author: string }>,
): string {
  return JSON.stringify(
    rows.map((row) => ({
      number: row.number,
      body: row.body,
      author: { login: row.author },
    })),
  );
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
      if (args[0] === "issue" && args[1] === "list") {
        return issueListPayload([]);
      }
      if (args[0] === "issue" && args[1] === "create") {
        return `https://github.com/${REPO}/issues/${ANCHOR}\n`;
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io, logs } = makeIo(workDir, gh);

    assertEquals(await resolveMaintenanceLeaseAnchor(REPO, io), ANCHOR);

    const create = gh.calls.find((args) =>
      args[0] === "issue" && args[1] === "create"
    );
    assert(create !== undefined, "the anchor issue must be created");
    assert(
      create.includes(MAINTENANCE_LEASE_ANCHOR_TITLE),
      "the anchor keeps its canonical title",
    );
    const body = create[create.indexOf("--body") + 1] ?? "";
    assertStringIncludes(body, formatMaintenanceLeaseAnchorMarker(REPO));
    assertEquals(
      create.includes("--label"),
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
      if (args[0] === "issue" && args[1] === "list") {
        return issueListPayload([
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
      gh.calls.some((args) => args[1] === "create"),
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

Deno.test("maintenance lease anchor - a failed search never files a duplicate anchor", async () => {
  await withWorkDir(async (workDir) => {
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") {
        throw new Error("gh: API rate limit exceeded");
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io, logs } = makeIo(workDir, gh);

    assertEquals(await resolveMaintenanceLeaseAnchor(REPO, io), null);
    assertEquals(gh.calls.some((args) => args[1] === "create"), false);
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
    const gh = fakeGh((args) => {
      if (isCommentRead(args, ANCHOR)) return commentsPayload([]);
      if (args.includes("POST")) return "{}";
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io, logs } = makeIo(workDir, gh);

    assertEquals(await refreshMaintenanceLease(REPO, HOST, NOW, io), true);

    const post = gh.calls.find((args) => args.includes("POST"));
    assert(post !== undefined, "the first hold posts the marker");
    assertEquals(post[1], `repos/${REPO}/issues/${ANCHOR}/comments`);
    const body = post[post.indexOf("-f") + 1] ?? "";
    assertStringIncludes(body, `host=${INSTALL}`);
    assertStringIncludes(body, `at=${NOW}`);
    assert(
      body.replace(/<!--[\s\S]*?-->/gu, "").trim().length > 0,
      "the comment carries a visible line as well as the marker",
    );
    assertEquals(logs.filter((l) => l.includes("degraded")), []);
  });
});

Deno.test("maintenance lease refresh - the host's own marker is patched, never re-posted", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    const gh = fakeGh((args) => {
      if (isCommentRead(args, ANCHOR)) {
        // Stamped by the same install under an older hostname (Issue #2403).
        return commentsPayload([leaseComment(88, INSTALL, NOW - 120)]);
      }
      if (args.includes("PATCH")) return "88";
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io } = makeIo(workDir, gh);

    assertEquals(await refreshMaintenanceLease(REPO, HOST, NOW, io), true);

    const patch = gh.calls.find((args) => args.includes("PATCH"));
    assert(patch !== undefined, "the own marker is patched in place");
    assertEquals(patch[1], `repos/${REPO}/issues/comments/88`);
    assertStringIncludes(patch[patch.indexOf("-f") + 1] ?? "", `at=${NOW}`);
    assertEquals(
      gh.calls.some((args) => args.includes("POST")),
      false,
      "a second comment is never posted for the same host",
    );
  });
});

Deno.test("maintenance lease refresh - an expired foreign marker is deleted", async () => {
  await withWorkDir(async (workDir) => {
    await Deno.writeTextFile(
      maintenanceLeaseAnchorPinPath(workDir, REPO),
      `${ANCHOR}\n`,
    );
    const gh = fakeGh((args) => {
      if (isCommentRead(args, ANCHOR)) {
        return commentsPayload([
          leaseComment(11, OTHER_INSTALL, NOW - MAINTENANCE_LEASE_SECONDS),
          leaseComment(12, OTHER_INSTALL, NOW - 10),
        ]);
      }
      if (args.includes("POST") || args.includes("DELETE")) return "{}";
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });
    const { io } = makeIo(workDir, gh);

    assertEquals(await refreshMaintenanceLease(REPO, HOST, NOW, io), true);

    const deletes = gh.calls.filter((args) => args.includes("DELETE"));
    assertEquals(deletes.length, 1, "only the expired marker is deleted");
    assertEquals(
      deletes[0]?.at(-1),
      `repos/${REPO}/issues/comments/11`,
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
    const gh = fakeGh((args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return issueListPayload([]);
      }
      if (args[0] === "issue" && args[1] === "create") {
        return `https://github.com/${REPO}/issues/${ANCHOR}\n`;
      }
      if (isCommentRead(args, ANCHOR)) {
        return commentsPayload([
          leaseComment(11, OTHER_INSTALL, NOW - MAINTENANCE_LEASE_SECONDS),
        ]);
      }
      return "{}";
    });
    const { io } = makeIo(workDir, gh);

    await refreshMaintenanceLease(REPO, HOST, NOW, io);
    await readMaintenanceLease(REPO, io);

    assert(gh.calls.length > 0, "the fake gh must have been exercised");
    for (const args of gh.calls) {
      assertEquals(
        args.includes("graphql") || args.includes("--field") &&
            args.includes("query"),
        false,
        `GraphQL argv: ${args.join(" ")}`,
      );
      const rest = args[0] === "api" ||
        (args[0] === "issue" && (args[1] === "list" || args[1] === "create"));
      assert(rest, `not a REST-backed call: ${args.join(" ")}`);
    }
  });
});
