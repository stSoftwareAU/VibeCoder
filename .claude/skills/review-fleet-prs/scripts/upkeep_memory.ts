// Shared upkeep memory: gate and post must not repeat an update at one head.
// The existing per-PR and per-action keys remain compatible (Issue #3663).

import { withFileLock } from "../../../../worker/deno/lib/file_lock.ts";
import { atomicWrite } from "../../../../worker/deno/lib/file_utils.ts";

// Head commit an upkeep action (auto-merge or branch update) last
// failed at, per PR and action, so a failure is not retried every pass.
export const FAILED_FILE = "dependabot-failed.json";

// Head commit a PR's branch update was last requested at, per PR, so
// GitHub is asked once while CI runs on the merge commit (Issue #3225).
export const BRANCH_UPDATE_FILE = "branch-update.json";

export async function readMemory(
  dir: string,
  file: string,
): Promise<Record<string, string>> {
  try {
    return JSON.parse(await Deno.readTextFile(`${dir}/${file}`));
  } catch {
    return {};
  }
}

// Merge only changed entries under the shared cross-process lock. Atomic
// replacement also keeps unlocked readers from seeing a half-written map.
export async function writeMemory(
  dir: string,
  file: string,
  updates: Record<string, string>,
) {
  await Deno.mkdir(dir, { recursive: true });
  await withFileLock(`${dir}/${file}.lock`, async () => {
    const memory = { ...await readMemory(dir, file), ...updates };
    const result = await atomicWrite({
      targetFile: `${dir}/${file}`,
      content: JSON.stringify(memory),
    });
    if (!result.ok) throw result.error;
  });
}
