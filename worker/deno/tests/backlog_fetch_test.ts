/**
 * Tests for the backlog-report data gathering (Issue #2405).
 *
 * Exercises gh-JSON parsing and per-repo de-duplication with an injected
 * gh runner — no live GitHub.
 */

import { assertEquals } from "@std/assert";
import {
  fetchFindings,
  FINDING_LABELS,
  parseFindingsJson,
} from "../lib/backlog_fetch.ts";

Deno.test("parseFindingsJson - normalises a security finding", () => {
  const raw = JSON.stringify([
    {
      number: 12,
      labels: [{ name: "security" }, { name: "severity:high" }],
      createdAt: "2026-05-01T00:00:00Z",
      closedAt: null,
      state: "OPEN",
    },
  ]);
  const findings = parseFindingsJson(raw, "org/repo");
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!, {
    repo: "org/repo",
    number: 12,
    state: "open",
    severity: "high",
    category: "security",
    createdAt: "2026-05-01T00:00:00Z",
    closedAt: null,
  });
});

Deno.test("parseFindingsJson - closed finding keeps closedAt", () => {
  const raw = JSON.stringify([
    {
      number: 5,
      labels: [{ name: "supply-chain-readiness" }, { name: "severity:low" }],
      createdAt: "2026-04-01T00:00:00Z",
      closedAt: "2026-04-10T00:00:00Z",
      state: "CLOSED",
    },
  ]);
  const findings = parseFindingsJson(raw, "org/repo");
  assertEquals(findings[0]!.state, "closed");
  assertEquals(findings[0]!.category, "supply-chain");
  assertEquals(findings[0]!.closedAt, "2026-04-10T00:00:00Z");
});

Deno.test("parseFindingsJson - skips non-finding and malformed rows", () => {
  const raw = JSON.stringify([
    { number: 1, labels: [{ name: "bug" }], createdAt: "2026-05-01T00:00:00Z" },
    { number: 2, labels: [{ name: "security" }] }, // missing createdAt
    null,
    "garbage",
  ]);
  assertEquals(parseFindingsJson(raw, "org/repo"), []);
});

Deno.test("parseFindingsJson - tolerates malformed JSON", () => {
  assertEquals(parseFindingsJson("not json", "org/repo"), []);
});

Deno.test("fetchFindings - de-duplicates issues across label queries", async () => {
  const calls: string[][] = [];
  // The same issue (#7) carries both `security` and a supply-chain label,
  // so it shows up in two label queries — it must only be counted once.
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const labelIdx = args.indexOf("--label");
    const label = args[labelIdx + 1];
    if (label === "security") {
      return Promise.resolve(JSON.stringify([
        {
          number: 7,
          labels: [{ name: "security" }, { name: "supply-chain-readiness" }],
          createdAt: "2026-05-01T00:00:00Z",
          closedAt: null,
          state: "OPEN",
        },
      ]));
    }
    if (label === "supply-chain-readiness") {
      return Promise.resolve(JSON.stringify([
        {
          number: 7,
          labels: [{ name: "security" }, { name: "supply-chain-readiness" }],
          createdAt: "2026-05-01T00:00:00Z",
          closedAt: null,
          state: "OPEN",
        },
      ]));
    }
    return Promise.resolve("[]");
  };

  const findings = await fetchFindings({
    repos: ["org/repo"],
    ghCommandFn,
  });

  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.number, 7);
  // One query per finding label.
  assertEquals(calls.length, FINDING_LABELS.length);
});

Deno.test("fetchFindings - a failing label query is skipped, not fatal", async () => {
  const warnings: string[] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    const label = args[args.indexOf("--label") + 1];
    if (label === "security") {
      return Promise.reject(new Error("rate limited"));
    }
    if (label === "supply-chain-readiness") {
      return Promise.resolve(JSON.stringify([
        {
          number: 9,
          labels: [{ name: "supply-chain-readiness" }],
          createdAt: "2026-05-01T00:00:00Z",
          closedAt: null,
          state: "OPEN",
        },
      ]));
    }
    return Promise.resolve("[]");
  };

  const findings = await fetchFindings({
    repos: ["org/repo"],
    ghCommandFn,
    warn: (m) => warnings.push(m),
  });

  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.number, 9);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]!.includes("query_failed"), true);
});
