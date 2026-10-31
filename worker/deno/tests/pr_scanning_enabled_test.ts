import { assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import {
  buildPriorityDispatchTable,
  createDefaultRunCoreConfig,
  type RunCoreDeps,
} from "../lib/run_core.ts";
import { emptyEnv } from "./support/env_lookup.ts";

Deno.test("PR repair scanning defaults on and can be disabled for one host", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/config.json`;
  try {
    await Deno.writeTextFile(path, JSON.stringify({ repos: ["owner/repo"] }));
    assertEquals(
      (await loadConfig(path, { env: emptyEnv })).prScanningEnabled,
      true,
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify({ repos: ["owner/repo"], pr_scanning_enabled: false }),
    );
    assertEquals(
      (await loadConfig(path, { env: emptyEnv })).prScanningEnabled,
      false,
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify({ repos: ["owner/repo"], pr_scanning_enabled: "false" }),
    );
    await assertRejects(
      () => loadConfig(path, { env: emptyEnv }),
      Error,
      "pr_scanning_enabled must be a boolean",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("disabling PR repair scans preserves issue processing and auto-merge", () => {
  const deps = {} as RunCoreDeps;
  const defaults = createDefaultRunCoreConfig();
  const enabled = buildPriorityDispatchTable(deps, () => false, defaults).map((
    handler,
  ) => handler.name);
  const disabled = buildPriorityDispatchTable(deps, () => false, {
    ...defaults,
    prScanningEnabled: false,
  }).map((handler) => handler.name);
  for (
    const name of [
      "PR Feedback",
      "Spelling Fix",
      "CI Fix",
      "Update PR Branches",
      "Resolve PR Merge Conflicts",
      "Nudge Stalled CI",
      "Blocking PR Stall Repair",
    ]
  ) {
    assertEquals(enabled.includes(name), true, name);
    assertEquals(disabled.includes(name), false, name);
  }
  for (
    const name of ["Auto-Merge", "Issue Scanning", "Reconcile PR Body Digests"]
  ) assertEquals(disabled.includes(name), true, name);
});
