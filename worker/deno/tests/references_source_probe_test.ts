/**
 * Tests for Issue #665 — the per-source probes behind the references refresh
 * sweep.
 *
 * A probe answers one question about one credited source: "what does its
 * material look like right now, and what has landed since we last took from
 * it?" GitHub repositories are probed through `gh api` (head commit, then a
 * commit range); every other source is probed by fetching the page and
 * fingerprinting its visible text.
 *
 * Australian English spelling used throughout (behaviour, normalise).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ReferenceEntry } from "../lib/references_doc.ts";
import {
  groupChangedPaths,
  normalisePageText,
  parseGitHubRepo,
  type ProbeDeps,
  probeReferenceSource,
} from "../lib/references_source_probe.ts";

function entry(url: string): ReferenceEntry {
  return {
    name: "Test source",
    url,
    note: "Something we took",
    usedIn: ["README.md"],
  };
}

/** Deps that fail loud unless the test supplies the call it expects. */
function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    ghCommandFn: (args) => {
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    },
    fetchTextFn: (url) => {
      throw new Error(`unexpected fetch: ${url}`);
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// URL classification
// ---------------------------------------------------------------------------

Deno.test("parseGitHubRepo reads owner and repo from a repository URL", () => {
  assertEquals(parseGitHubRepo("https://github.com/mattpocock/skills"), {
    owner: "mattpocock",
    repo: "skills",
  });
});

Deno.test("parseGitHubRepo tolerates a trailing path and .git suffix", () => {
  assertEquals(
    parseGitHubRepo("https://github.com/github/spec-kit/tree/main"),
    {
      owner: "github",
      repo: "spec-kit",
    },
  );
  assertEquals(parseGitHubRepo("https://github.com/github/spec-kit.git"), {
    owner: "github",
    repo: "spec-kit",
  });
});

Deno.test("parseGitHubRepo returns null for a non-repository URL", () => {
  assertEquals(parseGitHubRepo("https://owasp.org/Top10/2025/"), null);
  assertEquals(parseGitHubRepo("https://github.com/mattpocock"), null);
  assertEquals(parseGitHubRepo("https://docs.github.com/en/actions"), null);
});

// ---------------------------------------------------------------------------
// Grouping changed paths into units of material
// ---------------------------------------------------------------------------

Deno.test("groupChangedPaths groups files under their containing directory", () => {
  const units = groupChangedPaths([
    "skills/engineering/code-review/SKILL.md",
    "skills/engineering/code-review/rubric.md",
    "skills/productivity/grilling/SKILL.md",
  ]);

  assertEquals([...units.keys()], [
    "skills/engineering/code-review",
    "skills/productivity/grilling",
  ]);
  assertEquals(units.get("skills/engineering/code-review"), [
    "skills/engineering/code-review/SKILL.md",
    "skills/engineering/code-review/rubric.md",
  ]);
});

Deno.test("groupChangedPaths caps a unit at three path segments", () => {
  const units = groupChangedPaths([
    "a/b/c/d/e/one.md",
    "a/b/c/d/f/two.md",
  ]);

  assertEquals([...units.keys()], ["a/b/c"]);
});

Deno.test("groupChangedPaths keeps a root-level file as its own unit", () => {
  const units = groupChangedPaths(["README.md", "CHANGELOG.md"]);

  assertEquals([...units.keys()], ["CHANGELOG.md", "README.md"]);
});

// ---------------------------------------------------------------------------
// Page normalisation
// ---------------------------------------------------------------------------

Deno.test("normalisePageText drops scripts, styles, comments and markup", () => {
  const text = normalisePageText(
    "<html><head><style>a{colour:red}</style>" +
      "<script>var nonce='abc123'</script></head>" +
      "<body><!-- build 4711 --><h1>Rule  2</h1>\n<p>Nothing is fetched.</p>" +
      "</body></html>",
  );

  assertEquals(text, "Rule 2 Nothing is fetched.");
});

Deno.test("normalisePageText ignores whitespace-only differences", () => {
  assertEquals(
    normalisePageText("<p>one</p>\n\n<p>two</p>"),
    normalisePageText("<p>one</p><p>two</p>"),
  );
});

// ---------------------------------------------------------------------------
// GitHub repository probe
// ---------------------------------------------------------------------------

/** A gh stub answering the two head-commit calls, then the compare call. */
function ghStub(head: string, compare?: unknown) {
  const calls: string[][] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push(args);
    const endpoint = args[1] ?? "";
    if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) {
      return Promise.resolve(JSON.stringify({ default_branch: "main" }));
    }
    if (endpoint.includes("/commits/")) {
      return Promise.resolve(JSON.stringify({ sha: head }));
    }
    if (endpoint.includes("/compare/")) {
      if (compare === undefined) throw new Error("unexpected compare call");
      return Promise.resolve(JSON.stringify(compare));
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  return { fn, calls };
}

Deno.test("probing a repo for the first time records a revision and no gaps", async () => {
  const gh = ghStub("a".repeat(40));

  const probe = await probeReferenceSource(
    entry("https://github.com/mattpocock/skills"),
    undefined,
    deps({ ghCommandFn: gh.fn }),
  );

  assertEquals(probe.revision, "a".repeat(40));
  assertEquals(probe.gaps, []);
  assert(
    gh.calls.every((args) => !(args[1] ?? "").includes("/compare/")),
    "a first probe has nothing to compare against",
  );
});

Deno.test("probing an unchanged repo finds no gaps", async () => {
  const gh = ghStub("b".repeat(40));

  const probe = await probeReferenceSource(
    entry("https://github.com/mattpocock/skills"),
    "b".repeat(40),
    deps({ ghCommandFn: gh.fn }),
  );

  assertEquals(probe.gaps, []);
  assertEquals(probe.revision, "b".repeat(40));
});

Deno.test("probing a moved repo yields one gap per unit of new material", async () => {
  const gh = ghStub("c".repeat(40), {
    files: [
      { filename: "skills/engineering/code-review/SKILL.md", status: "added" },
      {
        filename: "skills/engineering/code-review/notes.md",
        status: "modified",
      },
      { filename: "skills/productivity/grilling/SKILL.md", status: "modified" },
      { filename: "old/dropped.md", status: "removed" },
    ],
  });

  const probe = await probeReferenceSource(
    entry("https://github.com/mattpocock/skills"),
    "b".repeat(40),
    deps({ ghCommandFn: gh.fn }),
  );

  assertEquals(probe.gaps.map((gap) => gap.unit), [
    "skills/engineering/code-review",
    "skills/productivity/grilling",
  ]);
  // The key carries the head revision, so the same directory moving again
  // later is a new proposal rather than a duplicate of this one.
  assert(probe.gaps[0]?.key.startsWith("skills/engineering/code-review@"));
  assertEquals(probe.gaps[0]?.detail, [
    "skills/engineering/code-review/SKILL.md (added)",
    "skills/engineering/code-review/notes.md (modified)",
  ]);
});

Deno.test("a removed-only change is not new material", async () => {
  const gh = ghStub("c".repeat(40), {
    files: [{ filename: "gone.md", status: "removed" }],
  });

  const probe = await probeReferenceSource(
    entry("https://github.com/mattpocock/skills"),
    "b".repeat(40),
    deps({ ghCommandFn: gh.fn }),
  );

  assertEquals(probe.gaps, []);
});

Deno.test("a failed compare fails loud and names the stale revision", async () => {
  const gh = (args: string[]): Promise<string> => {
    const endpoint = args[1] ?? "";
    if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) {
      return Promise.resolve(JSON.stringify({ default_branch: "main" }));
    }
    if (endpoint.includes("/commits/")) {
      return Promise.resolve(JSON.stringify({ sha: "c".repeat(40) }));
    }
    throw new Error("HTTP 404: No common ancestor");
  };

  await assertRejects(
    () =>
      probeReferenceSource(
        entry("https://github.com/mattpocock/skills"),
        "deadbeef",
        deps({ ghCommandFn: gh }),
      ),
    Error,
    "deadbeef",
  );
});

Deno.test("an unparseable head response fails loud", async () => {
  const gh = (args: string[]): Promise<string> => {
    const endpoint = args[1] ?? "";
    if (/^repos\/[^/]+\/[^/]+$/.test(endpoint)) {
      return Promise.resolve(JSON.stringify({ default_branch: "main" }));
    }
    return Promise.resolve("not json");
  };

  await assertRejects(
    () =>
      probeReferenceSource(
        entry("https://github.com/mattpocock/skills"),
        undefined,
        deps({ ghCommandFn: gh }),
      ),
    Error,
    "head commit",
  );
});

// ---------------------------------------------------------------------------
// Web page probe
// ---------------------------------------------------------------------------

Deno.test("probing a page for the first time records a revision and no gaps", async () => {
  const probe = await probeReferenceSource(
    entry("https://semver.org/"),
    undefined,
    deps({ fetchTextFn: () => Promise.resolve("<p>MAJOR.MINOR.PATCH</p>") }),
  );

  assertEquals(probe.gaps, []);
  assertEquals(probe.revision.length, 64);
});

Deno.test("a page whose visible text is unchanged finds no gaps", async () => {
  const html = "<p>MAJOR.MINOR.PATCH</p>";
  const first = await probeReferenceSource(
    entry("https://semver.org/"),
    undefined,
    deps({ fetchTextFn: () => Promise.resolve(html) }),
  );

  const second = await probeReferenceSource(
    entry("https://semver.org/"),
    first.revision,
    deps({
      // Same visible text, different nonce and whitespace.
      fetchTextFn: () =>
        Promise.resolve("<script>var n='9'</script>\n<p>MAJOR.MINOR.PATCH</p>"),
    }),
  );

  assertEquals(second.gaps, []);
  assertEquals(second.revision, first.revision);
});

Deno.test("a page whose text moved yields exactly one gap", async () => {
  const probe = await probeReferenceSource(
    entry("https://semver.org/"),
    "0".repeat(64),
    deps({
      fetchTextFn: () => Promise.resolve("<p>Now with pre-releases</p>"),
    }),
  );

  assertEquals(probe.gaps.length, 1);
  assertEquals(probe.gaps[0]?.unit, "the page");
  assert(probe.gaps[0]?.key.startsWith("page@"));
});

Deno.test("an unreachable page fails loud rather than reporting no change", async () => {
  await assertRejects(
    () =>
      probeReferenceSource(
        entry("https://semver.org/"),
        undefined,
        deps({
          fetchTextFn: () => {
            throw new Error("HTTP 503");
          },
        }),
      ),
    Error,
    "503",
  );
});
