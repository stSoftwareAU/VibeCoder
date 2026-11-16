/**
 * GitHub Actions workflow lockfile (`.github/workflows/actions.lock`) —
 * reader, validator and coverage rules (Issue #5051).
 *
 * The schema is defined upstream and this module follows it:
 *   - https://github.com/github/gh-actions-lock — the `gh actions-lock`
 *     CLI that writes the file (its README lists the limitations, including
 *     that reusable workflows called at `jobs.<id>.uses` are not locked);
 *   - https://github.com/github/actions-lockfile — the official parser
 *     (`go/pkg/lockfile`), which accepts schema v0.0.1 to v0.0.3.
 *
 * Only v0.0.2 and v0.0.3 are supported here. v0.0.1 uses a legacy key shape
 * and is reported as unsupported, as is any version this module does not
 * know, so a lockfile this worker cannot verify never counts as coverage.
 *
 * Pure except {@link readActionsLockfile}, which takes an injectable reader
 * so the tests run without a filesystem.
 *
 * Australian English throughout (behaviour, normalised, recognised).
 */

import { parse as parseYaml } from "@std/yaml/parse";
import type { WorkflowFileKind } from "./workflow_scan_common.ts";

/** Repo-relative path of the workflow lockfile. */
export const ACTIONS_LOCKFILE_PATH = ".github/workflows/actions.lock";

/** Lockfile schema versions this module can verify. */
export const SUPPORTED_ACTIONS_LOCKFILE_VERSIONS = [
  "v0.0.2",
  "v0.0.3",
] as const;

/** A lockfile that parsed and passed every schema rule. */
export interface ValidActionsLockfile {
  kind: "valid";
  /** The schema version the file declares. */
  version: string;
  /**
   * Workflow path → the `owner/repo@ref` pins it lists. Pins are
   * normalised: owner and repo lower-cased, ref exactly as written.
   */
  workflows: ReadonlyMap<string, ReadonlySet<string>>;
  /** Normalised `owner/repo@ref` pins that have a dependency record. */
  dependencies: ReadonlySet<string>;
}

/** What the lockfile says, once it has been read and checked. */
export type ActionsLockfileEvidence =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | ValidActionsLockfile;

/**
 * The outcome of reading the lockfile from a checkout. `unreadable` is an
 * unknown result (retryable), not proof that the lockfile is missing.
 */
export type ActionsLockfileRead =
  | ActionsLockfileEvidence
  | { kind: "unreadable"; reason: string };

/** How a `uses:` call-site is covered by the lockfile. */
export type LockCoverage = "sha-fallback" | "locked" | "stale";

/** A workflow key must be a direct child of `.github/workflows/`. */
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** `owner/repo@ref` — exactly one `/` before the `@`. */
const PIN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([^\s@]+)$/;

/** A `commit` digest: `sha1-<40 hex>` or `sha256-<64 hex>`. */
const DIGEST = /^(?:sha1-[0-9a-f]{40}|sha256-[0-9a-f]{64})$/;

/** A pin ref that is a full commit SHA (sha1 or sha256 length). */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The path segment that marks a reusable-workflow coordinate. */
const REUSABLE_WORKFLOW_SEGMENT = "/.github/workflows/";

const TOP_LEVEL_KEYS: readonly string[] = [
  "version",
  "workflows",
  "dependencies",
];
const DEPENDENCY_KEYS_V0_0_2: readonly string[] = [
  "ref",
  "commit",
  "owner_id",
  "repo_id",
  "uses",
];
const DEPENDENCY_KEYS_V0_0_3: readonly string[] = [
  ...DEPENDENCY_KEYS_V0_0_2,
  "hostname",
];
const REQUIRED_DEPENDENCY_KEYS: readonly string[] = [
  "ref",
  "commit",
  "owner_id",
  "repo_id",
];

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function invalid(reason: string): ActionsLockfileEvidence {
  return { kind: "invalid", reason };
}

/**
 * Split an `owner/repo@ref` pin. Returns `null` when the text is not a
 * repo-scoped pin (so a sub-action path, a missing ref or an empty part is
 * rejected).
 */
function parsePin(
  text: string,
): { owner: string; repo: string; ref: string } | null {
  const m = text.match(PIN);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, ref: m[3]! };
}

/** Normalise a valid pin: lower-case owner/repo, ref as written. */
function normalisePin(
  pin: { owner: string; repo: string; ref: string },
): string {
  return `${pin.owner.toLowerCase()}/${pin.repo.toLowerCase()}@${pin.ref}`;
}

/**
 * Check one dependency record. Returns the reason it is invalid, or `null`
 * when it passes. The `uses` cross-check is left to the caller, which needs
 * every dependency first.
 */
function dependencyFault(
  key: string,
  record: unknown,
  version: string,
): string | null {
  if (!isMapping(record)) {
    return `dependency \`${key}\` is not a mapping`;
  }
  const allowed = version === "v0.0.2"
    ? DEPENDENCY_KEYS_V0_0_2
    : DEPENDENCY_KEYS_V0_0_3;
  for (const field of Object.keys(record)) {
    if (field === "hostname" && version === "v0.0.2") {
      return `dependency \`${key}\` has \`hostname\`, which schema v0.0.2 does not allow`;
    }
    if (!allowed.includes(field)) {
      return `dependency \`${key}\` has unknown field \`${field}\``;
    }
  }
  for (const field of REQUIRED_DEPENDENCY_KEYS) {
    if (record[field] === undefined) {
      return `dependency \`${key}\` is missing required field \`${field}\``;
    }
  }

  if (record.hostname !== undefined) {
    if (typeof record.hostname !== "string" || record.hostname === "") {
      return `dependency \`${key}\` has an empty or non-string \`hostname\``;
    }
  }

  if (
    typeof record.hostname === "string" &&
    !/^(github\.com|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$/.test(
      record.hostname,
    )
  ) {
    return `dependency \`${key}\` has a noncanonical hostname`;
  }

  const ref = record.ref;
  if (typeof ref !== "string" || ref === "") {
    return `dependency \`${key}\` has an empty or non-string \`ref\``;
  }

  const commit = record.commit;
  if (typeof commit !== "string" || commit === "") {
    return `dependency \`${key}\` has an empty or non-string \`commit\``;
  }
  if (!DIGEST.test(commit)) {
    return `dependency \`${key}\` has a \`commit\` that is not a sha1-<40 hex> or sha256-<64 hex> digest`;
  }

  for (const field of ["owner_id", "repo_id"] as const) {
    const id = record[field];
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      return `dependency \`${key}\` has a \`${field}\` that is not a positive integer`;
    }
  }

  const keyPin = parsePin(key);
  if (keyPin !== null && !FULL_SHA.test(keyPin.ref) && keyPin.ref !== ref) {
    return `dependency \`${key}\` body ref does not match its key ref`;
  }
  if (keyPin !== null && FULL_SHA.test(keyPin.ref)) {
    const digestHex = commit.slice(commit.indexOf("-") + 1);
    if (digestHex !== keyPin.ref) {
      return `dependency \`${key}\` is keyed by a full SHA, but its \`commit\` digest does not match it`;
    }
  }
  return null;
}

/**
 * Parse and validate lockfile text against the upstream schema rules.
 *
 * Never throws. A file that breaks any rule returns `invalid` with a reason
 * naming the rule and the offending key. A missing `workflows` or
 * `dependencies` key is an empty section. A workflow-listed pin with no
 * dependency record is **not** an invalid file: coverage treats it as stale.
 */
export function parseActionsLockfile(text: string): ActionsLockfileEvidence {
  let root: unknown;
  try {
    root = parseYaml(text);
  } catch (err) {
    return invalid(`YAML parse error: ${messageOf(err)}`);
  }
  if (!isMapping(root)) {
    return invalid("the root is not a mapping");
  }
  for (const key of Object.keys(root)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      return invalid(`unknown top-level key \`${key}\``);
    }
  }

  const version = root.version;
  if (typeof version !== "string") {
    return invalid("`version` is missing or not a string");
  }
  if (
    !(SUPPORTED_ACTIONS_LOCKFILE_VERSIONS as readonly string[]).includes(
      version,
    )
  ) {
    return invalid(
      `unsupported lockfile version \`${version}\` (supported: ${
        SUPPORTED_ACTIONS_LOCKFILE_VERSIONS.join(", ")
      })`,
    );
  }

  const workflows = new Map<string, ReadonlySet<string>>();
  if (root.workflows !== undefined) {
    if (!isMapping(root.workflows)) {
      return invalid("`workflows` is not a mapping");
    }
    for (const [path, pins] of Object.entries(root.workflows)) {
      if (!WORKFLOW_PATH.test(path)) {
        return invalid(
          `workflow key \`${path}\` is not a \`.github/workflows/<name>.yml\` or \`.yaml\` file`,
        );
      }
      if (!Array.isArray(pins)) {
        return invalid(`workflow \`${path}\` is not a list of pins`);
      }
      const listed = new Set<string>();
      for (const pin of pins) {
        const parsed = typeof pin === "string" ? parsePin(pin) : null;
        if (parsed === null) {
          return invalid(
            `workflow \`${path}\` lists an invalid pin ${
              JSON.stringify(pin)
            } (expected owner/repo@ref)`,
          );
        }
        listed.add(normalisePin(parsed));
      }
      workflows.set(path, listed);
    }
  }

  const dependencies = new Set<string>();
  const pendingUses: Array<{ key: string; pins: string[] }> = [];
  if (root.dependencies !== undefined) {
    if (!isMapping(root.dependencies)) {
      return invalid("`dependencies` is not a mapping");
    }
    for (const [key, record] of Object.entries(root.dependencies)) {
      const keyPin = parsePin(key);
      if (keyPin === null) {
        return invalid(
          `dependency key \`${key}\` is not an owner/repo@ref pin`,
        );
      }
      const fault = dependencyFault(key, record, version);
      if (fault !== null) return invalid(fault);
      dependencies.add(normalisePin(keyPin));

      const uses = (record as Mapping).uses;
      if (uses !== undefined) {
        if (!Array.isArray(uses)) {
          return invalid(
            `dependency \`${key}\` has a \`uses\` that is not a list`,
          );
        }
        const pins: string[] = [];
        for (const pin of uses) {
          const parsed = typeof pin === "string" ? parsePin(pin) : null;
          if (parsed === null) {
            return invalid(
              `dependency \`${key}\` has an invalid \`uses\` pin ${
                JSON.stringify(pin)
              }`,
            );
          }
          pins.push(normalisePin(parsed));
        }
        pendingUses.push({ key, pins });
      }
    }
  }

  for (const { key, pins } of pendingUses) {
    for (const pin of pins) {
      if (!dependencies.has(pin)) {
        return invalid(
          `dependency \`${key}\` has \`uses\` naming \`${pin}\`, which has no dependency record`,
        );
      }
    }
  }

  // Topological traversal avoids recursion on an untrusted dependency graph.
  const incoming = new Map([...dependencies].map((key) => [key, 0]));
  const edges = new Map(
    pendingUses.map(({ key, pins }) => [normalisePin(parsePin(key)!), pins]),
  );
  for (const pins of edges.values()) {
    for (const pin of pins) incoming.set(pin, incoming.get(pin)! + 1);
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([key]) =>
    key
  );
  for (let i = 0; i < ready.length; i++) {
    for (const pin of edges.get(ready[i]!) ?? []) {
      const count = incoming.get(pin)! - 1;
      incoming.set(pin, count);
      if (count === 0) ready.push(pin);
    }
  }
  if (ready.length !== dependencies.size) {
    return invalid("dependency uses graph contains a cycle");
  }
  return { kind: "valid", version, workflows, dependencies };
}

/**
 * Read and check the lockfile under `workDir`.
 *
 * A missing file is `absent`. Any other read failure is `unreadable` with
 * the cause, so a caller can treat it as unknown rather than as "no
 * lockfile". Otherwise the text goes through {@link parseActionsLockfile}.
 */
export async function readActionsLockfile(
  workDir: string,
  readTextFile: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<ActionsLockfileRead> {
  const path = `${workDir.replace(/\/+$/, "")}/${ACTIONS_LOCKFILE_PATH}`;
  let text: string;
  try {
    text = await readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { kind: "absent" };
    return {
      kind: "unreadable",
      reason: `could not read \`${path}\`: ${messageOf(err)}`,
    };
  }
  return parseActionsLockfile(text);
}

/**
 * True for a reusable-workflow coordinate (`owner/repo/.github/workflows/x.yml`).
 * The lockfile never covers these: `jobs.<id>.uses` is not locked.
 */
export function isReusableWorkflowCoordinate(coordinate: string): boolean {
  return coordinate.includes(REUSABLE_WORKFLOW_SEGMENT);
}

/**
 * The lockfile pin key for a `uses:` coordinate and its ref: the first two
 * path segments, lower-cased, as `owner/repo@ref`. A sub-action
 * (`github/codeql-action/init`) maps to its repo-scoped pin. Returns `null`
 * for a reusable-workflow coordinate or one with fewer than two segments.
 */
export function lockPinKey(coordinate: string, ref: string): string | null {
  if (isReusableWorkflowCoordinate(coordinate)) return null;
  const segments = coordinate.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  return `${segments[0]!.toLowerCase()}/${segments[1]!.toLowerCase()}@${ref}`;
}

/**
 * Whether the lockfile covers one `uses:` call-site.
 *
 *   - `sha-fallback` — the lockfile does not decide this call-site, so the
 *     SHA-pin rule applies: no valid lockfile, a non-workflow file (composite
 *     action), a reusable-workflow call, or a workflow the lockfile does not
 *     list (not yet onboarded).
 *   - `locked` — the onboarded workflow lists the pin and it has a dependency
 *     record.
 *   - `stale` — the onboarded workflow uses a ref the lockfile does not cover.
 */
export function lockCoverage(
  file: { path: string; kind: WorkflowFileKind },
  coordinate: string,
  ref: string,
  lockfile: ActionsLockfileEvidence,
): LockCoverage {
  if (lockfile.kind !== "valid" || file.kind !== "workflow") {
    return "sha-fallback";
  }
  const pin = lockPinKey(coordinate, ref);
  if (pin === null) return "sha-fallback";
  const listed = lockfile.workflows.get(file.path);
  if (listed === undefined) return "sha-fallback";
  return listed.has(pin) && lockfile.dependencies.has(pin) ? "locked" : "stale";
}
