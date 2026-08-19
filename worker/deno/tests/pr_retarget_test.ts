/**
 * Tests for pr_retarget.ts — PR retargeting (Issue #915).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import { retargetPrToMilestone } from "../lib/pr_retarget.ts";

// --- retargetPrToMilestone ---

Deno.test("pr_retarget - retargetPrToMilestone no-ops when no milestone branch", async () => {
  const fn = async (_args: string[]): Promise<string> => "";
  const result = await retargetPrToMilestone("owner/repo", 42, "", fn);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.includes("no-op"), true);
});

Deno.test("pr_retarget - retargetPrToMilestone skips when already targeting milestone", async () => {
  const fn = async (args: string[]): Promise<string> => {
    if (args.includes("--jq") && args.some((a) => a.includes("baseRefName"))) {
      return "milestone/oidc\n";
    }
    return "";
  };
  const result = await retargetPrToMilestone(
    "owner/repo",
    42,
    "milestone/oidc",
    fn,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.includes("already targets"), true);
});

Deno.test("pr_retarget - retargetPrToMilestone retargets successfully", async () => {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("--jq") && args.some((a) => a.includes("baseRefName"))) {
      return "main\n";
    }
    return "";
  };
  const result = await retargetPrToMilestone(
    "owner/repo",
    42,
    "milestone/oidc",
    fn,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.includes("retargeted"), true);
  // Should have called pr edit --base
  const editCall = calls.find((c) => c[0] === "pr" && c[1] === "edit");
  assertEquals(editCall !== undefined, true);
  assertEquals(editCall!.includes("--base"), true);
  assertEquals(editCall!.includes("milestone/oidc"), true);
});

Deno.test("pr_retarget - retargetPrToMilestone returns error on failure", async () => {
  const fn = async (args: string[]): Promise<string> => {
    if (args.includes("--jq") && args.some((a) => a.includes("baseRefName"))) {
      return "main\n";
    }
    if (args[0] === "pr" && args[1] === "edit") {
      throw new Error("Permission denied");
    }
    return "";
  };
  const result = await retargetPrToMilestone(
    "owner/repo",
    42,
    "milestone/oidc",
    fn,
  );
  assertEquals(result.ok, false);
});
