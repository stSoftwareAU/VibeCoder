/**
 * Detects WorkerConfig fields that are defined but never consumed
 * by any library or command code (Issue #1180).
 */

export interface UnusedFieldResult {
  field: string;
  referencedIn: string[];
}

const CONFIG_DEFINITION_FILES = [
  "config.ts",
  "config_defaults.ts",
];

function isExcludedFile(filePath: string): boolean {
  const name = filePath.split("/").pop() ?? "";
  if (name.endsWith("_test.ts")) return true;
  if (name.endsWith(".test.ts")) return true;
  if (filePath.includes("/tests/")) return true;
  if (CONFIG_DEFINITION_FILES.includes(name)) return true;
  if (name === "types.ts") return true;
  return false;
}

/**
 * Extract field names from the WorkerConfig interface in the given source.
 */
export function extractWorkerConfigFields(typesSource: string): string[] {
  const fields: string[] = [];
  const interfaceMatch = typesSource.match(
    /interface\s+WorkerConfig\s*\{([\s\S]*?)^\}/m,
  );
  if (!interfaceMatch?.[1]) return fields;

  const body = interfaceMatch[1];
  for (const line of body.split("\n")) {
    const fieldMatch = line.match(/^\s+(\w+)\s*[?]?\s*:/);
    if (fieldMatch?.[1]) {
      fields.push(fieldMatch[1]);
    }
  }
  return fields;
}

/**
 * Scan source files and return fields that have no references outside
 * config definition files, types.ts, and test files.
 *
 * @param denoRoot - Absolute path to the worker/deno/ directory
 * @returns Array of fields with zero consumer references
 */
export async function detectUnusedConfigFields(
  denoRoot: string,
): Promise<UnusedFieldResult[]> {
  const typesPath = `${denoRoot}/types.ts`;
  const typesSource = await Deno.readTextFile(typesPath);
  const fields = extractWorkerConfigFields(typesSource);

  const sourceFiles: string[] = [];
  for await (const entry of walkTs(denoRoot)) {
    const relative = entry.slice(denoRoot.length + 1);
    if (!isExcludedFile(relative)) {
      sourceFiles.push(entry);
    }
  }

  const results: UnusedFieldResult[] = [];
  for (const field of fields) {
    const refs: string[] = [];
    const pattern = new RegExp(`\\.${field}\\b|\\b${field}\\b`);
    for (const file of sourceFiles) {
      const content = await Deno.readTextFile(file);
      if (pattern.test(content)) {
        refs.push(file.slice(denoRoot.length + 1));
      }
    }
    results.push({ field, referencedIn: refs });
  }

  return results.filter((r) => r.referencedIn.length === 0);
}

async function* walkTs(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkTs(path);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      yield path;
    }
  }
}
