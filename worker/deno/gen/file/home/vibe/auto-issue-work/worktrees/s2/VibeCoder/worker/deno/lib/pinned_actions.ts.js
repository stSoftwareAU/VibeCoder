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
 * **The catalogue is the fallback floor, not the final emitted value**
 * (Issue #1823). `lib/action_pin_resolver.ts` resolves every `"release"`
 * entry against upstream's own release history and rewrites a rendered
 * template to the highest release that has cleared the supply-chain
 * quarantine window; the SHA recorded here is what survives when that lookup
 * cannot produce an answer, and every such fallback is logged. Only the
 * `"catalogue"` entries below are never looked up.
 *
 * That resolver is a library — `workflow-sync` is its intended caller and is
 * wired up separately (Issue #1755), so `pinnedAction()` below still renders
 * the catalogue SHA verbatim on its own.
 *
 * Bumping: change the SHA and the `version` label together, honouring the
 * supply-chain quarantine (Issue #1613) — do not adopt a release younger
 * than 24 hours. `worker/deno/tests/pinned_actions_test.ts` and
 * `worker/deno/tests/workflow_definitions_test.ts` assert that every
 * emitted `uses:` line resolves to a 40-character SHA, so a new template
 * cannot regress to a floating tag.
 */ /**
 * How an entry's emitted pin is chosen at sync time (Issue #1823).
 *
 * - `"release"` (the default) — resolve upstream's release history and emit
 *   the highest release past the quarantine window, falling back to the
 *   catalogue SHA with a logged reason.
 * - `"catalogue"` — emit the SHA recorded here verbatim. The action is never
 *   looked up and a fallback is never logged, because there is no stable
 *   release series to resolve against.
 */ /** Action coordinate (`owner/repo`) → immutable pin. */ export const PINNED_ACTIONS = {
  // Reused from this repository's own workflows (Issues #2316, #2317).
  "actions/checkout": {
    sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    version: "v7.0.1"
  },
  "actions/setup-node": {
    sha: "820762786026740c76f36085b0efc47a31fe5020",
    version: "v7.0.0"
  },
  "actions/upload-artifact": {
    sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    version: "v7.0.1"
  },
  "denoland/setup-deno": {
    sha: "667a34cdef165d8d2b2e98dde39547c9daac7282",
    version: "v2.0.4"
  },
  "gitleaks/gitleaks-action": {
    sha: "e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e",
    version: "v3.0.0"
  },
  // Latest upstream release at time of pinning.
  // Issue #1822: the one-off review against audit check 16 (a pinned action
  // a major behind the latest) found v5.6.0 behind upstream's v6 line. The
  // native check resolves "latest" from `github_actions_catalogue.ts`,
  // which still records `latestMajor: 4` here, so it would not have fired —
  // the finding is against real upstream state, and refreshing that
  // catalogue is its own change. v6.0.0 is the newest release outside the
  // 24h supply-chain quarantine (v6.0.1 published the same day); upstream
  // records the v6 ESM migration as not user-facing breaking, and the Java
  // template passes only `distribution:`/`java-version:`.
  "actions/setup-java": {
    sha: "dd06d9cba3e5552c54d9f8ea23572deb30010f7c",
    version: "v6.0.0"
  },
  "actions/dependency-review-action": {
    sha: "a1d282b36b6f3519aa1f3fc636f609c47dddb294",
    version: "v5.0.0"
  },
  // The ref no longer names the toolchain once pinned, so consumers must
  // pass an explicit `toolchain:` input (see the Rust templates).
  //
  // `"catalogue"`: upstream publishes exactly one release, the rolling `v1`
  // tag (published 2022-07-15) — no `MAJOR.MINOR.PATCH` release has ever been
  // cut, so the resolver has nothing to select and would log a fallback on
  // every sync. Verified against `gh api repos/dtolnay/rust-toolchain/releases`
  // (Issue #1823); revisit if upstream ever starts cutting semver releases.
  "dtolnay/rust-toolchain": {
    sha: "e97e2d8cc328f1b50210efc529dca0028893a2d9",
    version: "v1",
    resolution: "catalogue"
  },
  // The ref no longer names the tool once pinned, so consumers must pass
  // an explicit `tool:` input (see the Rust quality template).
  "taiki-e/install-action": {
    sha: "6a1bd70eaac3c8bdf093356838d7ee09fda951cf",
    version: "v2.85.5"
  },
  "codecov/codecov-action": {
    sha: "fb8b3582c8e4def4969c97caa2f19720cb33a72f",
    version: "v7.0.0"
  },
  "peter-evans/create-pull-request": {
    sha: "5f6978faf089d4d20b00c7766989d076bb2fc7f1",
    version: "v8.1.1"
  },
  // Branch HEAD: upstream's newest release (1.1.0, 2021) predates years of
  // fixes on the default branch that the previous `@main` ref picked up.
  "dependency-check/Dependency-Check_Action": {
    sha: "1e54355a8b4c8abaa8cc7d0b70aa655a3bb15a6c",
    version: "main HEAD 2025-12-10",
    resolution: "catalogue"
  },
  "ludeeus/action-shellcheck": {
    sha: "00b27aa7cb85167568cb48a3838b75f4265f2bca",
    version: "master HEAD 2024-06-20",
    resolution: "catalogue"
  }
};
/**
 * Semgrep container image digest.
 *
 * Kept identical to `.github/workflows/semgrep.yml` in this repository so a
 * hijacked `latest` tag cannot run in CI. No secret is passed to the Semgrep
 * job (Issue #4341). A test asserts the two references stay in lock-step.
 */ export const SEMGREP_IMAGE_DIGEST = "sha256:451b3d875c00dac7ed5db5293e584a07de11449a409c10b3c2d2652f429630b6";
/**
 * Release tag the digest was captured from (Issue #4403): a bare digest is
 * immutable but nothing can resolve a bump against it, so the reference
 * carries the tag too — `semgrep/semgrep:<tag>@<digest>` stays byte-for-byte
 * pinned AND trackable by an updater.
 */ export const SEMGREP_IMAGE_TAG = "1.182.1";
/** Fully-qualified, tag+digest-pinned Semgrep container image reference. */ export const SEMGREP_IMAGE = `semgrep/semgrep:${SEMGREP_IMAGE_TAG}@${SEMGREP_IMAGE_DIGEST}`;
/**
 * Checkov container image digest: the multi-arch OCI index (manifest-list)
 * digest of `bridgecrew/checkov:3.3.29`, resolved from the Docker Hub registry
 * on 2026-10-20. The tag was pushed 2026-10-13, so it is past the 24h
 * supply-chain quarantine (Issue #1613).
 */ export const CHECKOV_IMAGE_DIGEST = "sha256:3cc125b5337717b7303dbddd4e79374c120687b5ff6a24f9abdad56b562469f3";
/** Release tag the Checkov digest was resolved from. */ export const CHECKOV_IMAGE_TAG = "3.3.29";
/**
 * Fully-qualified, tag+digest-pinned Checkov container image reference. This
 * is the image the CI Checkov job and the local quality-gate stage run; the
 * scan args and pass/fail judge live in `checkov_report.ts`.
 */ export const CHECKOV_IMAGE = `bridgecrew/checkov:${CHECKOV_IMAGE_TAG}@${CHECKOV_IMAGE_DIGEST}`;
/**
 * Render a `uses:` value pinned to an immutable commit SHA, with the
 * human-readable version as a trailing YAML comment.
 *
 * Throws when the action has no pin, so a template can never silently fall
 * back to a mutable tag (fail loud — a missing pin is a defect, not a
 * default).
 */ export function pinnedAction(name) {
  const pin = PINNED_ACTIONS[name];
  if (!pin) {
    throw new Error(`No supply-chain pin recorded for "${name}". Add a 40-character ` + `commit SHA to PINNED_ACTIONS in worker/deno/lib/pinned_actions.ts ` + `(Issue #3645) — emitted workflows must never use a mutable ref.`);
  }
  return `${name}@${pin.sha} # ${pin.version}`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9waW5uZWRfYWN0aW9ucy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEltbXV0YWJsZSBwaW5zIGZvciB0aGUgdGhpcmQtcGFydHkgQ0kgY29tcG9uZW50cyByZWZlcmVuY2VkIGJ5IHRoZVxuICogd29ya2Zsb3cgdGVtcGxhdGVzIHRoaXMgd29ya2VyIGVtaXRzIGludG8gbWFuYWdlZCByZXBvc2l0b3JpZXMuXG4gKlxuICogSXNzdWUgIzM2NDU6IHRoZSBlbWl0dGVkIHRlbXBsYXRlcyByZWZlcmVuY2VkIGFjdGlvbnMgYnkgbXV0YWJsZSB0YWcgb3JcbiAqIGJyYW5jaCAoYEB2NGAsIGBAbWFpbmAsIGBAbWFzdGVyYCwgYEBzdGFibGVgKSBhbmQgdGhlIFNlbWdyZXAgY29udGFpbmVyXG4gKiBieSBhbiB1bnRhZ2dlZCBpbWFnZSwgc28gd2hvZXZlciBjb3VsZCBoaWphY2sgYW4gdXBzdHJlYW0gdGFnIOKAlCBvciBwdXNoXG4gKiB0byBhbiB1cHN0cmVhbSBkZWZhdWx0IGJyYW5jaCDigJQgb2J0YWluZWQgY29kZSBleGVjdXRpb24gaW4gZXZlcnkgbWFuYWdlZFxuICogcmVwb3NpdG9yeSB0aGF0IGFkb3B0ZWQgYSB0ZW1wbGF0ZSwgaW4gc2V2ZXJhbCBjYXNlcyB3aXRoIGFuIG9yZy1sZXZlbFxuICogUEFUIChgQUNUSU9OU19QVVNIYCkgb3IgYSBDSSB0b2tlbiBpbiBzY29wZS4gRXZlcnkgY29vcmRpbmF0ZSBpcyBub3dcbiAqIHBpbm5lZCB0byBhIDQwLWNoYXJhY3RlciBjb21taXQgU0hBIChjb250YWluZXJzIHRvIGFuIGltYWdlIGRpZ2VzdCkuXG4gKlxuICogU2VsZWN0aW9uIHJ1bGU6XG4gKiAtIFdoZXJlIHRoaXMgcmVwb3NpdG9yeSBhbHJlYWR5IHBpbnMgdGhlIHNhbWUgYWN0aW9uIGluIGl0cyBvd25cbiAqICAgYC5naXRodWIvd29ya2Zsb3dzL2AsIHJldXNlIHRoYXQgZXhhY3QgU0hBIOKAlCBvbmUgc291cmNlIG9mIHRydXRoLCBzb1xuICogICB0aGUgZW1pdHRlZCB0ZW1wbGF0ZSBhbmQgdGhlIGxvY2FsIHdvcmtmbG93IGNhbm5vdCBkcmlmdC5cbiAqIC0gT3RoZXJ3aXNlIHBpbiB0aGUgbGF0ZXN0IHVwc3RyZWFtIHJlbGVhc2UuXG4gKiAtIFdoZXJlIHRoZSB0ZW1wbGF0ZSB0cmFja2VkIGEgYnJhbmNoIGFuZCB1cHN0cmVhbSByZWxlYXNlcyBhcmUgc3RhbGUsXG4gKiAgIHBpbiB0aGF0IGJyYW5jaCdzIEhFQUQgc28gYmVoYXZpb3VyIGlzIHByZXNlcnZlZCB3aGlsZSB0aGUgcmVmZXJlbmNlXG4gKiAgIGJlY29tZXMgaW1tdXRhYmxlLlxuICpcbiAqICoqVGhlIGNhdGFsb2d1ZSBpcyB0aGUgZmFsbGJhY2sgZmxvb3IsIG5vdCB0aGUgZmluYWwgZW1pdHRlZCB2YWx1ZSoqXG4gKiAoSXNzdWUgIzE4MjMpLiBgbGliL2FjdGlvbl9waW5fcmVzb2x2ZXIudHNgIHJlc29sdmVzIGV2ZXJ5IGBcInJlbGVhc2VcImBcbiAqIGVudHJ5IGFnYWluc3QgdXBzdHJlYW0ncyBvd24gcmVsZWFzZSBoaXN0b3J5IGFuZCByZXdyaXRlcyBhIHJlbmRlcmVkXG4gKiB0ZW1wbGF0ZSB0byB0aGUgaGlnaGVzdCByZWxlYXNlIHRoYXQgaGFzIGNsZWFyZWQgdGhlIHN1cHBseS1jaGFpblxuICogcXVhcmFudGluZSB3aW5kb3c7IHRoZSBTSEEgcmVjb3JkZWQgaGVyZSBpcyB3aGF0IHN1cnZpdmVzIHdoZW4gdGhhdCBsb29rdXBcbiAqIGNhbm5vdCBwcm9kdWNlIGFuIGFuc3dlciwgYW5kIGV2ZXJ5IHN1Y2ggZmFsbGJhY2sgaXMgbG9nZ2VkLiBPbmx5IHRoZVxuICogYFwiY2F0YWxvZ3VlXCJgIGVudHJpZXMgYmVsb3cgYXJlIG5ldmVyIGxvb2tlZCB1cC5cbiAqXG4gKiBUaGF0IHJlc29sdmVyIGlzIGEgbGlicmFyeSDigJQgYHdvcmtmbG93LXN5bmNgIGlzIGl0cyBpbnRlbmRlZCBjYWxsZXIgYW5kIGlzXG4gKiB3aXJlZCB1cCBzZXBhcmF0ZWx5IChJc3N1ZSAjMTc1NSksIHNvIGBwaW5uZWRBY3Rpb24oKWAgYmVsb3cgc3RpbGwgcmVuZGVyc1xuICogdGhlIGNhdGFsb2d1ZSBTSEEgdmVyYmF0aW0gb24gaXRzIG93bi5cbiAqXG4gKiBCdW1waW5nOiBjaGFuZ2UgdGhlIFNIQSBhbmQgdGhlIGB2ZXJzaW9uYCBsYWJlbCB0b2dldGhlciwgaG9ub3VyaW5nIHRoZVxuICogc3VwcGx5LWNoYWluIHF1YXJhbnRpbmUgKElzc3VlICMxNjEzKSDigJQgZG8gbm90IGFkb3B0IGEgcmVsZWFzZSB5b3VuZ2VyXG4gKiB0aGFuIDI0IGhvdXJzLiBgd29ya2VyL2Rlbm8vdGVzdHMvcGlubmVkX2FjdGlvbnNfdGVzdC50c2AgYW5kXG4gKiBgd29ya2VyL2Rlbm8vdGVzdHMvd29ya2Zsb3dfZGVmaW5pdGlvbnNfdGVzdC50c2AgYXNzZXJ0IHRoYXQgZXZlcnlcbiAqIGVtaXR0ZWQgYHVzZXM6YCBsaW5lIHJlc29sdmVzIHRvIGEgNDAtY2hhcmFjdGVyIFNIQSwgc28gYSBuZXcgdGVtcGxhdGVcbiAqIGNhbm5vdCByZWdyZXNzIHRvIGEgZmxvYXRpbmcgdGFnLlxuICovXG5cbi8qKlxuICogSG93IGFuIGVudHJ5J3MgZW1pdHRlZCBwaW4gaXMgY2hvc2VuIGF0IHN5bmMgdGltZSAoSXNzdWUgIzE4MjMpLlxuICpcbiAqIC0gYFwicmVsZWFzZVwiYCAodGhlIGRlZmF1bHQpIOKAlCByZXNvbHZlIHVwc3RyZWFtJ3MgcmVsZWFzZSBoaXN0b3J5IGFuZCBlbWl0XG4gKiAgIHRoZSBoaWdoZXN0IHJlbGVhc2UgcGFzdCB0aGUgcXVhcmFudGluZSB3aW5kb3csIGZhbGxpbmcgYmFjayB0byB0aGVcbiAqICAgY2F0YWxvZ3VlIFNIQSB3aXRoIGEgbG9nZ2VkIHJlYXNvbi5cbiAqIC0gYFwiY2F0YWxvZ3VlXCJgIOKAlCBlbWl0IHRoZSBTSEEgcmVjb3JkZWQgaGVyZSB2ZXJiYXRpbS4gVGhlIGFjdGlvbiBpcyBuZXZlclxuICogICBsb29rZWQgdXAgYW5kIGEgZmFsbGJhY2sgaXMgbmV2ZXIgbG9nZ2VkLCBiZWNhdXNlIHRoZXJlIGlzIG5vIHN0YWJsZVxuICogICByZWxlYXNlIHNlcmllcyB0byByZXNvbHZlIGFnYWluc3QuXG4gKi9cbmV4cG9ydCB0eXBlIEFjdGlvblBpblJlc29sdXRpb24gPSBcInJlbGVhc2VcIiB8IFwiY2F0YWxvZ3VlXCI7XG5cbi8qKiBBbiBpbW11dGFibGUgcGluOiB0aGUgY29tbWl0IFNIQSBwbHVzIHRoZSBodW1hbi1yZWFkYWJsZSB2ZXJzaW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBY3Rpb25QaW4ge1xuICAvKiogNDAtY2hhcmFjdGVyIGxvd2VyY2FzZSBoZXggY29tbWl0IFNIQS4gKi9cbiAgc2hhOiBzdHJpbmc7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBsYWJlbCByZW5kZXJlZCBhcyBhIHRyYWlsaW5nIFlBTUwgY29tbWVudC4gKi9cbiAgdmVyc2lvbjogc3RyaW5nO1xuICAvKiogUmVzb2x1dGlvbiBzdHJhdGVneTsgYWJzZW50IG1lYW5zIHtAbGluayBBY3Rpb25QaW5SZXNvbHV0aW9ufSBgXCJyZWxlYXNlXCJgLiAqL1xuICByZXNvbHV0aW9uPzogQWN0aW9uUGluUmVzb2x1dGlvbjtcbn1cblxuLyoqIEFjdGlvbiBjb29yZGluYXRlIChgb3duZXIvcmVwb2ApIOKGkiBpbW11dGFibGUgcGluLiAqL1xuZXhwb3J0IGNvbnN0IFBJTk5FRF9BQ1RJT05TOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBBY3Rpb25QaW4+PiA9IHtcbiAgLy8gUmV1c2VkIGZyb20gdGhpcyByZXBvc2l0b3J5J3Mgb3duIHdvcmtmbG93cyAoSXNzdWVzICMyMzE2LCAjMjMxNykuXG4gIFwiYWN0aW9ucy9jaGVja291dFwiOiB7XG4gICAgc2hhOiBcIjNkM2M0MmU1YWFjNWJhODA1ODI1ZGE3NjQxMGMxODEyNzNiYTkwYjFcIixcbiAgICB2ZXJzaW9uOiBcInY3LjAuMVwiLFxuICB9LFxuICBcImFjdGlvbnMvc2V0dXAtbm9kZVwiOiB7XG4gICAgc2hhOiBcIjgyMDc2Mjc4NjAyNjc0MGM3NmYzNjA4NWIwZWZjNDdhMzFmZTUwMjBcIixcbiAgICB2ZXJzaW9uOiBcInY3LjAuMFwiLFxuICB9LFxuICBcImFjdGlvbnMvdXBsb2FkLWFydGlmYWN0XCI6IHtcbiAgICBzaGE6IFwiMDQzZmI0NmQxYTkzYzc3YWFlNjU2ZTdjMWM2NGE4NzVkMWZjNmEwYVwiLFxuICAgIHZlcnNpb246IFwidjcuMC4xXCIsXG4gIH0sXG4gIFwiZGVub2xhbmQvc2V0dXAtZGVub1wiOiB7XG4gICAgc2hhOiBcIjY2N2EzNGNkZWYxNjVkOGQyYjJlOThkZGUzOTU0N2M5ZGFhYzcyODJcIixcbiAgICB2ZXJzaW9uOiBcInYyLjAuNFwiLFxuICB9LFxuICBcImdpdGxlYWtzL2dpdGxlYWtzLWFjdGlvblwiOiB7XG4gICAgc2hhOiBcImUwYzQ3ZjRmOGJlMzZlMjljZGMxMDJjNTdlNjhjYjVjYmYwZThkMWVcIixcbiAgICB2ZXJzaW9uOiBcInYzLjAuMFwiLFxuICB9LFxuICAvLyBMYXRlc3QgdXBzdHJlYW0gcmVsZWFzZSBhdCB0aW1lIG9mIHBpbm5pbmcuXG4gIC8vIElzc3VlICMxODIyOiB0aGUgb25lLW9mZiByZXZpZXcgYWdhaW5zdCBhdWRpdCBjaGVjayAxNiAoYSBwaW5uZWQgYWN0aW9uXG4gIC8vIGEgbWFqb3IgYmVoaW5kIHRoZSBsYXRlc3QpIGZvdW5kIHY1LjYuMCBiZWhpbmQgdXBzdHJlYW0ncyB2NiBsaW5lLiBUaGVcbiAgLy8gbmF0aXZlIGNoZWNrIHJlc29sdmVzIFwibGF0ZXN0XCIgZnJvbSBgZ2l0aHViX2FjdGlvbnNfY2F0YWxvZ3VlLnRzYCxcbiAgLy8gd2hpY2ggc3RpbGwgcmVjb3JkcyBgbGF0ZXN0TWFqb3I6IDRgIGhlcmUsIHNvIGl0IHdvdWxkIG5vdCBoYXZlIGZpcmVkIOKAlFxuICAvLyB0aGUgZmluZGluZyBpcyBhZ2FpbnN0IHJlYWwgdXBzdHJlYW0gc3RhdGUsIGFuZCByZWZyZXNoaW5nIHRoYXRcbiAgLy8gY2F0YWxvZ3VlIGlzIGl0cyBvd24gY2hhbmdlLiB2Ni4wLjAgaXMgdGhlIG5ld2VzdCByZWxlYXNlIG91dHNpZGUgdGhlXG4gIC8vIDI0aCBzdXBwbHktY2hhaW4gcXVhcmFudGluZSAodjYuMC4xIHB1Ymxpc2hlZCB0aGUgc2FtZSBkYXkpOyB1cHN0cmVhbVxuICAvLyByZWNvcmRzIHRoZSB2NiBFU00gbWlncmF0aW9uIGFzIG5vdCB1c2VyLWZhY2luZyBicmVha2luZywgYW5kIHRoZSBKYXZhXG4gIC8vIHRlbXBsYXRlIHBhc3NlcyBvbmx5IGBkaXN0cmlidXRpb246YC9gamF2YS12ZXJzaW9uOmAuXG4gIFwiYWN0aW9ucy9zZXR1cC1qYXZhXCI6IHtcbiAgICBzaGE6IFwiZGQwNmQ5Y2JhM2U1NTUyYzU0ZDlmOGVhMjM1NzJkZWIzMDAxMGY3Y1wiLFxuICAgIHZlcnNpb246IFwidjYuMC4wXCIsXG4gIH0sXG4gIFwiYWN0aW9ucy9kZXBlbmRlbmN5LXJldmlldy1hY3Rpb25cIjoge1xuICAgIHNoYTogXCJhMWQyODJiMzZiNmYzNTE5YWExZjNmYzYzNmY2MDljNDdkZGRiMjk0XCIsXG4gICAgdmVyc2lvbjogXCJ2NS4wLjBcIixcbiAgfSxcbiAgLy8gVGhlIHJlZiBubyBsb25nZXIgbmFtZXMgdGhlIHRvb2xjaGFpbiBvbmNlIHBpbm5lZCwgc28gY29uc3VtZXJzIG11c3RcbiAgLy8gcGFzcyBhbiBleHBsaWNpdCBgdG9vbGNoYWluOmAgaW5wdXQgKHNlZSB0aGUgUnVzdCB0ZW1wbGF0ZXMpLlxuICAvL1xuICAvLyBgXCJjYXRhbG9ndWVcImA6IHVwc3RyZWFtIHB1Ymxpc2hlcyBleGFjdGx5IG9uZSByZWxlYXNlLCB0aGUgcm9sbGluZyBgdjFgXG4gIC8vIHRhZyAocHVibGlzaGVkIDIwMjItMDctMTUpIOKAlCBubyBgTUFKT1IuTUlOT1IuUEFUQ0hgIHJlbGVhc2UgaGFzIGV2ZXIgYmVlblxuICAvLyBjdXQsIHNvIHRoZSByZXNvbHZlciBoYXMgbm90aGluZyB0byBzZWxlY3QgYW5kIHdvdWxkIGxvZyBhIGZhbGxiYWNrIG9uXG4gIC8vIGV2ZXJ5IHN5bmMuIFZlcmlmaWVkIGFnYWluc3QgYGdoIGFwaSByZXBvcy9kdG9sbmF5L3J1c3QtdG9vbGNoYWluL3JlbGVhc2VzYFxuICAvLyAoSXNzdWUgIzE4MjMpOyByZXZpc2l0IGlmIHVwc3RyZWFtIGV2ZXIgc3RhcnRzIGN1dHRpbmcgc2VtdmVyIHJlbGVhc2VzLlxuICBcImR0b2xuYXkvcnVzdC10b29sY2hhaW5cIjoge1xuICAgIHNoYTogXCJlOTdlMmQ4Y2MzMjhmMWI1MDIxMGVmYzUyOWRjYTAwMjg4OTNhMmQ5XCIsXG4gICAgdmVyc2lvbjogXCJ2MVwiLFxuICAgIHJlc29sdXRpb246IFwiY2F0YWxvZ3VlXCIsXG4gIH0sXG4gIC8vIFRoZSByZWYgbm8gbG9uZ2VyIG5hbWVzIHRoZSB0b29sIG9uY2UgcGlubmVkLCBzbyBjb25zdW1lcnMgbXVzdCBwYXNzXG4gIC8vIGFuIGV4cGxpY2l0IGB0b29sOmAgaW5wdXQgKHNlZSB0aGUgUnVzdCBxdWFsaXR5IHRlbXBsYXRlKS5cbiAgXCJ0YWlraS1lL2luc3RhbGwtYWN0aW9uXCI6IHtcbiAgICBzaGE6IFwiNmExYmQ3MGVhYWMzYzhiZGYwOTMzNTY4MzhkN2VlMDlmZGE5NTFjZlwiLFxuICAgIHZlcnNpb246IFwidjIuODUuNVwiLFxuICB9LFxuICBcImNvZGVjb3YvY29kZWNvdi1hY3Rpb25cIjoge1xuICAgIHNoYTogXCJmYjhiMzU4MmM4ZTRkZWY0OTY5Yzk3Y2FhMmYxOTcyMGNiMzNhNzJmXCIsXG4gICAgdmVyc2lvbjogXCJ2Ny4wLjBcIixcbiAgfSxcbiAgXCJwZXRlci1ldmFucy9jcmVhdGUtcHVsbC1yZXF1ZXN0XCI6IHtcbiAgICBzaGE6IFwiNWY2OTc4ZmFmMDg5ZDRkMjBiMDBjNzc2Njk4OWQwNzZiYjJmYzdmMVwiLFxuICAgIHZlcnNpb246IFwidjguMS4xXCIsXG4gIH0sXG4gIC8vIEJyYW5jaCBIRUFEOiB1cHN0cmVhbSdzIG5ld2VzdCByZWxlYXNlICgxLjEuMCwgMjAyMSkgcHJlZGF0ZXMgeWVhcnMgb2ZcbiAgLy8gZml4ZXMgb24gdGhlIGRlZmF1bHQgYnJhbmNoIHRoYXQgdGhlIHByZXZpb3VzIGBAbWFpbmAgcmVmIHBpY2tlZCB1cC5cbiAgXCJkZXBlbmRlbmN5LWNoZWNrL0RlcGVuZGVuY3ktQ2hlY2tfQWN0aW9uXCI6IHtcbiAgICBzaGE6IFwiMWU1NDM1NWE4YjRjOGFiYWE4Y2M3ZDBiNzBhYTY1NWEzYmIxNWE2Y1wiLFxuICAgIHZlcnNpb246IFwibWFpbiBIRUFEIDIwMjUtMTItMTBcIixcbiAgICByZXNvbHV0aW9uOiBcImNhdGFsb2d1ZVwiLFxuICB9LFxuICBcImx1ZGVldXMvYWN0aW9uLXNoZWxsY2hlY2tcIjoge1xuICAgIHNoYTogXCIwMGIyN2FhN2NiODUxNjc1NjhjYjQ4YTM4MzhiNzVmNDI2NWYyYmNhXCIsXG4gICAgdmVyc2lvbjogXCJtYXN0ZXIgSEVBRCAyMDI0LTA2LTIwXCIsXG4gICAgcmVzb2x1dGlvbjogXCJjYXRhbG9ndWVcIixcbiAgfSxcbn07XG5cbi8qKlxuICogU2VtZ3JlcCBjb250YWluZXIgaW1hZ2UgZGlnZXN0LlxuICpcbiAqIEtlcHQgaWRlbnRpY2FsIHRvIGAuZ2l0aHViL3dvcmtmbG93cy9zZW1ncmVwLnltbGAgaW4gdGhpcyByZXBvc2l0b3J5IHNvIGFcbiAqIGhpamFja2VkIGBsYXRlc3RgIHRhZyBjYW5ub3QgcnVuIGluIENJLiBObyBzZWNyZXQgaXMgcGFzc2VkIHRvIHRoZSBTZW1ncmVwXG4gKiBqb2IgKElzc3VlICM0MzQxKS4gQSB0ZXN0IGFzc2VydHMgdGhlIHR3byByZWZlcmVuY2VzIHN0YXkgaW4gbG9jay1zdGVwLlxuICovXG5leHBvcnQgY29uc3QgU0VNR1JFUF9JTUFHRV9ESUdFU1QgPVxuICBcInNoYTI1Njo0NTFiM2Q4NzVjMDBkYWM3ZWQ1ZGI1MjkzZTU4NGEwN2RlMTE0NDlhNDA5YzEwYjNjMmQyNjUyZjQyOTYzMGI2XCI7XG5cbi8qKlxuICogUmVsZWFzZSB0YWcgdGhlIGRpZ2VzdCB3YXMgY2FwdHVyZWQgZnJvbSAoSXNzdWUgIzQ0MDMpOiBhIGJhcmUgZGlnZXN0IGlzXG4gKiBpbW11dGFibGUgYnV0IG5vdGhpbmcgY2FuIHJlc29sdmUgYSBidW1wIGFnYWluc3QgaXQsIHNvIHRoZSByZWZlcmVuY2VcbiAqIGNhcnJpZXMgdGhlIHRhZyB0b28g4oCUIGBzZW1ncmVwL3NlbWdyZXA6PHRhZz5APGRpZ2VzdD5gIHN0YXlzIGJ5dGUtZm9yLWJ5dGVcbiAqIHBpbm5lZCBBTkQgdHJhY2thYmxlIGJ5IGFuIHVwZGF0ZXIuXG4gKi9cbmV4cG9ydCBjb25zdCBTRU1HUkVQX0lNQUdFX1RBRyA9IFwiMS4xODIuMVwiO1xuXG4vKiogRnVsbHktcXVhbGlmaWVkLCB0YWcrZGlnZXN0LXBpbm5lZCBTZW1ncmVwIGNvbnRhaW5lciBpbWFnZSByZWZlcmVuY2UuICovXG5leHBvcnQgY29uc3QgU0VNR1JFUF9JTUFHRSA9XG4gIGBzZW1ncmVwL3NlbWdyZXA6JHtTRU1HUkVQX0lNQUdFX1RBR31AJHtTRU1HUkVQX0lNQUdFX0RJR0VTVH1gO1xuXG4vKipcbiAqIENoZWNrb3YgY29udGFpbmVyIGltYWdlIGRpZ2VzdDogdGhlIG11bHRpLWFyY2ggT0NJIGluZGV4IChtYW5pZmVzdC1saXN0KVxuICogZGlnZXN0IG9mIGBicmlkZ2VjcmV3L2NoZWNrb3Y6My4zLjI5YCwgcmVzb2x2ZWQgZnJvbSB0aGUgRG9ja2VyIEh1YiByZWdpc3RyeVxuICogb24gMjAyNi0xMC0yMC4gVGhlIHRhZyB3YXMgcHVzaGVkIDIwMjYtMTAtMTMsIHNvIGl0IGlzIHBhc3QgdGhlIDI0aFxuICogc3VwcGx5LWNoYWluIHF1YXJhbnRpbmUgKElzc3VlICMxNjEzKS5cbiAqL1xuZXhwb3J0IGNvbnN0IENIRUNLT1ZfSU1BR0VfRElHRVNUID1cbiAgXCJzaGEyNTY6M2NjMTI1YjUzMzc3MTdiNzMwM2RiZGRkNGU3OTM3NGMxMjA2ODdiNWZmNmEyNGY5YWJkYWQ1NmI1NjI0NjlmM1wiO1xuXG4vKiogUmVsZWFzZSB0YWcgdGhlIENoZWNrb3YgZGlnZXN0IHdhcyByZXNvbHZlZCBmcm9tLiAqL1xuZXhwb3J0IGNvbnN0IENIRUNLT1ZfSU1BR0VfVEFHID0gXCIzLjMuMjlcIjtcblxuLyoqXG4gKiBGdWxseS1xdWFsaWZpZWQsIHRhZytkaWdlc3QtcGlubmVkIENoZWNrb3YgY29udGFpbmVyIGltYWdlIHJlZmVyZW5jZS4gVGhpc1xuICogaXMgdGhlIGltYWdlIHRoZSBDSSBDaGVja292IGpvYiBhbmQgdGhlIGxvY2FsIHF1YWxpdHktZ2F0ZSBzdGFnZSBydW47IHRoZVxuICogc2NhbiBhcmdzIGFuZCBwYXNzL2ZhaWwganVkZ2UgbGl2ZSBpbiBgY2hlY2tvdl9yZXBvcnQudHNgLlxuICovXG5leHBvcnQgY29uc3QgQ0hFQ0tPVl9JTUFHRSA9XG4gIGBicmlkZ2VjcmV3L2NoZWNrb3Y6JHtDSEVDS09WX0lNQUdFX1RBR31AJHtDSEVDS09WX0lNQUdFX0RJR0VTVH1gO1xuXG4vKipcbiAqIFJlbmRlciBhIGB1c2VzOmAgdmFsdWUgcGlubmVkIHRvIGFuIGltbXV0YWJsZSBjb21taXQgU0hBLCB3aXRoIHRoZVxuICogaHVtYW4tcmVhZGFibGUgdmVyc2lvbiBhcyBhIHRyYWlsaW5nIFlBTUwgY29tbWVudC5cbiAqXG4gKiBUaHJvd3Mgd2hlbiB0aGUgYWN0aW9uIGhhcyBubyBwaW4sIHNvIGEgdGVtcGxhdGUgY2FuIG5ldmVyIHNpbGVudGx5IGZhbGxcbiAqIGJhY2sgdG8gYSBtdXRhYmxlIHRhZyAoZmFpbCBsb3VkIOKAlCBhIG1pc3NpbmcgcGluIGlzIGEgZGVmZWN0LCBub3QgYVxuICogZGVmYXVsdCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwaW5uZWRBY3Rpb24obmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcGluID0gUElOTkVEX0FDVElPTlNbbmFtZV07XG4gIGlmICghcGluKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYE5vIHN1cHBseS1jaGFpbiBwaW4gcmVjb3JkZWQgZm9yIFwiJHtuYW1lfVwiLiBBZGQgYSA0MC1jaGFyYWN0ZXIgYCArXG4gICAgICAgIGBjb21taXQgU0hBIHRvIFBJTk5FRF9BQ1RJT05TIGluIHdvcmtlci9kZW5vL2xpYi9waW5uZWRfYWN0aW9ucy50cyBgICtcbiAgICAgICAgYChJc3N1ZSAjMzY0NSkg4oCUIGVtaXR0ZWQgd29ya2Zsb3dzIG11c3QgbmV2ZXIgdXNlIGEgbXV0YWJsZSByZWYuYCxcbiAgICApO1xuICB9XG4gIHJldHVybiBgJHtuYW1lfUAke3Bpbi5zaGF9ICMgJHtwaW4udmVyc2lvbn1gO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1Q0MsR0FFRDs7Ozs7Ozs7O0NBU0MsR0FhRCxzREFBc0QsR0FDdEQsT0FBTyxNQUFNLGlCQUFzRDtFQUNqRSxxRUFBcUU7RUFDckUsb0JBQW9CO0lBQ2xCLEtBQUs7SUFDTCxTQUFTO0VBQ1g7RUFDQSxzQkFBc0I7SUFDcEIsS0FBSztJQUNMLFNBQVM7RUFDWDtFQUNBLDJCQUEyQjtJQUN6QixLQUFLO0lBQ0wsU0FBUztFQUNYO0VBQ0EsdUJBQXVCO0lBQ3JCLEtBQUs7SUFDTCxTQUFTO0VBQ1g7RUFDQSw0QkFBNEI7SUFDMUIsS0FBSztJQUNMLFNBQVM7RUFDWDtFQUNBLDhDQUE4QztFQUM5QywwRUFBMEU7RUFDMUUseUVBQXlFO0VBQ3pFLHFFQUFxRTtFQUNyRSwwRUFBMEU7RUFDMUUsa0VBQWtFO0VBQ2xFLHdFQUF3RTtFQUN4RSx3RUFBd0U7RUFDeEUseUVBQXlFO0VBQ3pFLHdEQUF3RDtFQUN4RCxzQkFBc0I7SUFDcEIsS0FBSztJQUNMLFNBQVM7RUFDWDtFQUNBLG9DQUFvQztJQUNsQyxLQUFLO0lBQ0wsU0FBUztFQUNYO0VBQ0EsdUVBQXVFO0VBQ3ZFLGdFQUFnRTtFQUNoRSxFQUFFO0VBQ0YsMEVBQTBFO0VBQzFFLDRFQUE0RTtFQUM1RSx5RUFBeUU7RUFDekUsOEVBQThFO0VBQzlFLDBFQUEwRTtFQUMxRSwwQkFBMEI7SUFDeEIsS0FBSztJQUNMLFNBQVM7SUFDVCxZQUFZO0VBQ2Q7RUFDQSx1RUFBdUU7RUFDdkUsNkRBQTZEO0VBQzdELDBCQUEwQjtJQUN4QixLQUFLO0lBQ0wsU0FBUztFQUNYO0VBQ0EsMEJBQTBCO0lBQ3hCLEtBQUs7SUFDTCxTQUFTO0VBQ1g7RUFDQSxtQ0FBbUM7SUFDakMsS0FBSztJQUNMLFNBQVM7RUFDWDtFQUNBLHlFQUF5RTtFQUN6RSx1RUFBdUU7RUFDdkUsNENBQTRDO0lBQzFDLEtBQUs7SUFDTCxTQUFTO0lBQ1QsWUFBWTtFQUNkO0VBQ0EsNkJBQTZCO0lBQzNCLEtBQUs7SUFDTCxTQUFTO0lBQ1QsWUFBWTtFQUNkO0FBQ0YsRUFBRTtBQUVGOzs7Ozs7Q0FNQyxHQUNELE9BQU8sTUFBTSx1QkFDWCwwRUFBMEU7QUFFNUU7Ozs7O0NBS0MsR0FDRCxPQUFPLE1BQU0sb0JBQW9CLFVBQVU7QUFFM0MsMEVBQTBFLEdBQzFFLE9BQU8sTUFBTSxnQkFDWCxDQUFDLGdCQUFnQixFQUFFLGtCQUFrQixDQUFDLEVBQUUsc0JBQXNCLENBQUM7QUFFakU7Ozs7O0NBS0MsR0FDRCxPQUFPLE1BQU0sdUJBQ1gsMEVBQTBFO0FBRTVFLHNEQUFzRCxHQUN0RCxPQUFPLE1BQU0sb0JBQW9CLFNBQVM7QUFFMUM7Ozs7Q0FJQyxHQUNELE9BQU8sTUFBTSxnQkFDWCxDQUFDLG1CQUFtQixFQUFFLGtCQUFrQixDQUFDLEVBQUUsc0JBQXNCLENBQUM7QUFFcEU7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sU0FBUyxhQUFhLElBQVk7RUFDdkMsTUFBTSxNQUFNLGNBQWMsQ0FBQyxLQUFLO0VBQ2hDLElBQUksQ0FBQyxLQUFLO0lBQ1IsTUFBTSxJQUFJLE1BQ1IsQ0FBQyxrQ0FBa0MsRUFBRSxLQUFLLHNCQUFzQixDQUFDLEdBQy9ELENBQUMsa0VBQWtFLENBQUMsR0FDcEUsQ0FBQywrREFBK0QsQ0FBQztFQUV2RTtFQUNBLE9BQU8sR0FBRyxLQUFLLENBQUMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxPQUFPLEVBQUU7QUFDOUMifQ==
// denoCacheMetadata=12224697152912830317,17375603589957766392