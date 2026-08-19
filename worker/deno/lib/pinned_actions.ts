/**
 * Immutable pins for the third-party CI components referenced by the
 * workflow templates this worker emits into managed repositories.
 *
 * Issue #3645: the emitted templates referenced actions by mutable tag or
 * branch (`@v4`, `@main`, `@master`, `@stable`) and the Semgrep container
 * by an untagged image, so whoever could hijack an upstream tag — or push
 * to an upstream default branch — obtained code execution in every managed
 * repository that adopted a template, in several cases with an org-level
 * PAT (`ACTIONS_PUSH`) or a CI token in scope. Every coordinate is now
 * pinned to a 40-character commit SHA (containers to an image digest).
 *
 * Selection rule:
 * - Where this repository already pins the same action in its own
 *   `.github/workflows/`, reuse that exact SHA — one source of truth, so
 *   the emitted template and the local workflow cannot drift.
 * - Otherwise pin the latest upstream release.
 * - Where the template tracked a branch and upstream releases are stale,
 *   pin that branch's HEAD so behaviour is preserved while the reference
 *   becomes immutable.
 *
 * Bumping: change the SHA and the `version` label together, honouring the
 * supply-chain quarantine (Issue #1613) — do not adopt a release younger
 * than 24 hours. `worker/deno/tests/pinned_actions_test.ts` and
 * `worker/deno/tests/workflow_definitions_test.ts` assert that every
 * emitted `uses:` line resolves to a 40-character SHA, so a new template
 * cannot regress to a floating tag.
 */

/** An immutable pin: the commit SHA plus the human-readable version. */
export interface ActionPin {
  /** 40-character lowercase hex commit SHA. */
  sha: string;
  /** Human-readable label rendered as a trailing YAML comment. */
  version: string;
}

/** Action coordinate (`owner/repo`) → immutable pin. */
export const PINNED_ACTIONS: Readonly<Record<string, ActionPin>> = {
  // Reused from this repository's own workflows (Issues #2316, #2317).
  "actions/checkout": {
    sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    version: "v7.0.1",
  },
  "actions/setup-node": {
    sha: "820762786026740c76f36085b0efc47a31fe5020",
    version: "v7.0.0",
  },
  "actions/upload-artifact": {
    sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    version: "v7.0.1",
  },
  "denoland/setup-deno": {
    sha: "667a34cdef165d8d2b2e98dde39547c9daac7282",
    version: "v2.0.4",
  },
  "gitleaks/gitleaks-action": {
    sha: "e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e",
    version: "v3.0.0",
  },
  // Latest upstream release at time of pinning.
  "actions/setup-java": {
    sha: "03ad4de0992f5dab5e18fcb136590ce7c4a0ac95",
    version: "v5.6.0",
  },
  "actions/dependency-review-action": {
    sha: "a1d282b36b6f3519aa1f3fc636f609c47dddb294",
    version: "v5.0.0",
  },
  // The ref no longer names the toolchain once pinned, so consumers must
  // pass an explicit `toolchain:` input (see the Rust templates).
  "dtolnay/rust-toolchain": {
    sha: "e97e2d8cc328f1b50210efc529dca0028893a2d9",
    version: "v1",
  },
  // The ref no longer names the tool once pinned, so consumers must pass
  // an explicit `tool:` input (see the Rust quality template).
  "taiki-e/install-action": {
    sha: "6a1bd70eaac3c8bdf093356838d7ee09fda951cf",
    version: "v2.85.5",
  },
  "codecov/codecov-action": {
    sha: "fb8b3582c8e4def4969c97caa2f19720cb33a72f",
    version: "v7.0.0",
  },
  "peter-evans/create-pull-request": {
    sha: "5f6978faf089d4d20b00c7766989d076bb2fc7f1",
    version: "v8.1.1",
  },
  // Branch HEAD: upstream's newest release (1.1.0, 2021) predates years of
  // fixes on the default branch that the previous `@main` ref picked up.
  "dependency-check/Dependency-Check_Action": {
    sha: "1e54355a8b4c8abaa8cc7d0b70aa655a3bb15a6c",
    version: "main HEAD 2025-12-10",
  },
  "ludeeus/action-shellcheck": {
    sha: "00b27aa7cb85167568cb48a3838b75f4265f2bca",
    version: "master HEAD 2024-06-20",
  },
};

/**
 * Semgrep container image digest.
 *
 * Kept identical to `.github/workflows/semgrep.yml` in this repository so a
 * hijacked `latest` tag cannot run with `SEMGREP_APP_TOKEN` in scope. A
 * test asserts the two references stay in lock-step.
 */
export const SEMGREP_IMAGE_DIGEST =
  "sha256:67319956da3dcb58baf5b322899c15458e3963e7018a86aeeb5cd224e69cb77a";

/**
 * Release tag the digest was captured from (Issue #4403): a bare digest is
 * immutable but nothing can resolve a bump against it, so the reference
 * carries the tag too — `semgrep/semgrep:<tag>@<digest>` stays byte-for-byte
 * pinned AND trackable by an updater.
 */
export const SEMGREP_IMAGE_TAG = "1.173.0";

/** Fully-qualified, tag+digest-pinned Semgrep container image reference. */
export const SEMGREP_IMAGE =
  `semgrep/semgrep:${SEMGREP_IMAGE_TAG}@${SEMGREP_IMAGE_DIGEST}`;

/**
 * Render a `uses:` value pinned to an immutable commit SHA, with the
 * human-readable version as a trailing YAML comment.
 *
 * Throws when the action has no pin, so a template can never silently fall
 * back to a mutable tag (fail loud — a missing pin is a defect, not a
 * default).
 */
export function pinnedAction(name: string): string {
  const pin = PINNED_ACTIONS[name];
  if (!pin) {
    throw new Error(
      `No supply-chain pin recorded for "${name}". Add a 40-character ` +
        `commit SHA to PINNED_ACTIONS in worker/deno/lib/pinned_actions.ts ` +
        `(Issue #3645) — emitted workflows must never use a mutable ref.`,
    );
  }
  return `${name}@${pin.sha} # ${pin.version}`;
}
