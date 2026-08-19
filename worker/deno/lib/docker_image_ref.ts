/**
 * Docker image reference validation (Issue #3661, SEC-76c9c3e5baf5).
 *
 * The quality gate passes the per-repo `docker_image` config value to
 * `docker run` as a bare positional. Docker parses flags with pflag, so a
 * value beginning with `-` is read as an option, not an image: a
 * `--privileged` or `-v /:/host` disguised as an image name would run with
 * the daemon's full authority. The value is operator-config-sourced today,
 * so no trust boundary is crossed — this is the same argument/option
 * injection defence-in-depth the repo already applies to git refs in
 * `git_branch_args.ts` (Issue #2798).
 *
 * The rejection is loud: callers surface it as a failed check rather than
 * silently skipping the container run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Characters a Docker image reference may contain, anchored so the first
 * character cannot be `-`.
 *
 * Deliberately conservative: alphanumerics plus the separators a real
 * reference needs (`.` `_` `-` `/` `:` `@`). Whitespace, shell
 * metacharacters, and the empty string are all rejected.
 */
const IMAGE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/**
 * Check whether a Docker image reference is safe to pass as a positional.
 *
 * @param image - The configured image reference.
 * @returns true when the value is a plausible image reference.
 */
export function isSafeDockerImageRef(image: string): boolean {
  return IMAGE_REF_PATTERN.test(image);
}

/**
 * Build the `docker run` argv with the `--` end-of-options separator before
 * the image reference.
 *
 * @param opts.image - Image reference (validate with
 *   {@link isSafeDockerImageRef} first).
 * @param opts.userId - Host uid for `--user`.
 * @param opts.groupId - Host gid for `--user`.
 * @param opts.repoPath - Host path mounted at `/workspace`.
 * @param opts.command - Shell command run inside the container.
 * @returns The full argument array, starting with `docker`.
 */
export function buildDockerRunArgs(opts: {
  image: string;
  userId: string;
  groupId: string;
  repoPath: string;
  command: string;
}): string[] {
  return [
    "docker",
    "run",
    "--rm",
    "--user",
    `${opts.userId}:${opts.groupId}`,
    "-v",
    `${opts.repoPath}:/workspace`,
    "-w",
    "/workspace",
    "-e",
    "CI=true",
    "--network",
    "host",
    // Everything after `--` is positional, so an image reference beginning
    // with `-` can never be parsed as a docker flag.
    "--",
    opts.image,
    "sh",
    "-c",
    opts.command,
  ];
}
