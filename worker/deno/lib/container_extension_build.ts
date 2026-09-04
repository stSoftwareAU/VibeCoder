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
export const VIBE_BASE_IMAGE_BUILD_ARG = "VIBE_BASE_IMAGE";

/**
 * Build argument recording the declared start script's extension-relative
 * path, so the built image states the contract path the sandbox start reads.
 * Passed only when the declaration states one.
 */
export const VIBE_EXTENSION_START_BUILD_ARG = "VIBE_EXTENSION_START";

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
 * instruction, so they are dropped rather than judged.
 */
function directives(text: string): Directive[] {
  const found: Directive[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.search(/\s/);
    const keyword = (separator === -1 ? line : line.slice(0, separator))
      .toUpperCase();
    const rest = separator === -1 ? "" : line.slice(separator).trim();
    found.push({ keyword, rest });
  }
  return found;
}

/** Whether an `ARG` instruction declares the base-image argument. */
function declaresBaseImage(rest: string): boolean {
  // `ARG VIBE_BASE_IMAGE` and `ARG VIBE_BASE_IMAGE=<default>` both declare it;
  // the plan always passes the argument, so a default never decides the base.
  const name = rest.split("=")[0]?.trim();
  return name === VIBE_BASE_IMAGE_BUILD_ARG;
}

/** Whether a `FROM` instruction derives its image from the build argument. */
function derivesFromBaseImage(rest: string): boolean {
  const image = rest.split(/\s+/)[0] ?? "";
  return image === `\${${VIBE_BASE_IMAGE_BUILD_ARG}}` ||
    image === `$${VIBE_BASE_IMAGE_BUILD_ARG}`;
}

/**
 * Refuse an extension Containerfile that does not layer on the standard image.
 *
 * @param text - The operator's Containerfile, as read from the host
 * @param path - Its host path, named in every refusal
 * @throws When the file states no `FROM`, when anything other than `ARG`
 *   precedes the first one, when `ARG VIBE_BASE_IMAGE` is not declared before
 *   it, or when that `FROM` derives from anything else
 */
export function assertExtensionLayersOnBaseImage(
  text: string,
  path: string,
): void {
  const refuse = (detail: string): never => {
    throw new Error(
      `Refusing to launch: the container_extension Containerfile ${path} ` +
        `${detail}. It must open with \`ARG ${VIBE_BASE_IMAGE_BUILD_ARG}\` ` +
        `and \`FROM \${${VIBE_BASE_IMAGE_BUILD_ARG}}\` so the operator's ` +
        `layer is built on the standard Vibe Coder image (Issue #980).`,
    );
  };

  let declared = false;
  for (const directive of directives(text)) {
    if (directive.keyword === "FROM") {
      if (!declared) {
        refuse(
          `states no \`ARG ${VIBE_BASE_IMAGE_BUILD_ARG}\` before its ` +
            `first FROM`,
        );
      }
      if (!derivesFromBaseImage(directive.rest)) {
        refuse(
          `builds \`FROM ${directive.rest}\` rather than from the ` +
            `standard image`,
        );
      }
      return;
    }
    if (directive.keyword !== "ARG") {
      refuse(
        `states \`${directive.keyword}\` before its first FROM — only ARG ` +
          `may precede it`,
      );
    }
    if (declaresBaseImage(directive.rest)) declared = true;
  }

  refuse("states no FROM instruction at all");
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
    `${VIBE_BASE_IMAGE_BUILD_ARG}=${baseImage}`,
  ];
  // The start script's contract path (Issue #980): framework plumbing the
  // sandbox-start sub-issue reads back, never an operator-facing setting.
  if (spec.start !== undefined) {
    args.push("--build-arg", `${VIBE_EXTENSION_START_BUILD_ARG}=${spec.start}`);
  }
  args.push(directory);
  return args;
}
