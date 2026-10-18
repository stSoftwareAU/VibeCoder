/**
 * Read-only credential residue check before reusing legacy worker volumes.
 *
 * This is a known-location guard, not an exhaustive secret scanner. The trusted
 * launcher must additionally supply custom auth paths and reject credential
 * source mount overlaps. Findings block launch; no migration, deletion or
 * credential contents are performed/read here.
 */
export interface LegacyCredentialFinding {
  path: string;
  category: "credential-file" | "symlink" | "unreadable";
}
export async function inspectBrokerLegacyCredentials(options: {
  workDir: string;
  agentStateDir: string;
  extraCredentialPaths?: readonly string[];
  lstat?: (
    path: string,
  ) => Promise<Pick<Deno.FileInfo, "isDirectory" | "isSymlink">>;
}): Promise<LegacyCredentialFinding[]> {
  const work = absolutePath(options.workDir);
  const state = absolutePath(options.agentStateDir);
  const extra = (options.extraCredentialPaths ?? []).map(absolutePath);
  const candidates: Array<{ root: string; path: string }> = [
    ...[
      ".container-state/gh/hosts.yml",
      ".container-scratch/state/gh/hosts.yml",
      ".container-scratch/gh/hosts.yml",
      ".claude-config/.credentials.json",
      ".codex/auth.json",
      ".gemini/oauth_creds.json",
      ".vibe-coder/credentials",
    ].map((path) => ({ root: work, path: `${work}/${path}` })),
    ...[
      "codex/auth.json",
      "claude-config/.credentials.json",
      "gemini/oauth_creds.json",
      ".gemini/oauth_creds.json",
      ".codex/auth.json",
      ".claude/.credentials.json",
    ].map((path) => ({ root: state, path: `${state}/${path}` })),
    // Extra paths are host-resolved and may sit outside these standard roots.
    // Start at their first component so a symlink ancestor cannot hide them.
    ...extra.map((path) => ({ root: `/${path.split("/")[1]}`, path })),
  ];
  const lstat = options.lstat ?? Deno.lstat;
  const findings = new Map<string, LegacyCredentialFinding>();
  const checked = new Map<
    string,
    "directory" | "missing" | LegacyCredentialFinding
  >();
  for (const candidate of candidates) {
    const suffix = candidate.path.slice(candidate.root.length).split("/")
      .filter(Boolean);
    let path = candidate.root;
    for (let i = 0; i <= suffix.length; i++) {
      if (i > 0) path += `/${suffix[i - 1]}`;
      let outcome = checked.get(path);
      if (outcome === undefined) {
        try {
          const info = await lstat(path);
          outcome = info.isSymlink
            ? { path, category: "symlink" }
            : path === candidate.path
            ? { path, category: "credential-file" }
            : info.isDirectory
            ? "directory"
            : { path, category: "unreadable" };
        } catch (error) {
          outcome = error instanceof Deno.errors.NotFound
            ? "missing"
            : { path, category: "unreadable" };
        }
        checked.set(path, outcome);
      }
      if (outcome === "missing") break;
      if (outcome !== "directory") {
        findings.set(outcome.path, outcome);
        break;
      }
      // An extra credential path can also be a previously inspected directory.
      if (path === candidate.path) {
        findings.set(path, { path, category: "credential-file" });
      }
    }
  }
  return [...findings.values()];
}

/** Runtime volume paths are absolute Linux paths; ambiguity blocks inspection. */
function absolutePath(path: string): string {
  if (
    !path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    path.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw new Error(
      "Legacy credential inspection requires an unambiguous absolute path",
    );
  }
  const normalised = path.replace(/\/+/g, "/").replace(/\/$/, "");
  if (!normalised) {
    throw new Error("Legacy credential inspection refuses filesystem root");
  }
  return normalised;
}
