# PR summary: verify chromium-headless-shell and ffmpeg zips baked by the Containerfile (Issue #3256)

## Summary

Closes #3256.

`playwright-core install --with-deps chromium` fetched three blobs, but only the
Chromium zip had a committed SHA-256 (Issue #274). The chromium-headless-shell
and ffmpeg zips were baked into the image unverified.

- [x] `container/tools.json` pins `headless_shell_amd64`, `headless_shell_arm64`,
      `ffmpeg_amd64` and `ffmpeg_arm64` for playwright-core
      `1.61.0-alpha-1778188671000`.
- [x] `container/Containerfile` restates them as
      `PLAYWRIGHT_SHA256_HEADLESS_SHELL_*` and `PLAYWRIGHT_SHA256_FFMPEG_*` ARGs.
      It downloads all three zips with `sha256sum -c`, unpacks each into the
      revision directory Playwright expects and writes `INSTALLATION_COMPLETE`.
      The `install --with-deps chromium` that follows then only adds the apt
      dependencies.
- [x] `findBrowserInstallViolations` in `worker/deno/lib/container_manifest.ts`
      is driven by a `BROWSER_BLOBS` table. It reports a missing tools.json key
      and an ARG that no non-`ARG` line verifies, for each of the three blobs.
- [x] `docs/CONTAINER-IMAGE.md`, `docs/CONTAINER.md` and
      `docs/audits/dependency-inventory.md` describe the three verified blobs.

## Spec

### Intent and Rationale

A default `chromium.launch()` runs the headless shell, not full Chromium, and
ffmpeg ships with every browser install. Both are executable code in the image,
so each needs the same committed-digest check the Chromium zip already has.

### Essential Design Decisions

- Option (a) from the issue: pin and verify the two extra zips. `--no-shell`
  was rejected because it still installs ffmpeg unverified and changes what
  `chromium.launch()` runs.
- The validator is table-driven (`BROWSER_BLOBS`), so a fourth blob is one entry
  rather than another copy of the check.

### Undiscoverable Facts

- Playwright names revision directories with `_` for `-`
  (`chromium_headless_shell-1224`, `ffmpeg-1011`) and treats a directory as
  installed only when `INSTALLATION_COMPLETE` exists.
- Per `browsers.json` and the `coreBundle.js` download table: on debian13-x64 the
  headless shell is the Chrome for Testing
  `linux64/chrome-headless-shell-linux64.zip` (v149.0.7827.3), and ffmpeg is
  `builds/ffmpeg/1011/ffmpeg-linux.zip`. On debian13-arm64 they are
  `builds/chromium/1224/chromium-headless-shell-linux-arm64.zip` and
  `builds/ffmpeg/1011/ffmpeg-linux-arm64.zip`.
- Mirror order is `cdn.playwright.dev/dbazure/download/playwright`, then the
  ESRP CDN, then `cdn.playwright.dev`. The bytes are identical, so one digest
  covers all mirrors.

## Evidence

- `sha256sum` of each downloaded zip matches the committed value:
  `chrome-headless-shell-linux64.zip` `1f56c33a…`,
  `chromium-headless-shell-linux-arm64.zip` `4cd3d333…`,
  `ffmpeg-linux.zip` `ebc74fc5…`, `ffmpeg-linux-arm64.zip` `2628c03f…`.
- `zipinfo` shows the executables the bake checks with `test -x` are
  `-rwxr-xr-x`: `chrome-headless-shell-linux64/chrome-headless-shell`,
  `chrome-linux/headless_shell` and `ffmpeg-linux` in both ffmpeg zips.
- `timeout 900 ./quality.sh < /dev/null`: exit 0, "Result: PASSED (with skipped
  checks)". Only the config integration check was skipped.

**Docs sweep** — grep:
`CHROMIUM_SHA_KEYS|Chromium zip|headless.?shell|ffmpeg|chromium_amd64|PLAYWRIGHT_SHA256_CHROMIUM|install --with-deps`
(excluding `docs/archive`); section: browser bake; updated:
`docs/CONTAINER-IMAGE.md`, `docs/CONTAINER.md`,
`docs/audits/dependency-inventory.md`, the `findBrowserInstallViolations` doc
comment; `docs/CONTAINER-IMAGE.md:266` — still true because
`install --with-deps` still installs the apt dependency set.
`CHROMIUM_SHA_KEYS` has no remaining references.

## Test Plan

- Added four tests to `worker/deno/tests/container_manifest_test.ts`: missing
  `headless_shell_amd64`, missing `ffmpeg_arm64`, and a bake that never verifies
  the headless-shell or ffmpeg checksum.
- `deno task test:unit tests/container_manifest_test.ts` (from `worker/deno`):
  144 passed, 0 failed. `deno fmt --check`, `deno lint` and `deno check` are
  clean.
- Red on base: the head test file was run against the base branch's
  `container_manifest.ts`, and all four new tests failed.
- No assertion was removed from an existing test.

**Branch outcomes:**

- `worker/deno/lib/container_manifest.ts:1090` — key omitted (headless shell) — `worker/deno/tests/container_manifest_test.ts::findBrowserInstallViolations - reports a playwright-core pin missing headless_shell_amd64 (Issue #3256)` — red on base
- `worker/deno/lib/container_manifest.ts:1090` — key omitted (ffmpeg) — `worker/deno/tests/container_manifest_test.ts::findBrowserInstallViolations - reports a playwright-core pin missing ffmpeg_arm64 (Issue #3256)` — red on base
- `worker/deno/lib/container_manifest.ts:1090` — all keys present — `worker/deno/tests/container_manifest_test.ts::container/ - the committed image bakes Playwright's headless Chromium` — the committed tools.json passes clean
- `worker/deno/lib/container_manifest.ts:1125` — ARG never verified (headless shell) — `worker/deno/tests/container_manifest_test.ts::findBrowserInstallViolations - reports a bake that never verifies the headless-shell checksum (Issue #3256)` — red on base
- `worker/deno/lib/container_manifest.ts:1125` — ARG never verified (ffmpeg) — `worker/deno/tests/container_manifest_test.ts::findBrowserInstallViolations - reports a bake that never verifies the ffmpeg checksum (Issue #3256)` — red on base
- `worker/deno/lib/container_manifest.ts:1125` — ARG verified — `worker/deno/tests/container_manifest_test.ts::container/ - the committed image bakes Playwright's headless Chromium` — the committed Containerfile passes clean
