/**
 * Tree-manifest discovery for the milestone merge gates and the in-flight
 * host-disk park (Issue #4413).
 *
 * {@link findProjectManifests} lists every Deno and Cargo project in a tree,
 * breadth-first to a fixed depth. It sits in its own module rather than in
 * `milestone_merge_gate.ts`, so `heavy_build_gate.ts` can ask whether a
 * checkout holds a cargo project without importing the merge gate, which
 * already imports `heavy_build_gate.ts` (an import cycle).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Directory levels searched below the repo root for a Deno project. */
export const MERGE_GATE_MAX_DEPTH = 2;

/** Never descended into when looking for the project. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
]);

/** The build ecosystems the milestone gates can verify a tree with. */
export type ProjectKind = "deno" | "cargo";

/** A Deno project found in a tree, and the manifest that declares it. */
export interface ProjectManifest {
  /** Which toolchain owns the manifest (Issue #2138). */
  kind: ProjectKind;
  /** Directory holding the manifest. */
  dir: string;
  /** Path to `deno.json` or `deno.jsonc` in that directory. */
  manifest: string;
}

/** Whether a path exists and is a regular file. */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** The manifest in a directory, or null when it holds none. */
async function manifestsIn(dir: string): Promise<ProjectManifest[]> {
  const found: ProjectManifest[] = [];
  for (const manifest of ["deno.json", "deno.jsonc"]) {
    const path = `${dir}/${manifest}`;
    if (await isFile(path)) {
      found.push({ dir, manifest: path, kind: "deno" });
      break;
    }
  }
  // Issue #2138: a Cargo workspace is a project too. Its Cargo members are
  // covered by `--workspace`, but nested Deno projects still need discovery.
  const cargo = `${dir}/Cargo.toml`;
  if (await isFile(cargo)) found.push({ dir, manifest: cargo, kind: "cargo" });
  return found;
}

/**
 * Locate every Deno project in the tree, breadth-first from the repo root.
 *
 * **All** of them, not the first one found: this repository carries
 * `container/deno-seed/deno.json` alongside `worker/deno/deno.json`, and a
 * search that stopped at whichever `Deno.readDir` happened to return first
 * would type-check a single-file seed project and call a broken
 * `worker/deno` clean — a gate that passes everything, which is the state
 * Issue #974 exists to end.
 *
 * A manifest covers nested projects of its own toolchain only. Keep looking
 * for the other toolchain: Cargo cannot verify a nested Deno project, nor
 * Deno a nested Cargo workspace. Each level is sorted, so the same tree
 * yields the same order on every host.
 *
 * Shared by the type-check gate (Issue #974) and the conflict-resolution gate
 * (Issue #1559) so both judge the same set of projects.
 *
 * @param repoDir - Root of the merged working tree
 * @returns Every project found; empty when the tree defines none
 */
export async function findProjectManifests(
  repoDir: string,
): Promise<ProjectManifest[]> {
  const found: ProjectManifest[] = [];
  let level: { dir: string; covered: ReadonlySet<ProjectKind> }[] = [
    { dir: repoDir, covered: new Set() },
  ];
  for (let depth = 0; depth <= MERGE_GATE_MAX_DEPTH && level.length; depth++) {
    const next: typeof level = [];
    for (
      const { dir, covered } of level.sort((a, b) =>
        a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0
      )
    ) {
      const manifests = await manifestsIn(dir);
      found.push(...manifests.filter((project) => !covered.has(project.kind)));
      const childCoverage = new Set(covered);
      for (const project of manifests) childCoverage.add(project.kind);
      if (childCoverage.has("cargo") && childCoverage.has("deno")) continue;
      if (depth === MERGE_GATE_MAX_DEPTH) continue;
      try {
        for await (const entry of Deno.readDir(dir)) {
          if (!entry.isDirectory) continue;
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          next.push({ dir: `${dir}/${entry.name}`, covered: childCoverage });
        }
      } catch {
        // An unreadable subdirectory simply contributes no candidates; an
        // unreadable *root* is caught by checkMergedTree, which fails.
      }
    }
    level = next;
  }
  return found;
}
