/**
 * supply-chain-gate command (Issue #4192).
 *
 * Fails the build on any decay of the repository's supply-chain posture:
 * an unpinned `uses:`, a `deno` invocation that resolves dependencies
 * without `--frozen`, a container base image referenced by tag, a Renovate
 * policy that would auto-merge beyond pin-class updates, or a dependency
 * inventory that no longer matches the tree.
 *
 * Usage:
 *   deno run --allow-read --allow-env mod.ts supply-chain-gate \
 *     [--repo DIR] [--inventory docs/audits/dependency-inventory.md]
 *   deno run --allow-read --allow-write --allow-env mod.ts supply-chain-gate \
 *     --write-inventory          # regenerate the inventory, then check
 *
 * Exits non-zero on any finding; every finding names the file, line and
 * rule so a CI log is enough to fix it.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Command, CommandResult } from "../types.ts";
import {
  buildDependencyInventory,
  DEFAULT_INVENTORY_PATH,
  formatGateReport,
  type GateReport,
  runSupplyChainGate,
} from "../lib/supply_chain_gate.ts";

/** Read a string argument, falling back to a default. */
function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/** True for `--flag` and `--flag true`. */
function boolArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true || args[key] === "true";
}

/** Write the inventory (creating `docs/audits/` if needed). */
async function writeInventory(repoDir: string, rel: string): Promise<void> {
  const abs = `${repoDir}/${rel}`;
  await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(abs, await buildDependencyInventory(repoDir));
}

export const supplyChainGateCommand: Command = {
  name: "supply-chain-gate",
  description:
    "Fail on unpinned actions, unfrozen deno invocations, tag-referenced " +
    "or short-named container bases, permissive Renovate automerge or a " +
    "stale dependency inventory (Issue #4192)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<GateReport>> {
    const repoDir = stringArg(args, "repo", Deno.cwd()).replace(/\/+$/, "");
    const inventoryPath = stringArg(args, "inventory", DEFAULT_INVENTORY_PATH);
    try {
      if (boolArg(args, "write-inventory")) {
        await writeInventory(repoDir, inventoryPath);
      }
      const report = await runSupplyChainGate({ repoDir, inventoryPath });
      const message = formatGateReport(report) +
        (boolArg(args, "write-inventory")
          ? `\nInventory written to ${inventoryPath}`
          : "");
      return { success: report.ok, message, data: report };
    } catch (error) {
      // Fail loud — a gate that could not run is not a gate that passed.
      return {
        success: false,
        message: `❌ supply-chain-gate could not run: ` +
          `${(error as Error).message}`,
      };
    }
  },
};
