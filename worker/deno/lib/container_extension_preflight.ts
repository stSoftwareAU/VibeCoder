/**
 * Launch preflight for a deployment's private extension (Issue #982, parent
 * #933).
 *
 * The validator in Issue #978 checks what the operator *wrote*; this module
 * checks what is actually **there**. It runs while the launch plan is built —
 * before the standard image build, and therefore before either build — so a
 * missing directory, a missing Containerfile or a missing start script costs
 * the operator a sentence rather than the minutes a build takes to reach the
 * same conclusion.
 *
 * ## What it refuses, and why here
 *
 * - The extension directory is absent, is not a directory, or cannot be read.
 *   The Vibe Coder clones nothing: the operator syncs their own private
 *   repository into that directory, so an absent one is a setup step not yet
 *   taken, not a bug to be papered over.
 * - The declared `containerfile` is absent under it, or is not a file. The
 *   build's `--file` would name a path the runtime cannot open.
 * - A declared `start` is absent under it, or is not a file. The sandbox start
 *   (Issue #981) reads it back out of the built image, and an image built
 *   without it fails much later and much less clearly.
 * - Anything under the directory is a symlink resolving outside it — the same
 *   escape the digest (Issue #979) refuses, checked here so the operator hears
 *   it **once, early, with the remedy attached** rather than as a hashing
 *   failure. A directory that loops back into itself is refused for the same
 *   reason: the digest cannot hash it either.
 *
 * Whether `/opt/vibe-extension/<start>` is present and executable **inside**
 * the built image is deliberately not checked here — that contract is enforced
 * at sandbox start (Issue #981); nothing host-side can see inside an image
 * that has not been built.
 *
 * ## Containment
 *
 * The preflight only reads. It mounts nothing, publishes nothing, and adds no
 * host path to the launch plan: the extension reaches the sandbox through the
 * image, never through a bind mount (`container_containment_test.ts` pins
 * that).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { ContainerExtensionSpec } from "../types.ts";
import {
  isAtOrAbove,
  joinPath,
  normalisePath,
  pathStyleFor,
} from "./host_path_style.ts";

/** Every refusal opens the same way, so the operator can grep for one phrase. */
const REFUSAL = "Cannot launch: the container_extension";

/**
 * Stat the extension directory, refusing anything that is not a readable one.
 *
 * @param path - The declared extension directory
 * @returns Its resolved real path, which the escape check compares against
 * @throws When the directory is absent, unreadable, or not a directory
 */
async function assertDirectory(path: string): Promise<string> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `${REFUSAL} directory ${path} does not exist. The operator syncs ` +
          `their own extension into it — the Vibe Coder clones nothing.`,
      );
    }
    throw new Error(
      `${REFUSAL} directory ${path} is unreadable ` +
        `(${(error as Error).message}).`,
    );
  }
  if (!info.isDirectory) {
    throw new Error(
      `${REFUSAL} path ${path} is not a directory.`,
    );
  }

  try {
    return await Deno.realPath(path);
  } catch (error) {
    throw new Error(
      `${REFUSAL} directory ${path} cannot be resolved ` +
        `(${(error as Error).message}).`,
    );
  }
}

/**
 * Refuse a declared file that is not there.
 *
 * @param path - The resolved host path of the declared file
 * @param label - What the declaration calls it, e.g. `Containerfile`
 * @param field - The `.config.json` key that named it
 * @param directory - The extension directory it is declared relative to
 * @throws When the file is absent, unreadable, or is not a regular file
 */
async function assertDeclaredFile(
  path: string,
  label: string,
  field: string,
  directory: string,
): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `${REFUSAL} ${label} ${path} does not exist. ${field} names it, ` +
          `relative to ${directory}.`,
      );
    }
    throw new Error(
      `${REFUSAL} ${label} ${path} is unreadable ` +
        `(${(error as Error).message}).`,
    );
  }
  if (!info.isFile) {
    throw new Error(
      `${REFUSAL} ${label} ${path} is not a file. ${field} names it, ` +
        `relative to ${directory}.`,
    );
  }
}

/**
 * Walk the extension directory, refusing any link that leaves it.
 *
 * Deliberately its own walk rather than the digest's: this one runs before the
 * digest, needs no sizes, modes or ordering, and reports with the remedy
 * attached. `ancestors` holds the real paths on the **current** chain, so an
 * alias beside its target (`latest -> v3`) is ordinary while a link back up
 * the chain is the endless walk the digest also refuses.
 *
 * @param directory - The directory being walked
 * @param prefix - Its path relative to the extension root
 * @param realRoot - The extension root's resolved real path
 * @param ancestors - Real paths of the directories on the current chain
 * @throws When an entry cannot be read, escapes the root, or loops
 */
async function assertNoEscape(
  directory: string,
  prefix: string,
  realRoot: string,
  ancestors: Set<string>,
): Promise<void> {
  const style = pathStyleFor(realRoot);
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) entries.push(entry);
  } catch (error) {
    throw new Error(
      `${REFUSAL} directory ${directory} is unreadable ` +
        `(${(error as Error).message}).`,
    );
  }

  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    let real: string;
    try {
      real = await Deno.realPath(path);
    } catch (error) {
      throw new Error(
        `${REFUSAL} entry ${relative} (${path}) cannot be resolved ` +
          `(${(error as Error).message}).`,
      );
    }
    if (
      !isAtOrAbove(
        normalisePath(realRoot, style),
        normalisePath(real, style),
        style,
      )
    ) {
      throw new Error(
        `${REFUSAL} symlink ${relative} escapes the extension directory: it ` +
          `resolves to ${real}, outside ${realRoot}. Copy what the build ` +
          `needs into the extension directory — a link out of it would fold ` +
          `host content the operator never synced into the image.`,
      );
    }

    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(path);
    } catch (error) {
      throw new Error(
        `${REFUSAL} entry ${relative} (${path}) is unreadable ` +
          `(${(error as Error).message}).`,
      );
    }
    if (!info.isDirectory) continue;
    if (ancestors.has(real)) {
      throw new Error(
        `${REFUSAL} directory loops: ${relative} resolves to ${real}, a ` +
          `directory it is already inside — the build would never finish ` +
          `copying it.`,
      );
    }
    await assertNoEscape(
      path,
      relative,
      realRoot,
      new Set([...ancestors, real]),
    );
  }
}

/**
 * Prove the declared extension is actually on the host, before any build.
 *
 * @param spec - The validated declaration (Issue #978)
 * @throws Naming the offending path and what was expected, when the directory
 *   is absent, unreadable or not a directory; when the declared
 *   `containerfile` or `start` is absent under it; or when the directory
 *   contains a symlink pointing outside itself
 */
export async function preflightContainerExtension(
  spec: ContainerExtensionSpec,
): Promise<void> {
  const style = pathStyleFor(spec.path);
  const directory = normalisePath(spec.path, style);
  const realRoot = await assertDirectory(directory);

  await assertDeclaredFile(
    joinPath(directory, spec.containerfile, style),
    "Containerfile",
    "container_extension.containerfile",
    directory,
  );
  if (spec.start !== undefined) {
    await assertDeclaredFile(
      joinPath(directory, spec.start, style),
      "start script",
      "container_extension.start",
      directory,
    );
  }

  await assertNoEscape(directory, "", realRoot, new Set([realRoot]));
}
