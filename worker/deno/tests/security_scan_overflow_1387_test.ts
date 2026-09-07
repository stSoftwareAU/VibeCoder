/**
 * Regression tests for the security-scan overflow findings (Issue #1387).
 *
 * Each block reproduces one finding from the tracker: the assertions fail
 * against the pre-fix code and pass after it. Every test calls the real
 * function with real data — none inspect source text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";

import { createDefaultProbeDeps } from "../lib/references_source_probe.ts";
import {
  containsSecret,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";

// ---------------------------------------------------------------------------
// SEC-e3b7a2f95c14 — SSRF: a REFERENCES.md row could point the page probe at
// a loopback, link-local or RFC-1918 address.
// ---------------------------------------------------------------------------

Deno.test("SEC-e3b7a2f95c14 - the page probe refuses a loopback source URL", async () => {
  const { fetchTextFn } = createDefaultProbeDeps();
  // Refused on shape, so no socket is opened and no permission is needed.
  const error = await assertRejects(
    () => fetchTextFn("https://127.0.0.1/x"),
    Error,
  );
  assert(error.message.includes("private address"), error.message);
});

Deno.test("SEC-e3b7a2f95c14 - the page probe refuses the cloud metadata address", async () => {
  const { fetchTextFn } = createDefaultProbeDeps();
  const error = await assertRejects(
    () => fetchTextFn("https://169.254.169.254/latest/meta-data/"),
    Error,
  );
  assert(error.message.includes("private address"), error.message);
});

Deno.test("SEC-e3b7a2f95c14 - the page probe refuses a non-HTTPS source URL", async () => {
  const { fetchTextFn } = createDefaultProbeDeps();
  const error = await assertRejects(
    () => fetchTextFn("http://example.com/"),
    Error,
  );
  assert(error.message.includes("non-HTTPS"), error.message);
});

Deno.test("SEC-e3b7a2f95c14 - the page probe refuses an intranet hostname", async () => {
  const { fetchTextFn } = createDefaultProbeDeps();
  const error = await assertRejects(
    () => fetchTextFn("https://vault.internal/"),
    Error,
  );
  assert(error.message.includes("intranet host"), error.message);
});

// ---------------------------------------------------------------------------
// SEC-08c4f1a7e2b9 — secret-redaction gap: a bare 32-hex credential (the
// ImgBB API key shape) carried no signature rule.
// ---------------------------------------------------------------------------

const IMGBB_SHAPED_KEY = "0123456789abcdef0123456789abcdef";

Deno.test("SEC-08c4f1a7e2b9 - redacts a bare 32-hex credential", () => {
  const out = redactSecrets(`upload failed for key ${IMGBB_SHAPED_KEY} (401)`);
  assertEquals(out.includes(IMGBB_SHAPED_KEY), false, out);
  assert(out.includes(REDACTION_PLACEHOLDER), out);
  // The surrounding text is untouched.
  assert(out.includes("upload failed for key"), out);
  assert(out.includes("(401)"), out);
});

Deno.test("SEC-08c4f1a7e2b9 - the bare key is detected by containsSecret", () => {
  assertEquals(containsSecret(IMGBB_SHAPED_KEY), true);
});

Deno.test("SEC-08c4f1a7e2b9 - redacts the key inside an ImgBB upload URL", () => {
  const out = redactSecrets(
    `https://api.imgbb.com/1/upload?key=${IMGBB_SHAPED_KEY}&name=x`,
  );
  assertEquals(out.includes(IMGBB_SHAPED_KEY), false, out);
  assert(out.includes("api.imgbb.com"), out);
});

Deno.test("SEC-08c4f1a7e2b9 - leaves longer hex runs alone", () => {
  // A 40-hex git SHA and a 64-hex sha256 digest are not credentials, and the
  // worker logs both constantly.
  const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4";
  const digest =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  assertEquals(redactSecrets(`commit ${sha}`), `commit ${sha}`);
  assertEquals(redactSecrets(`sha256:${digest}`), `sha256:${digest}`);
});

Deno.test("SEC-08c4f1a7e2b9 - leaves a dashed UUID and ordinary prose alone", () => {
  const line = "run 3f2504e0-4f89-11d3-9a0c-0305e82c3301 finished in 32s";
  assertEquals(redactSecrets(line), line);
});
