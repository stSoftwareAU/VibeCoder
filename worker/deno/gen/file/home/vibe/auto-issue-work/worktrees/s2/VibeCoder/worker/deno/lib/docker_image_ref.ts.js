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
 */ /**
 * Characters a Docker image reference may contain, anchored so the first
 * character cannot be `-`.
 *
 * Deliberately conservative: alphanumerics plus the separators a real
 * reference needs (`.` `_` `-` `/` `:` `@`). Whitespace, shell
 * metacharacters, and the empty string are all rejected.
 */ const IMAGE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
/**
 * Check whether a Docker image reference is safe to pass as a positional.
 *
 * @param image - The configured image reference.
 * @returns true when the value is a plausible image reference.
 */ export function isSafeDockerImageRef(image) {
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
 */ export function buildDockerRunArgs(opts) {
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
    opts.command
  ];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kb2NrZXJfaW1hZ2VfcmVmLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRG9ja2VyIGltYWdlIHJlZmVyZW5jZSB2YWxpZGF0aW9uIChJc3N1ZSAjMzY2MSwgU0VDLTc2YzljM2U1YmFmNSkuXG4gKlxuICogVGhlIHF1YWxpdHkgZ2F0ZSBwYXNzZXMgdGhlIHBlci1yZXBvIGBkb2NrZXJfaW1hZ2VgIGNvbmZpZyB2YWx1ZSB0b1xuICogYGRvY2tlciBydW5gIGFzIGEgYmFyZSBwb3NpdGlvbmFsLiBEb2NrZXIgcGFyc2VzIGZsYWdzIHdpdGggcGZsYWcsIHNvIGFcbiAqIHZhbHVlIGJlZ2lubmluZyB3aXRoIGAtYCBpcyByZWFkIGFzIGFuIG9wdGlvbiwgbm90IGFuIGltYWdlOiBhXG4gKiBgLS1wcml2aWxlZ2VkYCBvciBgLXYgLzovaG9zdGAgZGlzZ3Vpc2VkIGFzIGFuIGltYWdlIG5hbWUgd291bGQgcnVuIHdpdGhcbiAqIHRoZSBkYWVtb24ncyBmdWxsIGF1dGhvcml0eS4gVGhlIHZhbHVlIGlzIG9wZXJhdG9yLWNvbmZpZy1zb3VyY2VkIHRvZGF5LFxuICogc28gbm8gdHJ1c3QgYm91bmRhcnkgaXMgY3Jvc3NlZCDigJQgdGhpcyBpcyB0aGUgc2FtZSBhcmd1bWVudC9vcHRpb25cbiAqIGluamVjdGlvbiBkZWZlbmNlLWluLWRlcHRoIHRoZSByZXBvIGFscmVhZHkgYXBwbGllcyB0byBnaXQgcmVmcyBpblxuICogYGdpdF9icmFuY2hfYXJncy50c2AgKElzc3VlICMyNzk4KS5cbiAqXG4gKiBUaGUgcmVqZWN0aW9uIGlzIGxvdWQ6IGNhbGxlcnMgc3VyZmFjZSBpdCBhcyBhIGZhaWxlZCBjaGVjayByYXRoZXIgdGhhblxuICogc2lsZW50bHkgc2tpcHBpbmcgdGhlIGNvbnRhaW5lciBydW4uXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuLyoqXG4gKiBDaGFyYWN0ZXJzIGEgRG9ja2VyIGltYWdlIHJlZmVyZW5jZSBtYXkgY29udGFpbiwgYW5jaG9yZWQgc28gdGhlIGZpcnN0XG4gKiBjaGFyYWN0ZXIgY2Fubm90IGJlIGAtYC5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgY29uc2VydmF0aXZlOiBhbHBoYW51bWVyaWNzIHBsdXMgdGhlIHNlcGFyYXRvcnMgYSByZWFsXG4gKiByZWZlcmVuY2UgbmVlZHMgKGAuYCBgX2AgYC1gIGAvYCBgOmAgYEBgKS4gV2hpdGVzcGFjZSwgc2hlbGxcbiAqIG1ldGFjaGFyYWN0ZXJzLCBhbmQgdGhlIGVtcHR5IHN0cmluZyBhcmUgYWxsIHJlamVjdGVkLlxuICovXG5jb25zdCBJTUFHRV9SRUZfUEFUVEVSTiA9IC9eW0EtWmEtejAtOV1bQS1aYS16MC05Ll86L0AtXSokLztcblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGEgRG9ja2VyIGltYWdlIHJlZmVyZW5jZSBpcyBzYWZlIHRvIHBhc3MgYXMgYSBwb3NpdGlvbmFsLlxuICpcbiAqIEBwYXJhbSBpbWFnZSAtIFRoZSBjb25maWd1cmVkIGltYWdlIHJlZmVyZW5jZS5cbiAqIEByZXR1cm5zIHRydWUgd2hlbiB0aGUgdmFsdWUgaXMgYSBwbGF1c2libGUgaW1hZ2UgcmVmZXJlbmNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTYWZlRG9ja2VySW1hZ2VSZWYoaW1hZ2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gSU1BR0VfUkVGX1BBVFRFUk4udGVzdChpbWFnZSk7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGBkb2NrZXIgcnVuYCBhcmd2IHdpdGggdGhlIGAtLWAgZW5kLW9mLW9wdGlvbnMgc2VwYXJhdG9yIGJlZm9yZVxuICogdGhlIGltYWdlIHJlZmVyZW5jZS5cbiAqXG4gKiBAcGFyYW0gb3B0cy5pbWFnZSAtIEltYWdlIHJlZmVyZW5jZSAodmFsaWRhdGUgd2l0aFxuICogICB7QGxpbmsgaXNTYWZlRG9ja2VySW1hZ2VSZWZ9IGZpcnN0KS5cbiAqIEBwYXJhbSBvcHRzLnVzZXJJZCAtIEhvc3QgdWlkIGZvciBgLS11c2VyYC5cbiAqIEBwYXJhbSBvcHRzLmdyb3VwSWQgLSBIb3N0IGdpZCBmb3IgYC0tdXNlcmAuXG4gKiBAcGFyYW0gb3B0cy5yZXBvUGF0aCAtIEhvc3QgcGF0aCBtb3VudGVkIGF0IGAvd29ya3NwYWNlYC5cbiAqIEBwYXJhbSBvcHRzLmNvbW1hbmQgLSBTaGVsbCBjb21tYW5kIHJ1biBpbnNpZGUgdGhlIGNvbnRhaW5lci5cbiAqIEByZXR1cm5zIFRoZSBmdWxsIGFyZ3VtZW50IGFycmF5LCBzdGFydGluZyB3aXRoIGBkb2NrZXJgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGREb2NrZXJSdW5BcmdzKG9wdHM6IHtcbiAgaW1hZ2U6IHN0cmluZztcbiAgdXNlcklkOiBzdHJpbmc7XG4gIGdyb3VwSWQ6IHN0cmluZztcbiAgcmVwb1BhdGg6IHN0cmluZztcbiAgY29tbWFuZDogc3RyaW5nO1xufSk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFtcbiAgICBcImRvY2tlclwiLFxuICAgIFwicnVuXCIsXG4gICAgXCItLXJtXCIsXG4gICAgXCItLXVzZXJcIixcbiAgICBgJHtvcHRzLnVzZXJJZH06JHtvcHRzLmdyb3VwSWR9YCxcbiAgICBcIi12XCIsXG4gICAgYCR7b3B0cy5yZXBvUGF0aH06L3dvcmtzcGFjZWAsXG4gICAgXCItd1wiLFxuICAgIFwiL3dvcmtzcGFjZVwiLFxuICAgIFwiLWVcIixcbiAgICBcIkNJPXRydWVcIixcbiAgICBcIi0tbmV0d29ya1wiLFxuICAgIFwiaG9zdFwiLFxuICAgIC8vIEV2ZXJ5dGhpbmcgYWZ0ZXIgYC0tYCBpcyBwb3NpdGlvbmFsLCBzbyBhbiBpbWFnZSByZWZlcmVuY2UgYmVnaW5uaW5nXG4gICAgLy8gd2l0aCBgLWAgY2FuIG5ldmVyIGJlIHBhcnNlZCBhcyBhIGRvY2tlciBmbGFnLlxuICAgIFwiLS1cIixcbiAgICBvcHRzLmltYWdlLFxuICAgIFwic2hcIixcbiAgICBcIi1jXCIsXG4gICAgb3B0cy5jb21tYW5kLFxuICBdO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7O0NBZ0JDLEdBRUQ7Ozs7Ozs7Q0FPQyxHQUNELE1BQU0sb0JBQW9CO0FBRTFCOzs7OztDQUtDLEdBQ0QsT0FBTyxTQUFTLHFCQUFxQixLQUFhO0VBQ2hELE9BQU8sa0JBQWtCLElBQUksQ0FBQztBQUNoQztBQUVBOzs7Ozs7Ozs7OztDQVdDLEdBQ0QsT0FBTyxTQUFTLG1CQUFtQixJQU1sQztFQUNDLE9BQU87SUFDTDtJQUNBO0lBQ0E7SUFDQTtJQUNBLEdBQUcsS0FBSyxNQUFNLENBQUMsQ0FBQyxFQUFFLEtBQUssT0FBTyxFQUFFO0lBQ2hDO0lBQ0EsR0FBRyxLQUFLLFFBQVEsQ0FBQyxXQUFXLENBQUM7SUFDN0I7SUFDQTtJQUNBO0lBQ0E7SUFDQTtJQUNBO0lBQ0EsdUVBQXVFO0lBQ3ZFLGlEQUFpRDtJQUNqRDtJQUNBLEtBQUssS0FBSztJQUNWO0lBQ0E7SUFDQSxLQUFLLE9BQU87R0FDYjtBQUNIIn0=
// denoCacheMetadata=14334263776392185536,5671890876575511823