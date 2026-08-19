/**
 * Tests that worker/deno/deno.lock carries no undeclared dependency
 * (Issue #3661, SEC-00ee6bafe54c).
 *
 * `jsr:@std/path@1` sat in the lockfile with an integrity hash while nothing
 * imported it: `deno.json` declares only `@std/assert` and `@std/yaml`, and
 * neither has a dependency edge to it. `git log -S` traced it to a shell-script
 * fix whose diff added the lock entry with no matching `deno.json` change — the
 * "lockfile grew without a direct-dep change" shape. Not exploitable (first-
 * party Deno std, integrity-hashed), but `deno audit` and the Trivy SBOM both
 * report it as a shipped component, so it is real attack surface on paper.
 *
 * This test makes the invariant enforceable: every top-level lock entry must be
 * reachable from a declared import.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";

interface DenoLock {
  specifiers: Record<string, string>;
  jsr: Record<string, { dependencies?: string[] }>;
  workspace: { dependencies: string[] };
}

/** Repository root (three levels up from worker/deno/tests/). */
function repoRoot(): string {
  return new URL(".", import.meta.url).pathname.replace(
    /worker\/deno\/tests\/$/,
    "",
  );
}

/** Bare package name from a specifier such as `jsr:@std/path@1`. */
function packageName(specifier: string): string {
  const withoutScheme = specifier.replace(/^jsr:/, "").replace(/^npm:/, "");
  const at = withoutScheme.lastIndexOf("@");
  return at > 0 ? withoutScheme.slice(0, at) : withoutScheme;
}

async function readLock(): Promise<DenoLock> {
  return JSON.parse(
    await Deno.readTextFile(`${repoRoot()}worker/deno/deno.lock`),
  ) as DenoLock;
}

Deno.test("deno.lock - every package is reachable from a declared dependency", async () => {
  const lock = await readLock();

  // Walk from the workspace's declared deps through each entry's own edges.
  const reachable = new Set<string>();
  const queue = lock.workspace.dependencies.map(packageName);
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const [entry, meta] of Object.entries(lock.jsr)) {
      if (packageName(entry) !== name) continue;
      for (const dep of meta.dependencies ?? []) queue.push(packageName(dep));
    }
  }

  const orphans = Object.keys(lock.jsr)
    .map(packageName)
    .filter((name) => !reachable.has(name));

  assertEquals(
    orphans,
    [],
    `deno.lock pins package(s) nothing declares: ${orphans.join(", ")}. ` +
      `Remove them, or add the matching import to deno.json (Issue #3661).`,
  );
});

Deno.test("deno.lock - no wildcard specifier shadows a real version range", async () => {
  const lock = await readLock();

  const wildcards = Object.keys(lock.specifiers).filter((s) =>
    s.endsWith("@*")
  );
  assertEquals(
    wildcards,
    [],
    `deno.lock carries wildcard specifier(s): ${wildcards.join(", ")}. ` +
      `A '@*' entry pins nothing and hides the real range beside it.`,
  );
});

Deno.test("deno.lock - @std/path is not pinned (nothing imports it)", async () => {
  const lock = await readLock();
  assert(
    !Object.keys(lock.jsr).some((entry) => entry.startsWith("@std/path@")),
    "@std/path was removed in Issue #3661 — re-add it to deno.json's imports " +
      "before it may reappear in the lockfile",
  );
});
