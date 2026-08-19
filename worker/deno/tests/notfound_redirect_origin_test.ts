/**
 * Behavioural tests for the README.md → README.html redirect in `404.html`.
 * Issue #3666.
 *
 * The redirect builds its destination from `window.location.pathname`. Browsers
 * preserve a leading `//` in `pathname`, so an unanchored rewrite turns
 * `//evil.example/README.md` into the protocol-relative URL
 * `//evil.example/README.html`, which navigates off-origin (CWE-601).
 *
 * These tests execute the real inline script from `404.html` against a stubbed
 * `window.location` and assert on where it actually navigates.
 */

import { assert, assertEquals } from "@std/assert";

/** Resolve the repository root (two levels up from worker/deno/tests). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

const NOTFOUND_PATH = `${repoRoot()}404.html`;

/** Extract the single inline <script> body from 404.html. */
async function redirectScript(): Promise<string> {
  const page = await Deno.readTextFile(NOTFOUND_PATH);
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assertEquals(
    scripts.length,
    1,
    "404.html must have exactly one inline script",
  );
  return scripts[0]?.[1] ?? "";
}

/**
 * Run the redirect script with `window.location` derived from `href`.
 * Returns the value passed to `location.replace`, or null if it did not navigate.
 */
function runRedirect(script: string, href: string): string | null {
  const loc = new URL(href);
  let replaced: string | null = null;
  const fakeWindow = {
    location: {
      pathname: loc.pathname,
      search: loc.search,
      hash: loc.hash,
      origin: loc.origin,
      replace: (target: string) => {
        replaced = target;
      },
    },
  };
  new Function("window", script)(fakeWindow);
  return replaced;
}

const SITE = "https://stsoftwareau.github.io";

Deno.test("404.html redirect rewrites a normal README.md path", async () => {
  const script = await redirectScript();
  const target = runRedirect(script, `${SITE}/VibeCoder/docs/README.md`);
  assertEquals(target, "/VibeCoder/docs/README.html");
});

Deno.test("404.html redirect preserves query string and fragment", async () => {
  const script = await redirectScript();
  const target = runRedirect(
    script,
    `${SITE}/VibeCoder/docs/README.md?tab=two#section`,
  );
  assertEquals(target, "/VibeCoder/docs/README.html?tab=two#section");
});

Deno.test("404.html redirect ignores paths that are not README.md", async () => {
  const script = await redirectScript();
  assertEquals(runRedirect(script, `${SITE}/VibeCoder/docs/guide.html`), null);
  assertEquals(runRedirect(script, `${SITE}/VibeCoder/README.markdown`), null);
});

Deno.test("404.html redirect never navigates off-origin", async () => {
  const script = await redirectScript();
  // Each href yields an attacker-controlled `pathname`: a leading `//` (or `/\`,
  // which browsers normalise to `//` in special URLs) makes the naive rewrite
  // protocol-relative.
  const hostile = [
    `${SITE}//evil.example/README.md`,
    `${SITE}//evil.example/docs/README.md?a=1#b`,
    `${SITE}/\\evil.example/README.md`,
    `${SITE}///evil.example/README.md`,
  ];

  for (const href of hostile) {
    const target = runRedirect(script, href);
    if (target === null) continue; // refusing to navigate is a valid outcome
    const resolved = new URL(target, SITE);
    assertEquals(
      resolved.origin,
      SITE,
      `redirect for ${href} must stay on the site origin, got ${resolved.href}`,
    );
    assert(
      !resolved.hostname.includes("evil.example"),
      `redirect for ${href} must not reach evil.example`,
    );
  }
});
