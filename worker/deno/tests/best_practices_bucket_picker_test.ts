/**
 * Tests for best_practices_bucket_picker.ts — SLOC-weighted bucket picker
 * for the best-practices idle task.
 *
 * Issue #2144.
 */

import { assert, assertEquals } from "@std/assert";
import { pickBucket } from "../lib/best_practices_bucket_picker.ts";
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

Deno.test("pickBucket - unknown language only returns general", () => {
  const result = pickBucket(makeLangs({ Brainfuck: 1000, Cobol: 500 }));
  assertEquals(result, { kind: "general" });
});

Deno.test("pickBucket - single Rust repo picks rust or general only", () => {
  const langs = makeLangs({ Rust: 50_000 });
  const rng = mulberry32(42);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const r = pickBucket(langs, rng);
    seen.add(r.kind === "language" ? r.language : "general");
  }
  // Only rust and general should ever appear.
  for (const s of seen) {
    assert(
      s === "rust" || s === "general",
      `unexpected bucket ${s} (seen=${[...seen].join(",")})`,
    );
  }
  // Both should appear with this seed.
  assert(seen.has("rust"), "expected rust at least once");
  assert(seen.has("general"), "expected general at least once");
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

Deno.test("pickBucket - general weight equals the max language byte count", () => {
  // Two languages: Rust 30000, Java 10000. Max = 30000.
  // Total = 30000 + 10000 + 30000 (general) = 70000.
  // Expected proportions: rust 30/70, java 10/70, general 30/70.
  const langs = makeLangs({ Rust: 30_000, Java: 10_000 });
  const rng = mulberry32(1234);
  const counts = { rust: 0, java: 0, general: 0 } as Record<string, number>;
  const N = 20_000;
  for (let i = 0; i < N; i++) {
    const r = pickBucket(langs, rng);
    const key = r.kind === "language" ? r.language : "general";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const expectedRust = N * 30 / 70;
  const expectedJava = N * 10 / 70;
  const expectedGeneral = N * 30 / 70;
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
  // general competes equally with the dominant language (rust here).
  assert(
    Math.abs(counts.rust! - counts.general!) / counts.rust! < 0.1,
    `general should compete equally with dominant language: rust=${counts.rust} general=${counts.general}`,
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
    //   terraform 1000, general 40000 (= max).
    // Total = 116000.
    const expected: Record<string, number> = {
      rust: 40000,
      typescript: 20000,
      java: 10000,
      html: 5000,
      terraform: 1000,
      general: 40000,
    };
    const total = Object.values(expected).reduce((a, b) => a + b, 0);

    const rng = mulberry32(987654);
    const counts: Record<string, number> = {};
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const r = pickBucket(langs, rng);
      const key = r.kind === "language" ? r.language : "general";
      counts[key] = (counts[key] ?? 0) + 1;
    }

    // Pearson chi-square statistic.
    let chi = 0;
    for (const [k, w] of Object.entries(expected)) {
      const e = N * w / total;
      const o = counts[k] ?? 0;
      chi += ((o - e) * (o - e)) / e;
    }
    // 5 degrees of freedom (6 buckets - 1). 99% critical value ≈ 15.09.
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
      const r = pickBucket(langs, rng);
      seen.add(r.kind === "language" ? r.language : "general");
    }
    assert(seen.has("react"), "expected react bucket");
    assert(seen.has("rust"), "expected rust bucket");
    assert(seen.has("general"), "expected general bucket");
    assert(!seen.has("typescript"), "typescript should be replaced by react");
  },
);
