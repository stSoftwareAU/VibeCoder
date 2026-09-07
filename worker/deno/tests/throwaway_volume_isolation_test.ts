/**
 * A caller that isolates its volumes isolates ALL of them (Issue #1407).
 *
 * `buildContainerLaunchPlan` takes an optional `volumes` override so a
 * throwaway container — the containment suite, the security tabletop — runs
 * against per-run volumes instead of the host's live ones. `agentState` was
 * added to that override as OPTIONAL, so a caller that named the other two
 * silently fell back to the production `vibe-agent-state` and mounted the
 * live agent session store into a container built to be attacked. The
 * tabletop runner did exactly that.
 *
 * Making the field required turns the omission into a compile error, which
 * is the stronger half of the fix. This is the other half: a caller can
 * still satisfy the type by naming a production volume explicitly, and that
 * reads as deliberate isolation while being none.
 *
 * The scan is over source rather than behaviour because the defect is a
 * *call site*, and the two real ones sit inside async functions that stage
 * a filesystem before they build a plan — reachable only by running the
 * thing this test exists to keep safe.
 *
 * Australian English spelling throughout (behaviour, isolation).
 */

import { assertEquals } from "@std/assert";
import {
  AGENT_STATE_VOLUME_NAME,
  APPROVAL_STATE_VOLUME_NAME,
  WORK_VOLUME_NAME,
} from "../lib/container_launch.ts";

const LIB_DIR = new URL("../lib/", import.meta.url);

/** The three production volume names, and the constants naming them. */
const PRODUCTION_NAMES = [
  WORK_VOLUME_NAME,
  APPROVAL_STATE_VOLUME_NAME,
  AGENT_STATE_VOLUME_NAME,
];
const PRODUCTION_CONSTANTS = [
  "WORK_VOLUME_NAME",
  "APPROVAL_STATE_VOLUME_NAME",
  "AGENT_STATE_VOLUME_NAME",
];

/**
 * Strip line and block comments so prose about a production volume is not
 * read as a use of one — this test's own explanatory comments would
 * otherwise fail it.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/** The `volumes: { … }` block of a launch-plan call, if the file has one. */
function volumeOverrides(source: string): string[] {
  const blocks: string[] = [];
  const re = /volumes:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    // Walk to the matching brace so a nested template literal cannot end
    // the block early.
    let depth = 0;
    let i = match.index + match[0].length - 1;
    const start = i;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(stripComments(source.slice(start, i + 1)));
  }
  return blocks;
}

Deno.test("throwaway volumes - no override names a production volume", async () => {
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(LIB_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    // The module that DEFINES the production names is where they belong.
    if (entry.name === "container_launch.ts") continue;
    const source = await Deno.readTextFile(new URL(entry.name, LIB_DIR));
    for (const block of volumeOverrides(source)) {
      for (const name of [...PRODUCTION_NAMES, ...PRODUCTION_CONSTANTS]) {
        if (block.includes(name)) {
          offenders.push(`${entry.name}: volumes override names ${name}`);
        }
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "a volumes override exists to keep a throwaway container off the host's " +
      "live volumes; naming a production volume in one isolates nothing:\n  " +
      offenders.join("\n  "),
  );
});

Deno.test("throwaway volumes - every override names all three volumes", async () => {
  const incomplete: string[] = [];
  for await (const entry of Deno.readDir(LIB_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    if (entry.name === "container_launch.ts") continue;
    const source = await Deno.readTextFile(new URL(entry.name, LIB_DIR));
    for (const block of volumeOverrides(source)) {
      const missing = ["work", "approvalState", "agentState"].filter((field) =>
        !new RegExp(`\\b${field}\\s*:`).test(block)
      );
      if (missing.length > 0) {
        incomplete.push(`${entry.name}: missing ${missing.join(", ")}`);
      }
    }
  }
  // The type makes this a compile error too; this states it as an invariant
  // so a future optional field cannot quietly reopen the gap.
  assertEquals(incomplete, [], incomplete.join("\n  "));
});
