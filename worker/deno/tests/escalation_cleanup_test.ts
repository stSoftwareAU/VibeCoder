/**
 * Tests for escalation_cleanup.ts (Issue #1487).
 *
 * When the worker escalates an issue by adding `needs-human`, the discovery
 * labels (`work-on` and each `config.issueLabels` entry) must be removed so
 * the issue is no longer surfaced by `fetchIssuesByLabel`. This is the
 * belt-and-braces defence against the label_security stripping that caused
 * the worker to re-pick its own escalated issues.
 */

import { assertEquals } from "@std/assert";
import { stripDiscoveryLabelsOnEscalation } from "../lib/escalation_cleanup.ts";

function wasCalledWith(calls: string[][], pattern: string): boolean {
  return calls.some((call) => call.join(" ").includes(pattern));
}

function createMockGh(labelsResponse: string[]): {
  ghCommandFn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const ghCommandFn = async (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("issue view") && joined.includes("--json labels")) {
      return JSON.stringify({
        labels: labelsResponse.map((name) => ({ name })),
      });
    }
    return "";
  };
  return { ghCommandFn, calls };
}

Deno.test(
  "escalation_cleanup - strips work-on and each issueLabels entry when needs-human is present",
  async () => {
    const { ghCommandFn, calls } = createMockGh([
      "enhancement",
      "work-on",
      "help wanted",
      "needs-human",
    ]);

    await stripDiscoveryLabelsOnEscalation(
      "org/repo",
      42,
      {
        needsHumanLabel: "needs-human",
        workOnLabel: "work-on",
        issueLabels: ["help wanted", "claude"],
      },
      ghCommandFn,
    );

    assertEquals(wasCalledWith(calls, "--remove-label work-on"), true);
    assertEquals(wasCalledWith(calls, "--remove-label help wanted"), true);
    // "claude" wasn't on the issue — should not be requested (optional; the
    // helper may call remove-label with missing labels and rely on gh to
    // silently succeed, so we don't assert false here).
  },
);

Deno.test(
  "escalation_cleanup - does nothing when needs-human is absent",
  async () => {
    const { ghCommandFn, calls } = createMockGh([
      "enhancement",
      "work-on",
    ]);

    await stripDiscoveryLabelsOnEscalation(
      "org/repo",
      42,
      {
        needsHumanLabel: "needs-human",
        workOnLabel: "work-on",
        issueLabels: ["help wanted"],
      },
      ghCommandFn,
    );

    assertEquals(wasCalledWith(calls, "--remove-label"), false);
  },
);

Deno.test(
  "escalation_cleanup - only removes labels actually on the issue",
  async () => {
    // Issue has needs-human + work-on but NOT 'help wanted'. Helper must not
    // issue a remove-label call for labels not present (avoids gh errors and
    // unnecessary API chatter).
    const { ghCommandFn, calls } = createMockGh([
      "needs-human",
      "work-on",
    ]);

    await stripDiscoveryLabelsOnEscalation(
      "org/repo",
      42,
      {
        needsHumanLabel: "needs-human",
        workOnLabel: "work-on",
        issueLabels: ["help wanted", "claude"],
      },
      ghCommandFn,
    );

    assertEquals(wasCalledWith(calls, "--remove-label work-on"), true);
    assertEquals(wasCalledWith(calls, "--remove-label help wanted"), false);
    assertEquals(wasCalledWith(calls, "--remove-label claude"), false);
  },
);

Deno.test(
  "escalation_cleanup - honours custom needsHumanLabel",
  async () => {
    const { ghCommandFn, calls } = createMockGh([
      "escalate-me",
      "work-on",
    ]);

    await stripDiscoveryLabelsOnEscalation(
      "org/repo",
      7,
      {
        needsHumanLabel: "escalate-me",
        workOnLabel: "work-on",
        issueLabels: [],
      },
      ghCommandFn,
    );

    assertEquals(wasCalledWith(calls, "--remove-label work-on"), true);
  },
);

Deno.test(
  "escalation_cleanup - tolerates gh view failure (best-effort)",
  async () => {
    // If the view call fails we do not want to throw — the escalation has
    // already happened, and best-effort cleanup is better than a crash.
    const calls: string[][] = [];
    const ghCommandFn = async (args: string[]): Promise<string> => {
      calls.push(args);
      throw new Error("gh exploded");
    };

    // Should not throw.
    await stripDiscoveryLabelsOnEscalation(
      "org/repo",
      42,
      {
        needsHumanLabel: "needs-human",
        workOnLabel: "work-on",
        issueLabels: ["help wanted"],
      },
      ghCommandFn,
    );

    // View was attempted; no remove-label calls followed.
    assertEquals(wasCalledWith(calls, "issue view"), true);
    assertEquals(wasCalledWith(calls, "--remove-label"), false);
  },
);
