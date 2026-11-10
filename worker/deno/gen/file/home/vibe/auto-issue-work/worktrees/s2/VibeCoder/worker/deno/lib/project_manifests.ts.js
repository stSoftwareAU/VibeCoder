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
 */ /** Directory levels searched below the repo root for a Deno project. */ export const MERGE_GATE_MAX_DEPTH = 2;
/** Never descended into when looking for the project. */ const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build"
]);
/** Whether a path exists and is a regular file. */ export async function isFile(path) {
  try {
    return (await Deno.stat(path)).isFile;
  } catch  {
    return false;
  }
}
/** The manifest in a directory, or null when it holds none. */ async function manifestsIn(dir) {
  const found = [];
  for (const manifest of [
    "deno.json",
    "deno.jsonc"
  ]){
    const path = `${dir}/${manifest}`;
    if (await isFile(path)) {
      found.push({
        dir,
        manifest: path,
        kind: "deno"
      });
      break;
    }
  }
  // Issue #2138: a Cargo workspace is a project too. Its Cargo members are
  // covered by `--workspace`, but nested Deno projects still need discovery.
  const cargo = `${dir}/Cargo.toml`;
  if (await isFile(cargo)) found.push({
    dir,
    manifest: cargo,
    kind: "cargo"
  });
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
 */ export async function findProjectManifests(repoDir) {
  const found = [];
  let level = [
    {
      dir: repoDir,
      covered: new Set()
    }
  ];
  for(let depth = 0; depth <= MERGE_GATE_MAX_DEPTH && level.length; depth++){
    const next = [];
    for (const { dir, covered } of level.sort((a, b)=>a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)){
      const manifests = await manifestsIn(dir);
      found.push(...manifests.filter((project)=>!covered.has(project.kind)));
      const childCoverage = new Set(covered);
      for (const project of manifests)childCoverage.add(project.kind);
      if (childCoverage.has("cargo") && childCoverage.has("deno")) continue;
      if (depth === MERGE_GATE_MAX_DEPTH) continue;
      try {
        for await (const entry of Deno.readDir(dir)){
          if (!entry.isDirectory) continue;
          if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
          next.push({
            dir: `${dir}/${entry.name}`,
            covered: childCoverage
          });
        }
      } catch  {
      // An unreadable subdirectory simply contributes no candidates; an
      // unreadable *root* is caught by checkMergedTree, which fails.
      }
    }
    level = next;
  }
  return found;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcm9qZWN0X21hbmlmZXN0cy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRyZWUtbWFuaWZlc3QgZGlzY292ZXJ5IGZvciB0aGUgbWlsZXN0b25lIG1lcmdlIGdhdGVzIGFuZCB0aGUgaW4tZmxpZ2h0XG4gKiBob3N0LWRpc2sgcGFyayAoSXNzdWUgIzQ0MTMpLlxuICpcbiAqIHtAbGluayBmaW5kUHJvamVjdE1hbmlmZXN0c30gbGlzdHMgZXZlcnkgRGVubyBhbmQgQ2FyZ28gcHJvamVjdCBpbiBhIHRyZWUsXG4gKiBicmVhZHRoLWZpcnN0IHRvIGEgZml4ZWQgZGVwdGguIEl0IHNpdHMgaW4gaXRzIG93biBtb2R1bGUgcmF0aGVyIHRoYW4gaW5cbiAqIGBtaWxlc3RvbmVfbWVyZ2VfZ2F0ZS50c2AsIHNvIGBoZWF2eV9idWlsZF9nYXRlLnRzYCBjYW4gYXNrIHdoZXRoZXIgYVxuICogY2hlY2tvdXQgaG9sZHMgYSBjYXJnbyBwcm9qZWN0IHdpdGhvdXQgaW1wb3J0aW5nIHRoZSBtZXJnZSBnYXRlLCB3aGljaFxuICogYWxyZWFkeSBpbXBvcnRzIGBoZWF2eV9idWlsZF9nYXRlLnRzYCAoYW4gaW1wb3J0IGN5Y2xlKS5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG4vKiogRGlyZWN0b3J5IGxldmVscyBzZWFyY2hlZCBiZWxvdyB0aGUgcmVwbyByb290IGZvciBhIERlbm8gcHJvamVjdC4gKi9cbmV4cG9ydCBjb25zdCBNRVJHRV9HQVRFX01BWF9ERVBUSCA9IDI7XG5cbi8qKiBOZXZlciBkZXNjZW5kZWQgaW50byB3aGVuIGxvb2tpbmcgZm9yIHRoZSBwcm9qZWN0LiAqL1xuY29uc3QgU0tJUF9ESVJTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiLmdpdFwiLFxuICBcIm5vZGVfbW9kdWxlc1wiLFxuICBcInZlbmRvclwiLFxuICBcInRhcmdldFwiLFxuICBcImRpc3RcIixcbiAgXCJidWlsZFwiLFxuXSk7XG5cbi8qKiBUaGUgYnVpbGQgZWNvc3lzdGVtcyB0aGUgbWlsZXN0b25lIGdhdGVzIGNhbiB2ZXJpZnkgYSB0cmVlIHdpdGguICovXG5leHBvcnQgdHlwZSBQcm9qZWN0S2luZCA9IFwiZGVub1wiIHwgXCJjYXJnb1wiO1xuXG4vKiogQSBEZW5vIHByb2plY3QgZm91bmQgaW4gYSB0cmVlLCBhbmQgdGhlIG1hbmlmZXN0IHRoYXQgZGVjbGFyZXMgaXQuICovXG5leHBvcnQgaW50ZXJmYWNlIFByb2plY3RNYW5pZmVzdCB7XG4gIC8qKiBXaGljaCB0b29sY2hhaW4gb3ducyB0aGUgbWFuaWZlc3QgKElzc3VlICMyMTM4KS4gKi9cbiAga2luZDogUHJvamVjdEtpbmQ7XG4gIC8qKiBEaXJlY3RvcnkgaG9sZGluZyB0aGUgbWFuaWZlc3QuICovXG4gIGRpcjogc3RyaW5nO1xuICAvKiogUGF0aCB0byBgZGVuby5qc29uYCBvciBgZGVuby5qc29uY2AgaW4gdGhhdCBkaXJlY3RvcnkuICovXG4gIG1hbmlmZXN0OiBzdHJpbmc7XG59XG5cbi8qKiBXaGV0aGVyIGEgcGF0aCBleGlzdHMgYW5kIGlzIGEgcmVndWxhciBmaWxlLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGlzRmlsZShwYXRoOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gKGF3YWl0IERlbm8uc3RhdChwYXRoKSkuaXNGaWxlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBtYW5pZmVzdCBpbiBhIGRpcmVjdG9yeSwgb3IgbnVsbCB3aGVuIGl0IGhvbGRzIG5vbmUuICovXG5hc3luYyBmdW5jdGlvbiBtYW5pZmVzdHNJbihkaXI6IHN0cmluZyk6IFByb21pc2U8UHJvamVjdE1hbmlmZXN0W10+IHtcbiAgY29uc3QgZm91bmQ6IFByb2plY3RNYW5pZmVzdFtdID0gW107XG4gIGZvciAoY29uc3QgbWFuaWZlc3Qgb2YgW1wiZGVuby5qc29uXCIsIFwiZGVuby5qc29uY1wiXSkge1xuICAgIGNvbnN0IHBhdGggPSBgJHtkaXJ9LyR7bWFuaWZlc3R9YDtcbiAgICBpZiAoYXdhaXQgaXNGaWxlKHBhdGgpKSB7XG4gICAgICBmb3VuZC5wdXNoKHsgZGlyLCBtYW5pZmVzdDogcGF0aCwga2luZDogXCJkZW5vXCIgfSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cbiAgLy8gSXNzdWUgIzIxMzg6IGEgQ2FyZ28gd29ya3NwYWNlIGlzIGEgcHJvamVjdCB0b28uIEl0cyBDYXJnbyBtZW1iZXJzIGFyZVxuICAvLyBjb3ZlcmVkIGJ5IGAtLXdvcmtzcGFjZWAsIGJ1dCBuZXN0ZWQgRGVubyBwcm9qZWN0cyBzdGlsbCBuZWVkIGRpc2NvdmVyeS5cbiAgY29uc3QgY2FyZ28gPSBgJHtkaXJ9L0NhcmdvLnRvbWxgO1xuICBpZiAoYXdhaXQgaXNGaWxlKGNhcmdvKSkgZm91bmQucHVzaCh7IGRpciwgbWFuaWZlc3Q6IGNhcmdvLCBraW5kOiBcImNhcmdvXCIgfSk7XG4gIHJldHVybiBmb3VuZDtcbn1cblxuLyoqXG4gKiBMb2NhdGUgZXZlcnkgRGVubyBwcm9qZWN0IGluIHRoZSB0cmVlLCBicmVhZHRoLWZpcnN0IGZyb20gdGhlIHJlcG8gcm9vdC5cbiAqXG4gKiAqKkFsbCoqIG9mIHRoZW0sIG5vdCB0aGUgZmlyc3Qgb25lIGZvdW5kOiB0aGlzIHJlcG9zaXRvcnkgY2Fycmllc1xuICogYGNvbnRhaW5lci9kZW5vLXNlZWQvZGVuby5qc29uYCBhbG9uZ3NpZGUgYHdvcmtlci9kZW5vL2Rlbm8uanNvbmAsIGFuZCBhXG4gKiBzZWFyY2ggdGhhdCBzdG9wcGVkIGF0IHdoaWNoZXZlciBgRGVuby5yZWFkRGlyYCBoYXBwZW5lZCB0byByZXR1cm4gZmlyc3RcbiAqIHdvdWxkIHR5cGUtY2hlY2sgYSBzaW5nbGUtZmlsZSBzZWVkIHByb2plY3QgYW5kIGNhbGwgYSBicm9rZW5cbiAqIGB3b3JrZXIvZGVub2AgY2xlYW4g4oCUIGEgZ2F0ZSB0aGF0IHBhc3NlcyBldmVyeXRoaW5nLCB3aGljaCBpcyB0aGUgc3RhdGVcbiAqIElzc3VlICM5NzQgZXhpc3RzIHRvIGVuZC5cbiAqXG4gKiBBIG1hbmlmZXN0IGNvdmVycyBuZXN0ZWQgcHJvamVjdHMgb2YgaXRzIG93biB0b29sY2hhaW4gb25seS4gS2VlcCBsb29raW5nXG4gKiBmb3IgdGhlIG90aGVyIHRvb2xjaGFpbjogQ2FyZ28gY2Fubm90IHZlcmlmeSBhIG5lc3RlZCBEZW5vIHByb2plY3QsIG5vclxuICogRGVubyBhIG5lc3RlZCBDYXJnbyB3b3Jrc3BhY2UuIEVhY2ggbGV2ZWwgaXMgc29ydGVkLCBzbyB0aGUgc2FtZSB0cmVlXG4gKiB5aWVsZHMgdGhlIHNhbWUgb3JkZXIgb24gZXZlcnkgaG9zdC5cbiAqXG4gKiBTaGFyZWQgYnkgdGhlIHR5cGUtY2hlY2sgZ2F0ZSAoSXNzdWUgIzk3NCkgYW5kIHRoZSBjb25mbGljdC1yZXNvbHV0aW9uIGdhdGVcbiAqIChJc3N1ZSAjMTU1OSkgc28gYm90aCBqdWRnZSB0aGUgc2FtZSBzZXQgb2YgcHJvamVjdHMuXG4gKlxuICogQHBhcmFtIHJlcG9EaXIgLSBSb290IG9mIHRoZSBtZXJnZWQgd29ya2luZyB0cmVlXG4gKiBAcmV0dXJucyBFdmVyeSBwcm9qZWN0IGZvdW5kOyBlbXB0eSB3aGVuIHRoZSB0cmVlIGRlZmluZXMgbm9uZVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmluZFByb2plY3RNYW5pZmVzdHMoXG4gIHJlcG9EaXI6IHN0cmluZyxcbik6IFByb21pc2U8UHJvamVjdE1hbmlmZXN0W10+IHtcbiAgY29uc3QgZm91bmQ6IFByb2plY3RNYW5pZmVzdFtdID0gW107XG4gIGxldCBsZXZlbDogeyBkaXI6IHN0cmluZzsgY292ZXJlZDogUmVhZG9ubHlTZXQ8UHJvamVjdEtpbmQ+IH1bXSA9IFtcbiAgICB7IGRpcjogcmVwb0RpciwgY292ZXJlZDogbmV3IFNldCgpIH0sXG4gIF07XG4gIGZvciAobGV0IGRlcHRoID0gMDsgZGVwdGggPD0gTUVSR0VfR0FURV9NQVhfREVQVEggJiYgbGV2ZWwubGVuZ3RoOyBkZXB0aCsrKSB7XG4gICAgY29uc3QgbmV4dDogdHlwZW9mIGxldmVsID0gW107XG4gICAgZm9yIChcbiAgICAgIGNvbnN0IHsgZGlyLCBjb3ZlcmVkIH0gb2YgbGV2ZWwuc29ydCgoYSwgYikgPT5cbiAgICAgICAgYS5kaXIgPCBiLmRpciA/IC0xIDogYS5kaXIgPiBiLmRpciA/IDEgOiAwXG4gICAgICApXG4gICAgKSB7XG4gICAgICBjb25zdCBtYW5pZmVzdHMgPSBhd2FpdCBtYW5pZmVzdHNJbihkaXIpO1xuICAgICAgZm91bmQucHVzaCguLi5tYW5pZmVzdHMuZmlsdGVyKChwcm9qZWN0KSA9PiAhY292ZXJlZC5oYXMocHJvamVjdC5raW5kKSkpO1xuICAgICAgY29uc3QgY2hpbGRDb3ZlcmFnZSA9IG5ldyBTZXQoY292ZXJlZCk7XG4gICAgICBmb3IgKGNvbnN0IHByb2plY3Qgb2YgbWFuaWZlc3RzKSBjaGlsZENvdmVyYWdlLmFkZChwcm9qZWN0LmtpbmQpO1xuICAgICAgaWYgKGNoaWxkQ292ZXJhZ2UuaGFzKFwiY2FyZ29cIikgJiYgY2hpbGRDb3ZlcmFnZS5oYXMoXCJkZW5vXCIpKSBjb250aW51ZTtcbiAgICAgIGlmIChkZXB0aCA9PT0gTUVSR0VfR0FURV9NQVhfREVQVEgpIGNvbnRpbnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZm9yIGF3YWl0IChjb25zdCBlbnRyeSBvZiBEZW5vLnJlYWREaXIoZGlyKSkge1xuICAgICAgICAgIGlmICghZW50cnkuaXNEaXJlY3RvcnkpIGNvbnRpbnVlO1xuICAgICAgICAgIGlmIChlbnRyeS5uYW1lLnN0YXJ0c1dpdGgoXCIuXCIpIHx8IFNLSVBfRElSUy5oYXMoZW50cnkubmFtZSkpIGNvbnRpbnVlO1xuICAgICAgICAgIG5leHQucHVzaCh7IGRpcjogYCR7ZGlyfS8ke2VudHJ5Lm5hbWV9YCwgY292ZXJlZDogY2hpbGRDb3ZlcmFnZSB9KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIEFuIHVucmVhZGFibGUgc3ViZGlyZWN0b3J5IHNpbXBseSBjb250cmlidXRlcyBubyBjYW5kaWRhdGVzOyBhblxuICAgICAgICAvLyB1bnJlYWRhYmxlICpyb290KiBpcyBjYXVnaHQgYnkgY2hlY2tNZXJnZWRUcmVlLCB3aGljaCBmYWlscy5cbiAgICAgIH1cbiAgICB9XG4gICAgbGV2ZWwgPSBuZXh0O1xuICB9XG4gIHJldHVybiBmb3VuZDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Q0FXQyxHQUVELHNFQUFzRSxHQUN0RSxPQUFPLE1BQU0sdUJBQXVCLEVBQUU7QUFFdEMsdURBQXVELEdBQ3ZELE1BQU0sWUFBaUMsSUFBSSxJQUFJO0VBQzdDO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtDQUNEO0FBZUQsaURBQWlELEdBQ2pELE9BQU8sZUFBZSxPQUFPLElBQVk7RUFDdkMsSUFBSTtJQUNGLE9BQU8sQ0FBQyxNQUFNLEtBQUssSUFBSSxDQUFDLEtBQUssRUFBRSxNQUFNO0VBQ3ZDLEVBQUUsT0FBTTtJQUNOLE9BQU87RUFDVDtBQUNGO0FBRUEsNkRBQTZELEdBQzdELGVBQWUsWUFBWSxHQUFXO0VBQ3BDLE1BQU0sUUFBMkIsRUFBRTtFQUNuQyxLQUFLLE1BQU0sWUFBWTtJQUFDO0lBQWE7R0FBYSxDQUFFO0lBQ2xELE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxFQUFFLFVBQVU7SUFDakMsSUFBSSxNQUFNLE9BQU8sT0FBTztNQUN0QixNQUFNLElBQUksQ0FBQztRQUFFO1FBQUssVUFBVTtRQUFNLE1BQU07TUFBTztNQUMvQztJQUNGO0VBQ0Y7RUFDQSx5RUFBeUU7RUFDekUsMkVBQTJFO0VBQzNFLE1BQU0sUUFBUSxHQUFHLElBQUksV0FBVyxDQUFDO0VBQ2pDLElBQUksTUFBTSxPQUFPLFFBQVEsTUFBTSxJQUFJLENBQUM7SUFBRTtJQUFLLFVBQVU7SUFBTyxNQUFNO0VBQVE7RUFDMUUsT0FBTztBQUNUO0FBRUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBQ0QsT0FBTyxlQUFlLHFCQUNwQixPQUFlO0VBRWYsTUFBTSxRQUEyQixFQUFFO0VBQ25DLElBQUksUUFBOEQ7SUFDaEU7TUFBRSxLQUFLO01BQVMsU0FBUyxJQUFJO0lBQU07R0FDcEM7RUFDRCxJQUFLLElBQUksUUFBUSxHQUFHLFNBQVMsd0JBQXdCLE1BQU0sTUFBTSxFQUFFLFFBQVM7SUFDMUUsTUFBTSxPQUFxQixFQUFFO0lBQzdCLEtBQ0UsTUFBTSxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsSUFBSSxNQUFNLElBQUksQ0FBQyxDQUFDLEdBQUcsSUFDdkMsRUFBRSxHQUFHLEdBQUcsRUFBRSxHQUFHLEdBQUcsQ0FBQyxJQUFJLEVBQUUsR0FBRyxHQUFHLEVBQUUsR0FBRyxHQUFHLElBQUksR0FFM0M7TUFDQSxNQUFNLFlBQVksTUFBTSxZQUFZO01BQ3BDLE1BQU0sSUFBSSxJQUFJLFVBQVUsTUFBTSxDQUFDLENBQUMsVUFBWSxDQUFDLFFBQVEsR0FBRyxDQUFDLFFBQVEsSUFBSTtNQUNyRSxNQUFNLGdCQUFnQixJQUFJLElBQUk7TUFDOUIsS0FBSyxNQUFNLFdBQVcsVUFBVyxjQUFjLEdBQUcsQ0FBQyxRQUFRLElBQUk7TUFDL0QsSUFBSSxjQUFjLEdBQUcsQ0FBQyxZQUFZLGNBQWMsR0FBRyxDQUFDLFNBQVM7TUFDN0QsSUFBSSxVQUFVLHNCQUFzQjtNQUNwQyxJQUFJO1FBQ0YsV0FBVyxNQUFNLFNBQVMsS0FBSyxPQUFPLENBQUMsS0FBTTtVQUMzQyxJQUFJLENBQUMsTUFBTSxXQUFXLEVBQUU7VUFDeEIsSUFBSSxNQUFNLElBQUksQ0FBQyxVQUFVLENBQUMsUUFBUSxVQUFVLEdBQUcsQ0FBQyxNQUFNLElBQUksR0FBRztVQUM3RCxLQUFLLElBQUksQ0FBQztZQUFFLEtBQUssR0FBRyxJQUFJLENBQUMsRUFBRSxNQUFNLElBQUksRUFBRTtZQUFFLFNBQVM7VUFBYztRQUNsRTtNQUNGLEVBQUUsT0FBTTtNQUNOLGtFQUFrRTtNQUNsRSwrREFBK0Q7TUFDakU7SUFDRjtJQUNBLFFBQVE7RUFDVjtFQUNBLE9BQU87QUFDVCJ9
// denoCacheMetadata=12705916777420533651,3500142393769796754