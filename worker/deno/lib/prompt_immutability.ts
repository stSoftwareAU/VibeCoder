/**
 * The worker's own prompts must be unwritable at run time (Issue #1445).
 *
 * The prompt templates under `prompts/` are the worker's instructions to
 * itself. If the coding agent can edit the copy the worker READS, a single
 * successful injection rewrites how every later phase of that launch
 * behaves — and it never appears in a pull request diff, because the
 * repository's own `prompts/` is untouched. That is a different and worse
 * thing than an agent editing the prompts inside a repository CLONE, which
 * is the ordinary, reviewed way prompts change: a commit, a PR, a human.
 *
 * The container already arranges this. `container_launch.ts` mounts the
 * worker checkout read-only (Issue #514), `container/entrypoint.sh` stages
 * only `worker/deno` onto writable local storage and points the loader back
 * at the mount with `PROMPTS_DIR="${BASE_DIR}/prompts"`, so no writable copy
 * of `prompts/` exists inside the container at all.
 *
 * But that is three separate decisions in two files that happen to line up —
 * true by construction, not guaranteed. A future change to the staging block
 * that copies `prompts/` for convenience, or an operator pointing
 * `PROMPTS_DIR` at a writable directory, undoes it silently. This module
 * turns the property into a check that runs at start-up and refuses.
 *
 * ## Why it probes rather than reads the mode bits
 *
 * A read-only MOUNT does not change a file's mode: the directory can look
 * `drwxr-xr-x` and still reject every write with `EROFS`, and conversely a
 * mode that looks writable may be denied by an ACL. The only honest question
 * is whether a write actually succeeds, so the probe attempts one and removes
 * what it created. This is the same reasoning `container/entrypoint.sh`
 * applies to the untrusted account: test the thing that matters rather than a
 * proxy for it.
 *
 * ## Why it only refuses inside the container
 *
 * On a developer's machine the checkout is the operator's own working tree
 * and is legitimately writable — refusing there would make the worker
 * unrunnable outside a container for no security gain, because there is no
 * agent-versus-worker boundary on a host to begin with. The in-image signal
 * is `VIBE_IMAGE_AGENT_PROVIDERS`, the same one `claude_env.ts` already uses
 * to decide it is running inside the image, rather than a second signal that
 * could disagree with it.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

/** The in-image signal, shared with `claude_env.ts` so the two cannot drift. */
export const IN_IMAGE_ENV = "VIBE_IMAGE_AGENT_PROVIDERS";

/** Prefix of the throwaway file the probe writes. Dot-prefixed and unique. */
export const PROMPT_PROBE_PREFIX = ".vibe-prompt-immutability-probe-";

/** What the start-up check decided. */
export interface PromptImmutabilityVerdict {
  /** False only when the run must be refused. */
  ok: boolean;
  /** Operator-facing reason, present exactly when `ok` is false. */
  reason?: string;
}

/**
 * Decide whether a writable prompts directory is tolerable.
 *
 * Pure, so both branches are testable without a filesystem: inside the image
 * a writable prompts directory is a containment failure and the run is
 * refused; outside it, the checkout is the operator's own and is expected to
 * be writable.
 *
 * @param opts.writable - Whether a write into the prompts directory succeeded.
 * @param opts.inImage - Whether the worker is running inside the container image.
 * @param opts.promptsDir - Directory the verdict names, for the message.
 * @returns The verdict; `ok: false` carries the reason to report.
 */
export function classifyPromptsWritability(
  opts: { writable: boolean; inImage: boolean; promptsDir: string },
): PromptImmutabilityVerdict {
  if (!opts.writable) return { ok: true };
  if (!opts.inImage) return { ok: true };
  return {
    ok: false,
    reason: `the worker's prompt directory ${opts.promptsDir} is writable ` +
      `inside the container. The templates the worker reads to instruct ` +
      `itself must be on the read-only checkout mount (Issue #514), so that ` +
      `a prompt-injected agent cannot rewrite the instructions every later ` +
      `phase of this launch will follow — a change that would never appear ` +
      `in a pull request diff. Prompts are changed through a reviewed PR ` +
      `against the repository, never in place at run time. Check that ` +
      `PROMPTS_DIR still points inside the read-only checkout and that the ` +
      `entrypoint has not staged a writable copy of prompts/.`,
  };
}

/** Filesystem operations the probe needs. Injectable for tests. */
export interface PromptProbeDeps {
  writeTextFile(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const defaultProbeDeps: PromptProbeDeps = {
  writeTextFile: (path, data) => Deno.writeTextFile(path, data),
  remove: (path) => Deno.remove(path),
};

/**
 * Report whether a write into `promptsDir` succeeds.
 *
 * Creates a uniquely-named dot file and removes it again. A failed removal is
 * not treated as a writability failure — the write already answered the
 * question — but it is the caller's cue that something is odd, so the file
 * name is deliberately identifiable.
 *
 * @param promptsDir - Directory to probe.
 * @param deps - Filesystem seam (defaults to the real one).
 * @returns True when the directory accepted a write.
 */
export async function probePromptsWritable(
  promptsDir: string,
  deps: PromptProbeDeps = defaultProbeDeps,
): Promise<boolean> {
  const path = `${promptsDir}/${PROMPT_PROBE_PREFIX}${crypto.randomUUID()}`;
  try {
    await deps.writeTextFile(path, "");
  } catch {
    // EROFS, EACCES, ENOENT — none of them is a writable directory.
    return false;
  }
  try {
    await deps.remove(path);
  } catch {
    // Left behind, but the answer stands: the directory took the write.
  }
  return true;
}

/**
 * The start-up check: refuse a containerised run whose prompts are writable.
 *
 * @param promptsDir - The resolved prompts directory the worker will read.
 * @param env - Environment lookup, injected so the in-image branch is
 *   testable without mutating the process environment (Issue #880).
 * @param deps - Filesystem seam for the probe.
 * @returns The verdict; the caller aborts when `ok` is false.
 */
export async function checkPromptsImmutable(
  promptsDir: string,
  env: (name: string) => string | undefined,
  deps: PromptProbeDeps = defaultProbeDeps,
): Promise<PromptImmutabilityVerdict> {
  const writable = await probePromptsWritable(promptsDir, deps);
  return classifyPromptsWritability({
    writable,
    inImage: env(IN_IMAGE_ENV) !== undefined,
    promptsDir,
  });
}
