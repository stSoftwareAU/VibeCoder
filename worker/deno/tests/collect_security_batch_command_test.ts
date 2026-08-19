/**
 * Tests for collect_security_batch.ts (Issue #2402).
 *
 * The command collects open `security` findings for a repo and groups them
 * into batched-remediation candidates via the grouping engine. Tests inject
 * a fake gh runner so no GitHub I/O occurs.
 */

import { assertEquals } from "@std/assert";
import {
  collectSecurityBatch,
  parseCollectSecurityBatchArgs,
  parseRawFindingIssues,
} from "../commands/collect_security_batch.ts";

const config = {} as never;

function fakeGh(json: unknown): (args: string[]) => Promise<string> {
  return () => Promise.resolve(JSON.stringify(json));
}

Deno.test("collectSecurityBatch - groups findings by file and emits closes refs", async () => {
  const gh = fakeGh([
    {
      number: 1,
      title: "🟠 SQL injection in src/a.ts:10",
      body: "<!-- finding-id: SEC-aaa000111222 -->",
      labels: [{ name: "security" }, { name: "severity:high" }],
    },
    {
      number: 2,
      title: "🟡 Path traversal in src/a.ts:30",
      body: "<!-- finding-id: SEC-bbb000111222 -->",
      labels: [{ name: "security" }, { name: "severity:medium" }],
    },
    {
      number: 3,
      title: "🟢 Weak hash in src/b.ts:5",
      body: "<!-- finding-id: SEC-ccc000111222 -->",
      labels: [{ name: "security" }, { name: "severity:low" }],
    },
  ]);

  const result = await collectSecurityBatch(
    { repo: "owner/repo", strategy: "file", maxGroupSize: 5 },
    config,
    gh,
  );

  assertEquals(result.success, true);
  assertEquals(result.data?.totalFindings, 3);
  assertEquals(result.data?.groups.length, 2);
  const aGroup = result.data?.groups.find((g) => g.key === "src/a.ts");
  assertEquals(aGroup?.issueNumbers, [1, 2]);
  assertEquals(aGroup?.closes.includes("Closes #1"), true);
  assertEquals(aGroup?.closes.includes("Closes #2"), true);
});

Deno.test("collectSecurityBatch - excludes the overflow tracker issue", async () => {
  const gh = fakeGh([
    {
      number: 1,
      title: "🟠 SQL injection in src/a.ts:10",
      body: "<!-- finding-id: SEC-aaa000111222 -->",
      labels: [{ name: "security" }, { name: "severity:high" }],
    },
    {
      number: 99,
      title: "security-scan-overflow: 3 unfiled findings",
      body: "- SEC-x — high xss in foo",
      labels: [{ name: "security" }, { name: "security-scan-overflow" }],
    },
  ]);

  const result = await collectSecurityBatch(
    { repo: "owner/repo", strategy: "file", maxGroupSize: 5 },
    config,
    gh,
  );

  assertEquals(result.data?.totalFindings, 1);
});

Deno.test("collectSecurityBatch - returns zero findings when list is empty", async () => {
  const result = await collectSecurityBatch(
    { repo: "owner/repo", strategy: "file", maxGroupSize: 5 },
    config,
    fakeGh([]),
  );
  assertEquals(result.success, true);
  assertEquals(result.data?.totalFindings, 0);
  assertEquals(result.data?.groups, []);
});

Deno.test("collectSecurityBatch - surfaces a gh failure as an error result", async () => {
  const gh = () => Promise.reject(new Error("gh exploded"));
  const result = await collectSecurityBatch(
    { repo: "owner/repo", strategy: "file", maxGroupSize: 5 },
    config,
    gh,
  );
  assertEquals(result.success, false);
});

Deno.test("parseRawFindingIssues - maps gh label objects to name strings", () => {
  const raw = parseRawFindingIssues(JSON.stringify([
    {
      number: 7,
      title: "t",
      body: "b",
      labels: [{ name: "security" }, { name: "severity:low" }],
    },
  ]));
  assertEquals(raw.length, 1);
  assertEquals(raw[0]?.labels, ["security", "severity:low"]);
});

Deno.test("parseRawFindingIssues - tolerates malformed JSON", () => {
  assertEquals(parseRawFindingIssues("not json"), []);
});

Deno.test("parseCollectSecurityBatchArgs - requires repo", () => {
  const result = parseCollectSecurityBatchArgs({});
  assertEquals(typeof result, "string");
});

Deno.test("parseCollectSecurityBatchArgs - defaults strategy and cap", () => {
  const result = parseCollectSecurityBatchArgs({ repo: "owner/repo" });
  assertEquals(typeof result === "object" && result.strategy, "file");
  assertEquals(typeof result === "object" && result.maxGroupSize, 5);
});

Deno.test("parseCollectSecurityBatchArgs - rejects an unknown strategy", () => {
  const result = parseCollectSecurityBatchArgs({
    repo: "owner/repo",
    strategy: "bogus",
  });
  assertEquals(typeof result, "string");
});

Deno.test("parseCollectSecurityBatchArgs - rejects a non-positive cap", () => {
  const result = parseCollectSecurityBatchArgs({
    repo: "owner/repo",
    "max-group-size": "0",
  });
  assertEquals(typeof result, "string");
});
