/**
 * The operator's private layer, built `FROM` the standard image (Issue #980,
 * parent #933).
 *
 * A deployment that declares a `container_extension` (Issue #978) gets **two**
 * builds rather than one: the standard `vibe-coder:<baseHash>` exactly as
 * every host builds it today, and then the operator's own Containerfile built
 * on top of it as `vibe-coder:<extensionHash>` — the tag the container runs.
 * This module owns the second argument list and the one rule that makes
 * "layered on the standard image" a guarantee rather than a comment.
 *
 * ## The `FROM ${VIBE_BASE_IMAGE}` contract
 *
 * The extension Containerfile must open with `ARG VIBE_BASE_IMAGE` and derive
 * its first `FROM` from that argument. Without the check an operator's file
 * could name any base at all — `FROM ubuntu:24.04` — and the worker would run
 * in an image that carries none of the fleet's own toolchain, entrypoint or
 * pinned agents while still being tagged as if it did. The refusal happens
 * while the **plan** is built, so no build runs and the file is named
 * (see `DESIGN-PRINCIPLES.md`, never fail silently).
 *
 * Only `ARG` may precede that first `FROM`, which is the runtime's own rule for
 * a Containerfile's preamble.
 *
 * ## Containment
 *
 * The extension build adds nothing to the container's reach: the build context
 * is the extension directory alone, no host path is mounted, no port is
 * published, and the finished argument list goes through the same containment
 * assertion the run and init lists do (`container_launch.ts`). The only values
 * that cross into the build are the two build arguments below — the base tag
 * the layer must derive from, and the contract path of the start script the
 * sandbox-start sub-issue reads back out of the built image.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { ContainerExtensionSpec } from "../types.ts";
import { joinPath, type LauncherPathStyle } from "./host_path_style.ts";

/**
 * Build argument naming the standard image the operator's layer builds on.
 *
 * Framework plumbing, not an operator-facing setting: the operator's surface
 * is the `.config.json` `container_extension` block alone.
 */
export const BASE_IMAGE_BUILD_ARG = "VIBE_BASE_IMAGE";

/**
 * Build argument recording the declared start script's extension-relative
 * path, so the built image states the contract path the sandbox start reads.
 * Passed only when the declaration states one.
 */
export const EXTENSION_START_BUILD_ARG = "VIBE_EXTENSION_START";

/** Strip trailing separators so a directory joins (and is passed) cleanly. */
function trimDirectory(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

/** One meaningful Containerfile line: no comments, no blank lines. */
interface Directive {
  /** The instruction keyword, upper-cased (`ARG`, `FROM`, …). */
  keyword: string;
  /** Everything after the keyword, trimmed. */
  rest: string;
}

/**
 * The instructions a Containerfile states, in order.
 *
 * Comments, blank lines and parser directives (`# syntax=…`) carry no
 * instruction, so they are dropped rather than judged, and a `\` continuation
 * is joined into the instruction it belongs to — a checker that read the
 * second half of a wrapped `ARG` as an instruction of its own would refuse a
 * file the runtime builds happily.
 */
function directives(text: string): Directive[] {
  const found: Directive[] = [];
  let pending = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    const whole = `${pending}${line}`;
    pending = "";
    const separator = whole.search(/\s/);
    const keyword = (separator === -1 ? whole : whole.slice(0, separator))
      .toUpperCase();
    const rest = separator === -1 ? "" : whole.slice(separator).trim();
    found.push({ keyword, rest });
  }
  // A file ending mid-continuation still states what it stated.
  if (pending.trim() !== "") {
    const whole = pending.trim();
    const separator = whole.search(/\s/);
    found.push({
      keyword: (separator === -1 ? whole : whole.slice(0, separator))
        .toUpperCase(),
      rest: separator === -1 ? "" : whole.slice(separator).trim(),
    });
  }
  return found;
}

/** Whether an `ARG` instruction declares the base-image argument. */
function declaresBaseImage(rest: string): boolean {
  // `ARG VIBE_BASE_IMAGE` and `ARG VIBE_BASE_IMAGE=<default>` both declare it;
  // the plan always passes the argument, so a default never decides the base.
  // A wrapped `ARG A B` states several, and any of them may be the one.
  return rest.split(/\s+/).some((name) =>
    name.split("=")[0] === BASE_IMAGE_BUILD_ARG
  );
}

/** The image a `FROM` builds on, and the stage name it gives the result. */
interface FromInstruction {
  /** The image reference, with any `--platform=…` style flag skipped. */
  image: string;
  /** The `AS <name>` alias, lower-cased; absent when unnamed. */
  alias?: string;
}

/** Read a `FROM` instruction's image and stage alias. */
function parseFrom(rest: string): FromInstruction {
  const tokens = rest.split(/\s+/).filter((token) => token !== "");
  // `FROM --platform=$BUILDPLATFORM <image>` is an ordinary spelling; the
  // flags are not the base, so they are skipped rather than compared.
  let index = 0;
  while (tokens[index]?.startsWith("--")) index++;
  const image = tokens[index] ?? "";
  const alias = tokens[index + 1]?.toUpperCase() === "AS"
    ? tokens[index + 2]?.toLowerCase()
    : undefined;
  return alias === undefined ? { image } : { image, alias };
}

/** Whether a `FROM` names the base-image build argument directly. */
function namesBaseImage(image: string): boolean {
  return image === `\${${BASE_IMAGE_BUILD_ARG}}` ||
    image === `$${BASE_IMAGE_BUILD_ARG}`;
}

/**
 * Refuse an extension Containerfile that does not layer on the standard image.
 *
 * Two things are checked, because either alone can be evaded. The **first**
 * `FROM` must derive from the build argument, as the contract states. The
 * **last** stage must derive from it too — directly, or through a chain of
 * stages that does — because a build with no `--target` produces the last
 * stage: `FROM ${VIBE_BASE_IMAGE} AS unused` followed by `FROM ubuntu:24.04`
 * would otherwise pass a first-`FROM`-only check and still run the worker in
 * an image carrying none of the fleet's toolchain, entrypoint or pinned
 * agents. A helper stage built on anything the operator likes is still fine —
 * it is not what the layer ships.
 *
 * @param text - The operator's Containerfile, as read from the host
 * @param path - Its host path, named in every refusal
 * @throws When the file states no `FROM`, when anything other than `ARG`
 *   precedes the first one, when `ARG VIBE_BASE_IMAGE` is not declared before
 *   it, or when its first or last stage derives from anything else
 */
export function assertExtensionLayersOnBaseImage(
  text: string,
  path: string,
): void {
  const refuse = (detail: string): never => {
    throw new Error(
      `Refusing to launch: the container_extension Containerfile ${path} ` +
        `${detail}. It must open with \`ARG ${BASE_IMAGE_BUILD_ARG}\` ` +
        `and \`FROM \${${BASE_IMAGE_BUILD_ARG}}\` so the operator's ` +
        `layer is built on the standard Vibe Coder image (Issue #980).`,
    );
  };

  let declared = false;
  let seenFrom = false;
  /** Stage names that derive from the base, directly or through a chain. */
  const layered = new Set<string>();
  /** The last stage's image, and whether it is one of those. */
  let finalImage = "";
  let finalLayered = false;

  for (const directive of directives(text)) {
    if (directive.keyword === "FROM") {
      const from = parseFrom(directive.rest);
      const onBase = namesBaseImage(from.image) ||
        layered.has(from.image.toLowerCase());
      if (!seenFrom) {
        if (!declared) {
          refuse(
            `states no \`ARG ${BASE_IMAGE_BUILD_ARG}\` before its ` +
              `first FROM`,
          );
        }
        if (!onBase) {
          refuse(
            `builds \`FROM ${directive.rest}\` rather than from the ` +
              `standard image`,
          );
        }
        seenFrom = true;
      }
      if (onBase && from.alias) layered.add(from.alias);
      finalImage = from.image;
      finalLayered = onBase;
      continue;
    }
    if (!seenFrom) {
      if (directive.keyword !== "ARG") {
        refuse(
          `states \`${directive.keyword}\` before its first FROM — only ARG ` +
            `may precede it`,
        );
      }
      if (declaresBaseImage(directive.rest)) declared = true;
    }
  }

  if (!seenFrom) refuse("states no FROM instruction at all");
  if (!finalLayered) {
    refuse(
      `builds its last stage \`FROM ${finalImage}\` rather than from the ` +
        `standard image — a build with no --target ships that stage`,
    );
  }
}

/** What the extension build is derived from. */
export interface ExtensionBuildInputs {
  /** The validated declaration (Issue #978). */
  spec: ContainerExtensionSpec;
  /** The standard image's tag, which the layer must build `FROM`. */
  baseImage: string;
  /** The layered image's own content-derived tag — what the container runs. */
  extensionImage: string;
  /** The operator's Containerfile text, checked before the build is emitted. */
  containerfileText: string;
  /** How this host spells its paths. */
  style: LauncherPathStyle;
}

/**
 * The `build` arguments for the operator's private layer.
 *
 * Options precede the context path, matching the standard build's convention,
 * and the context is the extension directory alone.
 *
 * @param inputs - The declaration, the two tags, and the Containerfile text
 * @returns The runtime arguments that build the layered image
 * @throws When the Containerfile does not derive `FROM ${VIBE_BASE_IMAGE}`
 */
export function extensionBuildArguments(
  inputs: ExtensionBuildInputs,
): string[] {
  const { spec, baseImage, extensionImage, style } = inputs;
  const directory = trimDirectory(spec.path);
  const containerfile = joinPath(directory, spec.containerfile, style);

  // Before the arguments exist, so a refused Containerfile can never reach a
  // build: the plan fails here, naming the file.
  assertExtensionLayersOnBaseImage(inputs.containerfileText, containerfile);

  const args = [
    "build",
    "--file",
    containerfile,
    "--tag",
    extensionImage,
    "--build-arg",
    `${BASE_IMAGE_BUILD_ARG}=${baseImage}`,
  ];
  // The start script's contract path (Issue #980): framework plumbing the
  // sandbox-start sub-issue reads back, never an operator-facing setting.
  if (spec.start !== undefined) {
    args.push("--build-arg", `${EXTENSION_START_BUILD_ARG}=${spec.start}`);
  }
  args.push(directory);
  return args;
}
