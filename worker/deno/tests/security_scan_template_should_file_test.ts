/**
 * Tests for `security-scan` template's `shouldFile` veto (Issues #2056, #2063).
 *
 * The security-scan template refuses to queue a fresh idle-task run while
 * any open scanner-filed findings remain in the target repo — that would
 * pile a new scan on top of a batch of un-triaged results. Once every
 * previous finding is closed (resolved or suppressed) the template lets
 * the next scan through.
 *
 * Issue #2063 dropped the blanket `security` label, so the gate now keys
 * off the hidden `<!-- finding-id: SEC-… -->` body marker that every
 * scanner-filed issue still carries.
 *
 * The tests inject a gh stub via `createSecurityScanTemplate` so they
 * never touch the network.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

import { createSecurityScanTemplate } from "../lib/idle_task_templates/security_scan_template.ts";

function makeGhStub(opts: {
  open: number;
  capture?: { args: string[][] };
}): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    if (opts.capture) opts.capture.args.push([...args]);
    if (args[0] === "issue" && args[1] === "list") {
      // Reproduce the structure `gh issue list --json number,body` returns,
      // including a body that carries the canonical finding-id marker so
      // the body-based gate (#2063) actually recognises it.
      const items = Array.from({ length: opts.open }).map((_, i) => ({
        number: i + 1,
        body: `<!-- finding-id: SEC-stubbody${String(i).padStart(4, "0")} -->`,
      }));
      return Promise.resolve(JSON.stringify(items));
    }
    return Promise.resolve("[]");
  };
}

Deno.test(
  "security-scan template - shouldFile returns false when open security findings exist",
  async () => {
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: () =>
        Promise.reject(new Error("must not invoke scanner from shouldFile")),
      ghCommandFn: makeGhStub({ open: 3 }),
    });
    assert(tpl.shouldFile !== undefined, "template must implement shouldFile");
    const ok = await tpl.shouldFile({ repo: "org/repo" });
    assertEquals(
      ok,
      false,
      "should refuse to queue while previous findings are open",
    );
  },
);

Deno.test(
  "security-scan template - shouldFile returns true when no open security findings exist",
  async () => {
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: () =>
        Promise.reject(new Error("must not invoke scanner from shouldFile")),
      ghCommandFn: makeGhStub({ open: 0 }),
    });
    assert(tpl.shouldFile !== undefined);
    const ok = await tpl.shouldFile({ repo: "org/repo" });
    assertEquals(ok, true, "should queue when the previous batch is cleared");
  },
);

Deno.test(
  "security-scan template - shouldFile queries gh by body marker and by wrapper title (#2063, #2077)",
  async () => {
    const capture = { args: [] as string[][] };
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: () =>
        Promise.reject(new Error("must not invoke scanner from shouldFile")),
      ghCommandFn: makeGhStub({ open: 0, capture }),
    });
    assert(tpl.shouldFile !== undefined);
    await tpl.shouldFile({ repo: "org/some-repo" });

    // Issue #2077: two gh calls — one for outstanding findings, one
    // for an open wrapper titled `Run a security scan` (dedup gate).
    assertEquals(capture.args.length, 2, "expected two gh invocations");
    for (const args of capture.args) {
      assertEquals(args[0], "issue");
      assertEquals(args[1], "list");
      const repoIdx = args.indexOf("--repo");
      assertEquals(args[repoIdx + 1], "org/some-repo");
      const stateIdx = args.indexOf("--state");
      assertEquals(args[stateIdx + 1], "open");
      // Issue #2063: the finding gate no longer queries by the
      // blanket `security` label.
      assertEquals(args.indexOf("--label"), -1, "must not query by --label");
    }
    const searches = capture.args.map((a) => a[a.indexOf("--search") + 1]);
    assert(
      searches.includes("SEC- in:body"),
      `missing finding search: ${searches}`,
    );
    assert(
      searches.some((s) => s?.includes("Run a security scan")),
      `missing wrapper-title search: ${searches}`,
    );
  },
);

Deno.test(
  "security-scan template - shouldFile returns false when a wrapper is already open (Issue #2077)",
  async () => {
    // Stub gh to return zero open findings, but one open wrapper
    // matching the title.
    const ghCommandFn = (args: string[]): Promise<string> => {
      const searchIdx = args.indexOf("--search");
      const query = args[searchIdx + 1] ?? "";
      if (query.includes("SEC- in:body")) return Promise.resolve("[]");
      if (query.includes("Run a security scan")) {
        return Promise.resolve(JSON.stringify([
          { number: 71, title: "Run a security scan" },
        ]));
      }
      return Promise.resolve("[]");
    };
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: () =>
        Promise.reject(new Error("must not invoke scanner from shouldFile")),
      ghCommandFn,
    });
    assert(tpl.shouldFile !== undefined);
    const ok = await tpl.shouldFile({ repo: "org/repo" });
    assertEquals(
      ok,
      false,
      "must refuse to queue a fresh wrapper while a previous one is open",
    );
  },
);

Deno.test(
  "security-scan template - shouldFile ignores wrapper hits whose title does not match exactly (Issue #2077)",
  async () => {
    // GitHub's `in:title` returns issues that merely contain the
    // phrase. The gate must re-filter to an exact title match so a
    // prose-mention issue does not block scanning.
    const ghCommandFn = (args: string[]): Promise<string> => {
      const searchIdx = args.indexOf("--search");
      const query = args[searchIdx + 1] ?? "";
      if (query.includes("SEC- in:body")) return Promise.resolve("[]");
      if (query.includes("Run a security scan")) {
        return Promise.resolve(JSON.stringify([
          { number: 71, title: "Please run a security scan on my fork" },
        ]));
      }
      return Promise.resolve("[]");
    };
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: () =>
        Promise.reject(new Error("must not invoke scanner from shouldFile")),
      ghCommandFn,
    });
    assert(tpl.shouldFile !== undefined);
    const ok = await tpl.shouldFile({ repo: "org/repo" });
    assertEquals(
      ok,
      true,
      "loose `in:title` hits must not block scanning",
    );
  },
);

Deno.test(
  "security-scan template - shouldFile ignores prose mentions of `SEC-` without the body marker",
  async () => {
    // GitHub's `in:body` search returns issues that merely mention
    // `SEC-` in prose. The gate must re-filter to the canonical
    // `<!-- finding-id: SEC-… -->` marker so an unrelated issue does
    // not stall the scanner indefinitely.
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: () =>
        Promise.reject(new Error("must not invoke scanner from shouldFile")),
      ghCommandFn: () =>
        Promise.resolve(JSON.stringify([
          { number: 42, body: "We mention SEC-12345 here but no marker." },
        ])),
    });
    assert(tpl.shouldFile !== undefined);
    const ok = await tpl.shouldFile({ repo: "org/repo" });
    assertEquals(
      ok,
      true,
      "incidental SEC- mentions must not block scanning",
    );
  },
);

Deno.test(
  "security-scan template - shouldFile treats malformed gh JSON as no findings",
  async () => {
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: () =>
        Promise.reject(new Error("must not invoke scanner from shouldFile")),
      ghCommandFn: () => Promise.resolve("not json"),
    });
    assert(tpl.shouldFile !== undefined);
    const ok = await tpl.shouldFile({ repo: "org/repo" });
    assertEquals(
      ok,
      true,
      "malformed JSON must not block scanning indefinitely",
    );
  },
);

Deno.test(
  "security-scan template - declares outputLabel = 'security' for the backlog gate (Issue #2082)",
  () => {
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: () =>
        Promise.reject(new Error("not invoked in this test")),
      ghCommandFn: () => Promise.resolve("[]"),
      loadPromptFn: () => Promise.resolve({ ok: true, value: "stub" }),
    });
    assertEquals(
      tpl.outputLabel,
      "security",
      "filed findings carry the `security` label; the backlog gate counts open issues with that label",
    );
  },
);

Deno.test(
  "security-scan template - matchesIdleTaskBody recognises the prompt fingerprint (Issue #2087)",
  () => {
    const tpl = createSecurityScanTemplate({
      runSecurityScanFn: () =>
        Promise.reject(new Error("not invoked in this test")),
      ghCommandFn: () => Promise.resolve("[]"),
      loadPromptFn: () => Promise.resolve({ ok: true, value: "stub" }),
    });
    assert(
      tpl.matchesIdleTaskBody !== undefined,
      "template must declare matchesIdleTaskBody",
    );
    // Positive: a body containing the canonical H1 heading is a match.
    assertEquals(
      tpl.matchesIdleTaskBody!(
        "# MythOS-style Security Audit — Four-Phase Scan (v2)\n\nYou are a security auditor...",
      ),
      true,
    );
    // Positive: heading-level variation (H2/H3) still matches — the
    // regex is anchored to `^#+ ` so prompt revisions that adjust the
    // heading depth continue to be detected.
    assertEquals(
      tpl.matchesIdleTaskBody!(
        "## MythOS-style Security Audit — Phase 2 follow-up\n\nbody",
      ),
      true,
    );
    // Negative (Issue #2118): prose mentions of the fingerprint must
    // NOT match. Meta-issues that quote the phrase while discussing the
    // guard (e.g. VibeCoder#2098, #2093) were previously misrouted
    // through `idle_task_guard` and refused.
    assertEquals(
      tpl.matchesIdleTaskBody!(
        "## Suggested next scans\n\nSome MythOS-style Security Audit follow-up.",
      ),
      false,
    );
    // Negative (Issue #2118): a quoted mention inside a Markdown
    // blockquote (common in meta-issues citing the prompt) must not match.
    assertEquals(
      tpl.matchesIdleTaskBody!(
        "We refer to the `MythOS-style Security Audit` H1 in #2087.",
      ),
      false,
    );
    // Negative: an unrelated issue body must not match.
    assertEquals(
      tpl.matchesIdleTaskBody!(
        "Fix the date parser to handle ISO-8601 inputs.",
      ),
      false,
    );
    // Negative: empty body must not match.
    assertEquals(tpl.matchesIdleTaskBody!(""), false);
  },
);
