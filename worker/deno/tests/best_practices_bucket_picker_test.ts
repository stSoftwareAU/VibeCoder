/**
 * Tests for best_practices_bucket_picker.ts — SLOC-weighted bucket picker
 * for the best-practices idle task.
 *
 * Issue #2144.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type BucketPick,
  pickBucket,
} from "../lib/best_practices_bucket_picker.ts";
import type { RepoLanguages } from "../lib/language_detector.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) for repeatable distribution tests. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Slug for a pick — mirrors `bucketSlug()` in the template so a `design`
 * pick is never miscounted as `general` (Issue #662).
 */
function slugOf(pick: BucketPick): string {
  return pick.kind === "language" ? pick.language : pick.kind;
}

/** Build a minimal RepoLanguages for tests. */
function makeLangs(
  raw: Record<string, number>,
  markers?: RepoLanguages["bestPracticesMarkers"],
): RepoLanguages {
  return {
    detected: [],
    primary: Object.keys(raw)[0] ?? "unknown",
    raw,
    ...(markers ? { bestPracticesMarkers: markers } : {}),
  };
}

// ---------------------------------------------------------------------------
// Empty / fallback cases
// ---------------------------------------------------------------------------

Deno.test("pickBucket - empty repo returns general", () => {
  const result = pickBucket(makeLangs({}));
  assertEquals(result, { kind: "general" });
});

// Behaviour change (Issue #662): a repo written entirely in languages with
// no bucket used to return `general` every time, so it never received design
// feedback. `design` is language-agnostic, so it now competes with `general`
// on such a repo.
Deno.test("pickBucket - unknown language only returns general or design", () => {
  const langs = makeLangs({ Brainfuck: 1000, Cobol: 500 });
  const rng = mulberry32(11);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    seen.add(slugOf(pickBucket(langs, rng)));
  }
  assertEquals([...seen].sort(), ["design", "general"]);
});

Deno.test("pickBucket - single Rust repo picks rust, general or design only", () => {
  const langs = makeLangs({ Rust: 50_000 });
  const rng = mulberry32(42);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    seen.add(slugOf(pickBucket(langs, rng)));
  }
  // Only rust, general and design should ever appear.
  for (const s of seen) {
    assert(
      s === "rust" || s === "general" || s === "design",
      `unexpected bucket ${s} (seen=${[...seen].join(",")})`,
    );
  }
  // All three should appear with this seed.
  assert(seen.has("rust"), "expected rust at least once");
  assert(seen.has("general"), "expected general at least once");
  assert(seen.has("design"), "expected design at least once");
});

Deno.test("pickBucket - a repo with no code at all never picks design", () => {
  // Nothing to review, so the language-agnostic design bucket is not a
  // candidate — the repo-hygiene `general` bucket still is.
  const rng = mulberry32(5);
  for (let i = 0; i < 50; i++) {
    assertEquals(pickBucket(makeLangs({}), rng), { kind: "general" });
  }
});

// ---------------------------------------------------------------------------
// Language mapping
// ---------------------------------------------------------------------------

Deno.test("pickBucket - maps GitHub API language names to supported buckets", () => {
  const cases: Array<[Record<string, number>, string]> = [
    [{ Rust: 1000 }, "rust"],
    [{ TypeScript: 1000 }, "typescript"],
    [{ Java: 1000 }, "java"],
    [{ HTML: 1000 }, "html"],
    [{ HCL: 1000 }, "terraform"],
  ];
  for (const [raw, expected] of cases) {
    // Force a deterministic pick by zeroing out the general weight: use
    // an RNG that always returns 0 so we hit the first non-general entry.
    // General is added last with weight = max language weight, so r=0
    // means we pick the first language entry.
    const rng = () => 0;
    const result = pickBucket(makeLangs(raw), rng);
    assertEquals(
      result.kind === "language" ? result.language : "general",
      expected,
      `raw=${JSON.stringify(raw)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// React detection — the core edge cases the issue calls out.
// ---------------------------------------------------------------------------

Deno.test(
  "pickBucket - React: deps + JSX both present picks react not typescript",
  () => {
    const langs = makeLangs(
      { TypeScript: 50_000 },
      { hasReactDependency: true, hasJsxFiles: true },
    );
    const rng = () => 0; // always picks first non-general bucket
    const result = pickBucket(langs, rng);
    assertEquals(result, { kind: "language", language: "react" });
  },
);

Deno.test(
  "pickBucket - React: deps without JSX falls back to typescript",
  () => {
    const langs = makeLangs(
      { TypeScript: 50_000 },
      { hasReactDependency: true, hasJsxFiles: false },
    );
    const rng = () => 0;
    const result = pickBucket(langs, rng);
    assertEquals(result, { kind: "language", language: "typescript" });
  },
);

Deno.test(
  "pickBucket - React: JSX without deps falls back to typescript",
  () => {
    const langs = makeLangs(
      { TypeScript: 50_000 },
      { hasReactDependency: false, hasJsxFiles: true },
    );
    const rng = () => 0;
    const result = pickBucket(langs, rng);
    assertEquals(result, { kind: "language", language: "typescript" });
  },
);

Deno.test(
  "pickBucket - React: no markers at all falls back to typescript",
  () => {
    const langs = makeLangs({ TypeScript: 50_000 });
    const rng = () => 0;
    const result = pickBucket(langs, rng);
    assertEquals(result, { kind: "language", language: "typescript" });
  },
);

// ---------------------------------------------------------------------------
// Marker-file buckets — weight = bytes of marker files.
// ---------------------------------------------------------------------------

Deno.test("pickBucket - CloudFormation marker bytes drive the aws-cloudformation bucket", () => {
  const langs = makeLangs({}, { cloudFormationBytes: 4000 });
  const rng = () => 0;
  const result = pickBucket(langs, rng);
  assertEquals(result, { kind: "language", language: "aws-cloudformation" });
});

Deno.test("pickBucket - Terraform: marker bytes preferred over HCL raw count", () => {
  const langs = makeLangs(
    { HCL: 1000 },
    { terraformBytes: 9999 },
  );
  // The general weight = max language weight. terraformBytes (9999) is
  // the only language bucket, so general also has weight 9999.
  // With rng()=0 we land on the first language entry => terraform.
  const rng = () => 0;
  const result = pickBucket(langs, rng);
  assertEquals(result, { kind: "language", language: "terraform" });
});

Deno.test("pickBucket - Terraform: falls back to HCL raw count when no marker bytes", () => {
  const langs = makeLangs({ HCL: 5000 });
  const rng = () => 0;
  const result = pickBucket(langs, rng);
  assertEquals(result, { kind: "language", language: "terraform" });
});

// ---------------------------------------------------------------------------
// general bucket weight rule.
// ---------------------------------------------------------------------------

Deno.test("pickBucket - general and design weights equal the max language byte count", () => {
  // Two languages: Rust 30000, Java 10000. Max = 30000.
  // Total = 30000 + 10000 + 30000 (general) + 30000 (design) = 100000.
  // Expected proportions: rust 30/100, java 10/100, general 30/100,
  // design 30/100.
  const langs = makeLangs({ Rust: 30_000, Java: 10_000 });
  const rng = mulberry32(1234);
  const counts = { rust: 0, java: 0, general: 0, design: 0 } as Record<
    string,
    number
  >;
  const N = 20_000;
  for (let i = 0; i < N; i++) {
    const key = slugOf(pickBucket(langs, rng));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const expectedRust = N * 30 / 100;
  const expectedJava = N * 10 / 100;
  const expectedGeneral = N * 30 / 100;
  const expectedDesign = N * 30 / 100;
  // Allow ±5% tolerance per bucket.
  const tol = 0.05;
  assert(
    Math.abs(counts.rust! - expectedRust) / expectedRust < tol,
    `rust count ${counts.rust} out of tolerance vs ${expectedRust}`,
  );
  assert(
    Math.abs(counts.java! - expectedJava) / expectedJava < tol,
    `java count ${counts.java} out of tolerance vs ${expectedJava}`,
  );
  assert(
    Math.abs(counts.general! - expectedGeneral) / expectedGeneral < tol,
    `general count ${counts.general} out of tolerance vs ${expectedGeneral}`,
  );
  assert(
    Math.abs(counts.design! - expectedDesign) / expectedDesign < tol,
    `design count ${counts.design} out of tolerance vs ${expectedDesign}`,
  );
  // general and design each compete equally with the dominant language.
  assert(
    Math.abs(counts.rust! - counts.general!) / counts.rust! < 0.1,
    `general should compete equally with dominant language: rust=${counts.rust} general=${counts.general}`,
  );
  assert(
    Math.abs(counts.rust! - counts.design!) / counts.rust! < 0.1,
    `design should compete equally with dominant language: rust=${counts.rust} design=${counts.design}`,
  );
});

// ---------------------------------------------------------------------------
// Distribution proportional to weights (chi-square style assertion).
// ---------------------------------------------------------------------------

Deno.test(
  "pickBucket - distribution proportional to weights across many supported buckets",
  () => {
    const langs = makeLangs(
      {
        Rust: 40_000,
        TypeScript: 20_000,
        Java: 10_000,
        HTML: 5000,
      },
      {
        terraformBytes: 1000,
      },
    );
    // Expected weights:
    //   rust 40000, typescript 20000, java 10000, html 5000,
    //   terraform 1000, general 40000 (= max), design 40000 (= max).
    // Total = 156000.
    const expected: Record<string, number> = {
      rust: 40000,
      typescript: 20000,
      java: 10000,
      html: 5000,
      terraform: 1000,
      general: 40000,
      design: 40000,
    };
    const total = Object.values(expected).reduce((a, b) => a + b, 0);

    const rng = mulberry32(987654);
    const counts: Record<string, number> = {};
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const key = slugOf(pickBucket(langs, rng));
      counts[key] = (counts[key] ?? 0) + 1;
    }

    // Pearson chi-square statistic.
    let chi = 0;
    for (const [k, w] of Object.entries(expected)) {
      const e = N * w / total;
      const o = counts[k] ?? 0;
      chi += ((o - e) * (o - e)) / e;
    }
    // 6 degrees of freedom (7 buckets - 1). 99% critical value ≈ 16.81.
    // Use 20 as a generous threshold; with mulberry32 seed=987654 the
    // observed value is well below.
    assert(chi < 20, `chi-square=${chi} exceeds threshold for distribution`);
  },
);

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

Deno.test("pickBucket - same seeded RNG produces the same sequence of picks", () => {
  const langs = makeLangs({ Rust: 30000, Java: 20000, TypeScript: 10000 });
  const rng1 = mulberry32(7);
  const rng2 = mulberry32(7);
  for (let i = 0; i < 50; i++) {
    const a = pickBucket(langs, rng1);
    const b = pickBucket(langs, rng2);
    assertEquals(a, b, `differ at iteration ${i}`);
  }
});

// ---------------------------------------------------------------------------
// React + non-TS languages mix.
// ---------------------------------------------------------------------------

Deno.test(
  "pickBucket - React replaces typescript bucket but other languages stay independent",
  () => {
    const langs = makeLangs(
      { TypeScript: 30_000, Rust: 20_000 },
      { hasReactDependency: true, hasJsxFiles: true },
    );
    const rng = mulberry32(33);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(slugOf(pickBucket(langs, rng)));
    }
    assert(seen.has("react"), "expected react bucket");
    assert(seen.has("rust"), "expected rust bucket");
    assert(seen.has("general"), "expected general bucket");
    assert(!seen.has("typescript"), "typescript should be replaced by react");
  },
);

// ---------------------------------------------------------------------------
// design bucket — language-agnostic, so it is a candidate on every repo that
// has code, whatever the language (Issue #662).
// ---------------------------------------------------------------------------

Deno.test("pickBucket - design is a candidate on a marker-only repo", () => {
  const langs = makeLangs({}, { cloudFormationBytes: 4000 });
  const rng = mulberry32(21);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    seen.add(slugOf(pickBucket(langs, rng)));
  }
  assert(seen.has("design"), `expected design, saw ${[...seen].join(",")}`);
  assert(seen.has("aws-cloudformation"), "expected the language bucket too");
});

Deno.test("pickBucket - design does not displace the language buckets", () => {
  // A design pick must not starve the language bucket: on a single-language
  // repo the language still wins a third of the draws (weights are equal).
  const langs = makeLangs({ Java: 12_000 });
  const rng = mulberry32(99);
  const counts: Record<string, number> = {};
  const N = 6000;
  for (let i = 0; i < N; i++) {
    const key = slugOf(pickBucket(langs, rng));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  for (const key of ["java", "general", "design"]) {
    const share = (counts[key] ?? 0) / N;
    assert(
      Math.abs(share - 1 / 3) < 0.05,
      `${key} share ${share} should be about a third`,
    );
  }
});
