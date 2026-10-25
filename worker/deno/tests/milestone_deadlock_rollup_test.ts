/**
 * Direct lookup of dependency numbers the issue listings omit (Issue #4327).
 *
 * Issues and pull requests share numbers. A merged or closed pull request
 * is a landed dependency and must not be warned about. A number that does
 * not exist is still warned about, once per cycle.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { buildMilestoneDependencyGraph } from "../lib/milestone_deadlock_rollup.ts";

const REPO = "owner/repo";

interface Logged {
  message: string;
  level?: string;
}

function openIssue(number: number, body: string) {
  return {
    number,
    title: `Issue #${number}`,
    assignees: [],
    labels: [],
    createdAt: "2024-01-01T00:00:00Z",
    milestone: { title: "Crates API" },
    author: { login: "alice" },
    url: `https://github.com/${REPO}/issues/${number}`,
    body,
  };
}

function captureLog(): {
  log: (message: string, level?: string) => void;
  lines: Logged[];
} {
  const lines: Logged[] = [];
  return {
    lines,
    log(message: string, level?: string) {
      lines.push(level === undefined ? { message } : { message, level });
    },
  };
}

function scriptedGh(
  open: unknown[],
  closed: unknown[],
  onLookup: (number: number) => Promise<string>,
): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list" && args.includes("open")) {
      return Promise.resolve(JSON.stringify(open));
    }
    if (args[0] === "issue" && args[1] === "list" && args.includes("closed")) {
      return Promise.resolve(JSON.stringify(closed));
    }
    if (args[0] === "api") {
      const path = args[1] ?? "";
      const prefix = `repos/${REPO}/issues/`;
      if (!path.startsWith(prefix)) {
        return Promise.reject(new Error(`unexpected api path ${path}`));
      }
      return onLookup(Number(path.slice(prefix.length)));
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  return { gh, calls };
}

function apiCalls(calls: string[][]): string[][] {
  return calls.filter((args) => args[0] === "api");
}

Deno.test("buildMilestoneDependencyGraph - a merged or closed pull request missing from the listings is landed, with no warning", async () => {
  const { gh, calls } = scriptedGh(
    [
      openIssue(1, "Depends on #4106"),
      openIssue(2, "Depends on #4107"),
    ],
    [],
    (number) => {
      if (number === 4106) {
        return Promise.resolve(JSON.stringify({
          number: 4106,
          state: "closed",
          milestone: { title: "Web src" },
          pull_request: { merged_at: "2026-01-02T00:00:00Z" },
        }));
      }
      if (number === 4107) {
        return Promise.resolve(JSON.stringify({
          number: 4107,
          state: "closed",
          milestone: { title: "Web src" },
          pull_request: { merged_at: null },
        }));
      }
      return Promise.reject(new Error(`unexpected lookup #${number}`));
    },
  );
  const { log, lines } = captureLog();

  const graph = await buildMilestoneDependencyGraph(
    REPO,
    ["Crates API", "Web src"],
    gh,
    log,
  );

  assertEquals(
    graph.openIssues.map((issue) => issue.dependsOn),
    [[4106], [4107]],
  );
  assertEquals(graph.landedDependencies, [4106, 4107]);
  assertEquals(graph.closedDependencies, []);
  assertEquals(lines, []);
  assertEquals(apiCalls(calls), [
    ["api", `repos/${REPO}/issues/4106`],
    ["api", `repos/${REPO}/issues/4107`],
  ]);
});

Deno.test("buildMilestoneDependencyGraph - a number that does not exist is warned about once per cycle", async () => {
  const { gh } = scriptedGh(
    [
      openIssue(1, "Depends on #4106"),
      openIssue(2, "Depends on #9999"),
    ],
    [],
    () => Promise.reject(new Error("gh: Not Found (HTTP 404)")),
  );
  const { log, lines } = captureLog();
  const expected = {
    message: "milestone deadlock detection could not resolve #4106, #9999 in " +
      "owner/repo — not in the open listing, the recent closed listing, " +
      "or a direct issue lookup",
    level: "warn",
  };

  await buildMilestoneDependencyGraph(REPO, ["Crates API"], gh, log);
  await buildMilestoneDependencyGraph(REPO, ["Crates API"], gh, log);

  assertEquals(lines, [expected, expected]);
  assertEquals(lines[0]?.message.includes("WARNING:"), false);
  assertEquals(lines[0]?.message.includes("ERROR:"), false);
});

Deno.test("buildMilestoneDependencyGraph - a closed issue missing from the recent listing keeps its milestone", async () => {
  const { gh, calls } = scriptedGh(
    [openIssue(1, "Depends on #50")],
    [],
    (number) => {
      assertEquals(number, 50);
      return Promise.resolve(JSON.stringify({
        number: 50,
        state: "closed",
        milestone: { title: "Web src" },
      }));
    },
  );
  const { log, lines } = captureLog();

  const graph = await buildMilestoneDependencyGraph(
    REPO,
    ["Web src"],
    gh,
    log,
  );

  assertEquals(graph.closedDependencies, [{
    number: 50,
    milestone: "Web src",
  }]);
  assertEquals(graph.landedDependencies, []);
  assertEquals(lines, []);
  assertEquals(apiCalls(calls), [["api", `repos/${REPO}/issues/50`]]);
});

Deno.test("buildMilestoneDependencyGraph - an open pull request is resolved and not warned about", async () => {
  const { gh } = scriptedGh(
    [openIssue(1, "Depends on #4106")],
    [],
    () =>
      Promise.resolve(JSON.stringify({
        number: 4106,
        state: "open",
        milestone: null,
        pull_request: { merged_at: null },
      })),
  );
  const { log, lines } = captureLog();

  const graph = await buildMilestoneDependencyGraph(
    REPO,
    ["Crates API"],
    gh,
    log,
  );

  assertEquals(graph.landedDependencies, []);
  assertEquals(graph.closedDependencies, []);
  assertEquals(lines, []);
});

Deno.test("buildMilestoneDependencyGraph - a closed listing hit is not looked up again", async () => {
  const { gh, calls } = scriptedGh(
    [openIssue(1, "Depends on #50")],
    [{
      number: 50,
      title: "Closed",
      milestone: { title: "Web src" },
      updatedAt: "2024-01-01T00:00:00Z",
    }],
    () => Promise.reject(new Error("direct lookup should not run")),
  );
  const { log, lines } = captureLog();

  const graph = await buildMilestoneDependencyGraph(
    REPO,
    ["Web src"],
    gh,
    log,
  );

  assertEquals(graph.closedDependencies, [{
    number: 50,
    milestone: "Web src",
  }]);
  assertEquals(graph.landedDependencies, []);
  assertEquals(lines, []);
  assertEquals(apiCalls(calls), []);
});

Deno.test("buildMilestoneDependencyGraph - a direct lookup failure that is not a missing number fails loud", async () => {
  const { gh } = scriptedGh(
    [openIssue(1, "Depends on #4106")],
    [],
    () => Promise.reject(new Error("gh: API rate limit exceeded (HTTP 403)")),
  );
  const { log } = captureLog();

  const error = await assertRejects(
    () => buildMilestoneDependencyGraph(REPO, ["Crates API"], gh, log),
    Error,
    "#4106",
  );
  assertStringIncludes(error.message, "API rate limit exceeded");
});

Deno.test("buildMilestoneDependencyGraph - a direct lookup with no milestone field fails loud", async () => {
  const { gh } = scriptedGh(
    [openIssue(1, "Depends on #4106")],
    [],
    () => Promise.resolve(JSON.stringify({ number: 4106, state: "closed" })),
  );
  const { log } = captureLog();

  const error = await assertRejects(
    () => buildMilestoneDependencyGraph(REPO, ["Crates API"], gh, log),
    Error,
    "milestone",
  );
  assertStringIncludes(error.message, "#4106");
});

Deno.test("buildMilestoneDependencyGraph - a direct lookup that is not JSON fails loud", async () => {
  const { gh } = scriptedGh(
    [openIssue(1, "Depends on #4106")],
    [],
    () => Promise.resolve("not-json"),
  );
  const { log } = captureLog();

  await assertRejects(
    () => buildMilestoneDependencyGraph(REPO, ["Crates API"], gh, log),
    Error,
    "invalid JSON",
  );
});
