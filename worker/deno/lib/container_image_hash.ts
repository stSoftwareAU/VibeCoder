/**
 * Content-derived identity for the Vibe Coder container image (Issue #4062).
 *
 * The image tag is a hash of the container definition itself, so a changed
 * definition is a different image and the launchers can decide to rebuild
 * without anyone remembering to bump a version by hand.
 *
 * The inputs are **explicitly enumerated** below — never a walk of the
 * workspace. The worker's checkout is mutable working state (issue branches,
 * scratch output, cloned repositories); hashing it would invalidate the image
 * on every commit and rebuild constantly for no gain. Only files that
 * genuinely change what the image contains belong in the list.
 *
 * Not every input is a committed file. The deployer-selected `container_tools`
 * spec (Issue #73, parent #5), the deployment's coding-agent provider set
 * (Issue #729) and its private `container_extension` directory (Issue #979,
 * parent #933) are all baked into the image by the build, so they are mixed
 * into the hash alongside the enumerated files — two deployments that select
 * different tool sets, different agents or different extensions must build
 * different images, or one host's cached `vibe-coder:<hash>` silently
 * satisfies another host's requirement and the selected tool, the selected
 * agent, or the operator's own extension is quietly missing.
 *
 * Fails loud: a missing enumerated input throws with the path named, a
 * malformed tool spec throws with the offending field named, and an absent or
 * unreadable extension directory throws with the offending entry named, rather
 * than hashing a shorter list and silently producing a different tag.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { computeContainerExtensionDigest } from "./container_extension_digest.ts";
import { assertContainerTools } from "./container_tools_config.ts";
import type { ContainerExtensionSpec } from "../types.ts";

/** Image name every launcher and test agrees on. */
export const CONTAINER_IMAGE_NAME = "vibe-coder";

/** Hex characters of the digest used in the tag. */
export const CONTAINER_IMAGE_HASH_LENGTH = 12;

/**
 * The container definition, as repository-relative paths.
 *
 * Order is part of the hash, so entries are kept in a fixed order. Adding a
 * setup script under `container/` means adding it here — the committed-files
 * check in `worker/deno/tests/container_image_hash_test.ts` fails when the
 * two drift apart.
 */
export const CONTAINER_IMAGE_INPUTS: readonly string[] = [
  "container/Containerfile",
  "container/entrypoint.sh",
  // The volume init (Issue #229): fsck + chown before the worker starts.
  "container/volume-init.sh",
  "container/tools.json",
  // The provider-set installer (Issue #4105): it decides which fragments run,
  // so a change to it changes what the image contains. The image's *default*
  // set is the Containerfile's AGENT_PROVIDERS default, already hashed above;
  // a deployment that selects a different one contributes it separately, under
  // AGENT_PROVIDERS_HASH_INPUT (Issue #729).
  "container/install-providers.sh",
  // The deployer-supplied tool installer (Issue #71): the build runs it over
  // the VIBE_CONTAINER_TOOLS spec, so a change to it changes what the image
  // contains. The selection itself is a build argument, not a committed file.
  "container/install-tools.sh",
  // The coding-agent provider fragments (Issue #4067): each installs a
  // provider binary, so editing one changes what the image contains.
  "container/providers/claude.sh",
  "container/providers/codex.sh",
  "container/providers/gemini.sh",
  // DeepSeek rides the Claude CLI under its own command name and its own pin
  // (Issue #415), so it is its own fragment and its own hash input.
  "container/providers/deepseek.sh",
  "worker/deno/deno.lock",
];

/**
 * Label the selected tool spec is hashed and reported under.
 *
 * It is deliberately not a path: the spec comes from the deployment's
 * `.config.json`, not from a committed file, so it sits beside
 * {@link CONTAINER_IMAGE_INPUTS} rather than inside it.
 */
export const CONTAINER_TOOLS_HASH_INPUT = "container_tools";

/**
 * Label the selected coding-agent provider set is hashed under (Issue #729).
 *
 * Like the tool spec, the set comes from the deployment's `.config.json` and
 * is baked into the image by the build's `AGENT_PROVIDERS` argument, so it
 * sits beside {@link CONTAINER_IMAGE_INPUTS} rather than inside it.
 */
export const AGENT_PROVIDERS_HASH_INPUT = "agent_providers";

/**
 * Label the deployment's private extension is hashed under (Issue #979).
 *
 * Its contents are an operator-owned host directory, not a committed file, so
 * like the tool spec and the provider set it sits beside
 * {@link CONTAINER_IMAGE_INPUTS} rather than inside it. What is hashed under
 * the label is the digest `container_extension_digest.ts` derives from the
 * directory, so editing any file in it — a `.sql` dump included — moves the
 * tag and the host rebuilds.
 */
export const CONTAINER_EXTENSION_HASH_INPUT = "container_extension";

/** What a caller may mix into the hash beyond the enumerated files. */
export interface ContainerImageHashOptions {
  /**
   * The deployment's `container_tools` selection — the raw `.config.json`
   * value or an already-validated spec, both accepted. Absent, `null` or empty
   * means "this deployment selects no tools" and produces the same tag the
   * enumerated files alone produce, so an existing fleet does not rebuild.
   *
   * The value is always re-validated (Issue #69), so a malformed spec throws
   * with the offending field named instead of silently changing the tag.
   */
  containerTools?: unknown;
  /**
   * The `AGENT_PROVIDERS` value this deployment's build passes (Issue #729),
   * as {@link agentProvidersBuildValue} derives it from the enabled set.
   *
   * Absent or empty means the build takes the image's default set, and
   * produces exactly the tag the enumerated files alone produce — so a fleet
   * that never selects a provider does not rebuild. Any other set is a
   * different image: without this a host switching to Codex would keep
   * reusing the cached Claude image under an identical tag.
   */
  agentProviders?: string;
  /**
   * The deployment's validated `container_extension` declaration (Issue #979),
   * as `container_extension_config.ts` produces it.
   *
   * Absent means this deployment configures no extension, and produces exactly
   * the tag the enumerated files alone produce — so a fleet that configures
   * none does not rebuild on upgrade. Any declaration is a different image:
   * the extension's `Containerfile` builds `FROM` the standard one, so its
   * contents are part of what the resulting image contains.
   */
  containerExtension?: ContainerExtensionSpec;
}

const encoder = new TextEncoder();

/**
 * Separator between an input's label, its byte length and its bytes.
 *
 * NUL, because it cannot occur in a path or in the canonical tool spec, so no
 * input's content can forge another input's framing. Written as an escape:
 * this was a literal NUL byte in the source until Issue #73, which no reader
 * could see.
 */
const FIELD_SEPARATOR = "\0";

/** Join a repository root and a repository-relative path. */
function inputPath(repoRoot: string, relative: string): string {
  return `${repoRoot.replace(/[/\\]+$/, "")}/${relative}`;
}

/** Read one enumerated input, failing loud when it is absent. */
async function readInput(
  repoRoot: string,
  relative: string,
): Promise<Uint8Array> {
  const path = inputPath(repoRoot, relative);
  try {
    return await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Container image input missing: ${relative} (expected at ${path}). ` +
          `Every enumerated input must exist — hashing a shorter list would ` +
          `silently produce a different image tag.`,
      );
    }
    throw new Error(
      `Container image input unreadable: ${relative} (${path}): ` +
        `${(error as Error).message}`,
    );
  }
}

/**
 * Serialise a value with object keys sorted and no whitespace.
 *
 * The digest must follow what the spec *means*, not how it was typed: keys are
 * sorted so re-ordering `id` and `version` in `.config.json` does not churn the
 * tag, while any change of value does.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${
      entries
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The canonical form of a `container_tools` selection, as hashed.
 *
 * Validation runs first (Issue #69), so the serialisation covers the
 * **resolved** spec — defaults filled in, digests lower-cased — and a
 * `.config.json` that spells the same selection differently produces the same
 * tag. Array order is kept: the entry order decides PATH order inside the
 * image, so a re-ordered array is a different image.
 *
 * @param raw - Raw `.config.json` value, or an already-validated spec
 * @returns Canonical serialisation, or `""` when no tools are selected
 * @throws When the spec is malformed, naming the offending field
 */
export function canonicalContainerToolsSpec(raw: unknown): string {
  const tools = assertContainerTools(raw);
  return tools.length === 0 ? "" : canonicalJson(tools);
}

/**
 * Hash the enumerated container-definition inputs and the deployment's own
 * selections.
 *
 * Each input contributes its path and byte length as well as its bytes, so
 * moving content between two inputs changes the digest rather than cancelling
 * out. The tool spec, the provider set and the extension digest contribute
 * under the same framing, each only when the deployment states it — a
 * deployment that states none hashes exactly the byte stream it did before
 * Issue #73, so no existing host rebuilds on upgrade.
 *
 * @param repoRoot - Repository root the inputs are resolved against
 * @param options - The deployment's own selections, if any
 * @returns Lowercase hex SHA-256 of the definition
 * @throws When an enumerated input is missing or unreadable, the tool spec is
 *         malformed, or the extension directory cannot be hashed
 */
export async function computeContainerImageHash(
  repoRoot: string,
  options: ContainerImageHashOptions = {},
): Promise<string> {
  const parts: Uint8Array[] = [];

  // Validated before any file is read, so a malformed spec fails on the field
  // that is wrong rather than on whatever the filesystem complains about next.
  const spec = canonicalContainerToolsSpec(options.containerTools);

  /** Frame one input by label and byte length, then its bytes. */
  const push = (label: string, bytes: Uint8Array): void => {
    parts.push(
      encoder.encode(
        `${label}${FIELD_SEPARATOR}${bytes.length}${FIELD_SEPARATOR}`,
      ),
    );
    parts.push(bytes);
    parts.push(encoder.encode("\n"));
  };

  for (const relative of CONTAINER_IMAGE_INPUTS) {
    push(relative, await readInput(repoRoot, relative));
  }

  if (spec !== "") push(CONTAINER_TOOLS_HASH_INPUT, encoder.encode(spec));

  // The provider set (Issue #729), last so a deployment that selects none
  // hashes exactly the byte stream it did before this issue.
  const providers = options.agentProviders?.trim() ?? "";
  if (providers !== "") {
    push(AGENT_PROVIDERS_HASH_INPUT, encoder.encode(providers));
  }

  // The private extension (Issue #979), last again and only when one is
  // configured, so a deployment that configures none hashes exactly the byte
  // stream it did before this issue and no existing host rebuilds.
  if (options.containerExtension) {
    push(
      CONTAINER_EXTENSION_HASH_INPUT,
      encoder.encode(
        await computeContainerExtensionDigest(options.containerExtension),
      ),
    );
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }

  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The image reference the launchers build and run.
 *
 * This is the single naming rule — launchers, the build workflow and the
 * tests all call it rather than restating `vibe-coder:<hash>` themselves.
 *
 * @param repoRoot - Repository root the inputs are resolved against
 * @param options - The deployment's own selections, if any
 * @returns `vibe-coder:<short hash>`
 * @throws When an enumerated input is missing or unreadable, the tool spec is
 *         malformed, or the extension directory cannot be hashed
 */
export async function resolveContainerImageReference(
  repoRoot: string,
  options: ContainerImageHashOptions = {},
): Promise<string> {
  const hash = await computeContainerImageHash(repoRoot, options);
  return `${CONTAINER_IMAGE_NAME}:${
    hash.slice(0, CONTAINER_IMAGE_HASH_LENGTH)
  }`;
}
