/**
 * Tests for the `bulk-triage-security` CLI command (Issue #2403).
 *
 * Pins the argument parsing, defaults, validation errors, and that the
 * command wires the stubbed dependencies through to runBulkTriage()
 * correctly.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { bulkTriageSecurityCommand } from "../commands/bulk_triage_security.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Result } from "../types.ts";
import type { BulkTriageSummary } from "../lib/bulk_triage.ts";

const config = buildDefaultWorkerConfig();
const REPO = "stSoftwareAU/VibeCoder";

interface StubLabelCall {
  repo: string;
  number: number;
  label: string;
}

function makeStubAddLabel(): {
  fn: (
    repo: string,
    issueNumber: number,
    label: string,
  ) => Promise<Result<void>>;
  calls: StubLabelCall[];
} {
  const calls: StubLabelCall[] = [];
  return {
    calls,
    fn: (repo, issueNumber, label) => {
      calls.push({ repo, number: issueNumber, label });
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
}

function makeGhStub(
  rows: Array<{
    number: number;
    title: string;
    url: string;
    createdAt: string;
    labels: string[];
  }>,
): (args: string[]) => Promise<string> {
  return (_args) => {
    const json = rows.map((r) => ({
      number: r.number,
      title: r.title,
      url: r.url,
      createdAt: r.createdAt,
      labels: r.labels.map((name) => ({ name })),
    }));
    return Promise.resolve(JSON.stringify(json));
  };
}

Deno.test("bulk-triage-security - rejects missing --monitored-repos", async () => {
  const result = await bulkTriageSecurityCommand.execute({}, config);
  assertEquals(result.success, false);
  assert(result.message.includes("monitored-repos"));
});

Deno.test("bulk-triage-security - rejects invalid severity selector", async () => {
  const result = await bulkTriageSecurityCommand.execute({
    "monitored-repos": REPO,
    "severities": "severity:critical",
  }, config);
  assertEquals(result.success, false);
  assert(result.message.includes("Invalid severity"));
});

Deno.test("bulk-triage-security - rejects negative --min-age-days", async () => {
  const result = await bulkTriageSecurityCommand.execute({
    "monitored-repos": REPO,
    "min-age-days": "-1",
  }, config);
  assertEquals(result.success, false);
  assert(result.message.includes("min-age-days"));
});

Deno.test("bulk-triage-security - rejects zero --max", async () => {
  const result = await bulkTriageSecurityCommand.execute({
    "monitored-repos": REPO,
    "max": "0",
  }, config);
  assertEquals(result.success, false);
  assert(result.message.includes("max"));
});

Deno.test("bulk-triage-security - applies label and returns summary", async () => {
  const gh = makeGhStub([
    {
      number: 1,
      title: "f1",
      url: "u/1",
      createdAt: "2026-05-01T00:00:00Z",
      labels: ["security", "severity:high"],
    },
  ]);
  const label = makeStubAddLabel();
  const lines: string[] = [];

  const result = await bulkTriageSecurityCommand.execute({
    "monitored-repos": REPO,
    "findings-labels": "security",
    "__testDeps": {
      log: (l: string) => lines.push(l),
      ghCommandFn: gh,
      addLabelFn: (repo: string, n: number, l: string) => label.fn(repo, n, l),
    },
  }, config);

  assertEquals(result.success, true);
  assertEquals(label.calls.length, 1);
  assertEquals(label.calls[0]?.label, "work-on");
  const data = result.data as BulkTriageSummary;
  assertEquals(data.labelled, 1);
  // Summary line is emitted.
  assert(lines.some((l) => l.includes("action=summary")));
});

Deno.test("bulk-triage-security - dry-run skips writes", async () => {
  const gh = makeGhStub([
    {
      number: 2,
      title: "f2",
      url: "u/2",
      createdAt: "2026-05-01T00:00:00Z",
      labels: ["security"],
    },
  ]);
  const label = makeStubAddLabel();
  const lines: string[] = [];

  const result = await bulkTriageSecurityCommand.execute({
    "monitored-repos": REPO,
    "findings-labels": "security",
    "dry-run": true,
    "__testDeps": {
      log: (l: string) => lines.push(l),
      ghCommandFn: gh,
      addLabelFn: (repo: string, n: number, l: string) => label.fn(repo, n, l),
    },
  }, config);

  assertEquals(result.success, true);
  assertEquals(label.calls.length, 0);
  const data = result.data as BulkTriageSummary;
  assertEquals(data.wouldLabel, 1);
  assertEquals(data.dryRun, true);
  assert(lines.some((l) => l.includes("action=would_label")));
});

Deno.test("bulk-triage-security - severity filter honoured", async () => {
  const gh = makeGhStub([
    {
      number: 10,
      title: "low",
      url: "u/10",
      createdAt: "2026-05-01T00:00:00Z",
      labels: ["security", "severity:low"],
    },
    {
      number: 11,
      title: "high",
      url: "u/11",
      createdAt: "2026-05-02T00:00:00Z",
      labels: ["security", "severity:high"],
    },
  ]);
  const label = makeStubAddLabel();

  const result = await bulkTriageSecurityCommand.execute({
    "monitored-repos": REPO,
    "findings-labels": "security",
    "severities": "severity:high",
    "__testDeps": {
      log: () => {},
      ghCommandFn: gh,
      addLabelFn: (repo: string, n: number, l: string) => label.fn(repo, n, l),
    },
  }, config);

  assertEquals(result.success, true);
  assertEquals(label.calls.length, 1);
  assertEquals(label.calls[0]?.number, 11);
});

Deno.test("bulk-triage-security - custom apply-label honoured", async () => {
  const gh = makeGhStub([
    {
      number: 20,
      title: "f",
      url: "u/20",
      createdAt: "2026-05-01T00:00:00Z",
      labels: ["security"],
    },
  ]);
  const label = makeStubAddLabel();

  const result = await bulkTriageSecurityCommand.execute({
    "monitored-repos": REPO,
    "findings-labels": "security",
    "apply-label": "top-priority",
    "__testDeps": {
      log: () => {},
      ghCommandFn: gh,
      addLabelFn: (repo: string, n: number, l: string) => label.fn(repo, n, l),
    },
  }, config);

  assertEquals(result.success, true);
  assertEquals(label.calls[0]?.label, "top-priority");
});
