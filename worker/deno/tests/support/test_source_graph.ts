/**
 * The `tests/` source graph, for the parallel-safety conformance tests
 * (Issue #940).
 *
 * Both manifests in `lib/parallel_unsafe_test_manifest.ts` are defined by a
 * classifier that follows imports, because #880's did not: it grepped each
 * suite's own text, and `tests/support/repo_prompts.ts` mutates the process
 * at module scope for the thirty-four suites that import it. Reading the
 * whole tree once and handing it over as a map keeps the classifier pure and
 * both conformance tests honest about the same graph the gate is split on.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/** Every `.ts` file under `tests/`, keyed by its path relative to `worker/deno`. */
export async function readTestSourceGraph(
  denoDir: string,
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const walk = async (relative: string): Promise<void> => {
    for await (const entry of Deno.readDir(`${denoDir}${relative}`)) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.name.endsWith(".ts")) {
        sources.set(path, await Deno.readTextFile(`${denoDir}${path}`));
      }
    }
  };
  await walk("tests");
  return sources;
}

/** The suite files in the graph — `tests/*_test.ts`, not the helpers. */
export function suiteFiles(sources: ReadonlyMap<string, string>): string[] {
  return [...sources.keys()].filter((path) =>
    path.endsWith("_test.ts") &&
    !path.slice("tests/".length).includes("/")
  ).sort();
}
