/**
 * Prune superseded Vibe Coder container image tags (Issue #4162).
 *
 * ## What went wrong
 *
 * The image tag is derived from the container definition (#4062), so every
 * change to `container/` builds a new `vibe-coder:<hash>` — and nothing ever
 * deleted the tag it superseded. On host-23 four multi-gigabyte images plus the
 * builder cache took Apple container's store to 32 GB, the host dropped to
 * 765 MB free, and the next build died mid-export ("No space left on device").
 * On an unattended fleet host every merged container change leaks an image
 * permanently, with no operator watching the disk.
 *
 * ## The rule
 *
 * The reference this checkout resolves to is the only one any future launch of
 * it can use, so after the launchers have that image present, every *other*
 * `vibe-coder` tag is dead weight and is removed. A rollback rebuilds from the
 * builder cache, which is deliberately left alone — it is what keeps a
 * definition-change rebuild cheap.
 *
 * Three properties keep this safe on an unattended host:
 *
 * 1. **Only our own image.** A candidate must be the same repository as the
 *    reference being kept (Podman's `localhost/` prefix included) and carry a
 *    different tag. A foreign `vibe-coder` from some registry, a dangling
 *    `<none>` layer and every other image are left untouched.
 * 2. **Nothing untrusted reaches the runtime.** Both the reference to keep and
 *    each candidate are validated before they are passed as arguments, so a
 *    listing carrying something odd cannot turn into an argument the runtime
 *    misreads.
 * 3. **It fails loud.** A listing the runtime refused, output that parsed to
 *    nothing, or a removal that was refused is reported as a failure — never as
 *    "there was nothing to prune" (Issue #3234). The launchers treat that as a
 *    warning and carry on: reclaiming disk must not block a launch, and the
 *    next launch prunes again.
 *
 * Driving a container runtime is exactly what a test must not really do, so
 * every invocation is a seam on {@link PruneDeps}; {@link createPruneDeps}
 * supplies the production implementation, bounded by a timeout because a wedged
 * runtime CLI never returns.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { runWithTimeout } from "./subprocess_timeout.ts";

/** Bound on one runtime invocation — a wedged CLI never returns. */
export const PRUNE_RUNTIME_TIMEOUT_MS = 120_000;

/** Registry prefix a runtime gives an image built locally (Podman). */
const LOCAL_REGISTRY_PREFIX = "localhost/";

/** Repository forms the runtimes accept, host and port segments included. */
const REPOSITORY_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(:[0-9]+)?(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Tags the runtimes accept — and no shell or argument parser can misread. */
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** A reference split into the parts the selection rule compares. */
export interface ImageReferenceParts {
  /** Repository, e.g. `vibe-coder` or `localhost/vibe-coder`. */
  repository: string;
  /** Tag, e.g. a 12-character content hash. */
  tag: string;
}

/** One image the runtime listed. */
export interface ImageRecord extends ImageReferenceParts {
  /** Full reference, exactly as it must be passed back to the runtime. */
  reference: string;
}

/**
 * Split an image reference into a repository and a tag.
 *
 * Deliberately strict: anything that is not a plain `repository:tag` the
 * runtimes accept — an untagged reference, a `<none>` placeholder, a value
 * carrying whitespace or shell punctuation — returns null rather than being
 * passed on to a runtime as an argument.
 *
 * @param reference - Raw reference from a runtime listing or a launch plan
 * @returns The parts, or null when it is not a reference we would act on
 */
export function parseImageReference(
  reference: string,
): ImageReferenceParts | null {
  const trimmed = reference.trim();
  const separator = trimmed.lastIndexOf(":");
  if (separator <= 0) return null;

  const repository = trimmed.slice(0, separator);
  const tag = trimmed.slice(separator + 1);
  if (!REPOSITORY_RE.test(repository) || !TAG_RE.test(tag)) return null;
  return { repository, tag };
}

/** The repository with a runtime's local-registry prefix removed. */
function bareRepository(repository: string): string {
  return repository.startsWith(LOCAL_REGISTRY_PREFIX)
    ? repository.slice(LOCAL_REGISTRY_PREFIX.length)
    : repository;
}

// ---------------------------------------------------------------------------
// The runtime's image listing
// ---------------------------------------------------------------------------

/** Keys the supported runtimes spell a full reference with. */
const REFERENCE_KEYS = [
  "reference",
  "Reference",
  "Names",
  "names",
  "RepoTags",
  "repoTags",
  "Name",
  "name",
];

/** Keys the supported runtimes spell a repository with. */
const REPOSITORY_KEYS = ["Repository", "repository"];

/** Keys the supported runtimes spell a tag with. */
const TAG_KEYS = ["Tag", "tag"];

/** The first non-empty string in a value that may be a string or an array. */
function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (Array.isArray(value)) {
    const found = value.find((entry) =>
      typeof entry === "string" && entry.trim() !== ""
    );
    if (typeof found === "string") return found.trim();
  }
  return undefined;
}

/** Read a reference out of whatever shape a runtime used for one image. */
function recordFrom(value: unknown): ImageRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const object = value as Record<string, unknown>;

  // Apple container nests the reference at `configuration.name` (Issue
  // #4331). The top-level-only lookup below returned nothing for every
  // record, so the prune was a silent no-op on every launch — six
  // superseded 4.9 GB snapshots (~30 GB) accumulated on host-23. Look
  // there first; a digest-only reference (`repo@sha256:…`) parses to
  // nothing and is dropped, as before.
  const configuration = object["configuration"];
  if (typeof configuration === "object" && configuration !== null) {
    const nested = firstString(
      (configuration as Record<string, unknown>)["name"],
    );
    if (nested) {
      const parts = parseImageReference(nested);
      if (parts) return { reference: nested, ...parts };
    }
  }

  for (const key of REFERENCE_KEYS) {
    const reference = firstString(object[key]);
    if (reference) {
      const parts = parseImageReference(reference);
      if (parts) return { reference, ...parts };
    }
  }

  const repository = REPOSITORY_KEYS.map((key) => firstString(object[key]))
    .find((found) => found !== undefined);
  const tag = TAG_KEYS.map((key) => firstString(object[key]))
    .find((found) => found !== undefined);
  if (repository && tag) {
    const reference = `${repository}:${tag}`;
    const parts = parseImageReference(reference);
    if (parts) return { reference, ...parts };
  }
  return undefined;
}

/**
 * Parse a runtime's image listing.
 *
 * Accepts every shape the supported runtimes produce: a JSON array (Podman,
 * Apple container), one JSON object per line (Docker), or a plain reference per
 * line. Entries that are not a usable `repository:tag` — a dangling
 * `<none>:<none>`, a table header — are dropped.
 *
 * @param text - Raw listing output
 * @returns The images named in it
 */
export function parseImageListing(text: string): ImageRecord[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  try {
    const parsed = JSON.parse(trimmed);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const records = values
      .map(recordFrom)
      .filter((record): record is ImageRecord => record !== undefined);
    if (records.length > 0) return records;
  } catch {
    // Not one JSON document — try the per-line shapes below.
  }

  const records: ImageRecord[] = [];
  for (const line of trimmed.split("\n")) {
    const value = line.trim();
    if (value === "") continue;
    if (value.startsWith("{")) {
      try {
        const record = recordFrom(JSON.parse(value));
        if (record) records.push(record);
      } catch {
        // A truncated line names nothing; skip it.
      }
      continue;
    }
    const reference = value.split(/\s+/)[0]!;
    const parts = parseImageReference(reference);
    if (parts) records.push({ reference, ...parts });
  }
  return records;
}

/** True when a listing genuinely reported no images at all. */
function listingIsEmpty(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || trimmed === "[]" || trimmed === "{}" ||
    trimmed === "null";
}

// ---------------------------------------------------------------------------
// Choosing what to prune
// ---------------------------------------------------------------------------

/**
 * Pick the superseded tags of the image being kept.
 *
 * @param options.records - Images the runtime reported
 * @param options.keep - Reference this checkout resolves to
 * @returns The images to remove, in listing order
 */
export function selectSupersededImages(options: {
  records: readonly ImageRecord[];
  keep: string;
}): ImageRecord[] {
  const keep = parseImageReference(options.keep);
  if (!keep) return [];
  const keepRepository = bareRepository(keep.repository);

  return options.records.filter((record) =>
    bareRepository(record.repository) === keepRepository &&
    record.tag !== keep.tag
  );
}

// ---------------------------------------------------------------------------
// The prune
// ---------------------------------------------------------------------------

/** One runtime invocation's outcome. */
export interface RuntimeInvocation {
  code: number;
  stdout: string;
  stderr: string;
}

/** The operations a prune performs — every one a seam for the tests. */
export interface PruneDeps {
  /** Run the runtime with the given arguments, bounded and captured. */
  runRuntime: (args: readonly string[]) => Promise<RuntimeInvocation>;
  /** Operator-facing log sink (stderr in production). */
  log: (message: string) => void;
}

/** One prune request. */
export interface PruneOptions {
  /** Reference to keep — this checkout's content-derived image. */
  keep: string;
  /** Arguments that list the local images. */
  listArgs: readonly string[];
  /** Arguments that remove an image, before the reference. */
  removeArgs: readonly string[];
}

/** A removal the runtime refused. */
export interface FailedRemoval {
  reference: string;
  /** Runtime exit status, or -1 when the runtime could not be run at all. */
  code: number;
  /** Short reason, taken from the runtime's own output. */
  detail: string;
}

/** What one prune achieved. */
export interface PruneOutcome {
  /** References removed, in the order they were removed. */
  removed: string[];
  /** Removals the runtime refused. */
  failed: FailedRemoval[];
  /** True only when the listing succeeded and every removal succeeded. */
  ok: boolean;
  /** Why the prune is not `ok` — named for the host log. */
  detail?: string;
}

/** Keep a runtime's diagnostic output to one short, single-line reason. */
function firstLine(text: string, limit = 200): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) =>
    part !== ""
  );
  if (!line) return "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/**
 * Remove every `vibe-coder` tag other than the one being kept.
 *
 * @param deps - Injected runtime and log seams
 * @param options - The reference to keep and the runtime's own argv dialect
 * @returns What was removed, and why the prune is not clean when it is not
 */
export async function pruneSupersededImages(
  deps: PruneDeps,
  options: PruneOptions,
): Promise<PruneOutcome> {
  const keep = parseImageReference(options.keep);
  if (!keep) {
    const detail = `${JSON.stringify(options.keep)} is not a plain ` +
      `repository:tag image reference — refusing to prune anything`;
    deps.log(`[container-image-prune] ${detail}`);
    return { removed: [], failed: [], ok: false, detail };
  }

  const listing = await deps.runRuntime(options.listArgs);
  if (listing.code !== 0) {
    const detail = `${options.listArgs.join(" ")} exited ${listing.code}: ` +
      (firstLine(listing.stderr) || firstLine(listing.stdout) || "no output");
    deps.log(
      `[container-image-prune] could not list the local images — ${detail}`,
    );
    return { removed: [], failed: [], ok: false, detail };
  }

  const records = parseImageListing(listing.stdout);
  if (records.length === 0 && !listingIsEmpty(listing.stdout)) {
    // Output that names nothing we recognise is not an empty store: saying so
    // is what keeps a changed runtime dialect from looking like a clean host.
    const detail = `the output of ${options.listArgs.join(" ")} could not be ` +
      `read as an image listing (first line: ${
        firstLine(listing.stdout) || "empty"
      })`;
    deps.log(`[container-image-prune] ${detail}`);
    return { removed: [], failed: [], ok: false, detail };
  }

  const superseded = selectSupersededImages({ records, keep: options.keep });
  if (superseded.length === 0) {
    deps.log(
      `[container-image-prune] nothing to prune — ${options.keep} is the ` +
        `only ${keep.repository} tag on this host`,
    );
    return { removed: [], failed: [], ok: true };
  }

  const removed: string[] = [];
  const failed: FailedRemoval[] = [];
  for (const record of superseded) {
    const result = await deps.runRuntime([
      ...options.removeArgs,
      record.reference,
    ]);
    if (result.code === 0) {
      removed.push(record.reference);
      deps.log(
        `[container-image-prune] removed superseded image ${record.reference}`,
      );
      continue;
    }
    const detail = firstLine(result.stderr) || firstLine(result.stdout) ||
      "no output";
    failed.push({ reference: record.reference, code: result.code, detail });
    deps.log(
      `[container-image-prune] could not remove ${record.reference} ` +
        `(exit ${result.code}): ${detail}`,
    );
  }

  if (failed.length > 0) {
    return {
      removed,
      failed,
      ok: false,
      detail: `could not remove ${
        failed.map((failure) => failure.reference).join(", ")
      }`,
    };
  }
  return { removed, failed, ok: true };
}

// ---------------------------------------------------------------------------
// Production seam
// ---------------------------------------------------------------------------

/**
 * The production seam: real subprocesses, bounded, output captured.
 *
 * @param runtime - Runtime executable the launcher chose
 * @param timeoutMs - Bound on one runtime invocation
 * @returns Dependencies for {@link pruneSupersededImages}
 */
export function createPruneDeps(
  runtime: string,
  timeoutMs: number = PRUNE_RUNTIME_TIMEOUT_MS,
): PruneDeps {
  return {
    log: (message) => console.error(message),
    runRuntime: async (args) => {
      const result = await runWithTimeout(runtime, [...args], { timeoutMs });
      if (!result.ok) {
        // A missing executable is a failed invocation, never an empty success.
        return {
          code: -1,
          stdout: "",
          stderr: `${runtime} could not be run: ${result.error.message}`,
        };
      }
      if (result.value.timedOut) {
        return {
          code: -1,
          stdout: result.value.stdout,
          stderr: `${runtime} ${args.join(" ")} did not answer within ${
            timeoutMs / 1000
          }s`,
        };
      }
      return {
        code: result.value.code,
        stdout: result.value.stdout,
        stderr: result.value.stderr,
      };
    },
  };
}
