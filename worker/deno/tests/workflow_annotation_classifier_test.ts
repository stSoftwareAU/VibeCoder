/**
 * Tests for `worker/deno/lib/workflow_annotation_classifier.ts`
 * (Issue #3487, part of #3485).
 *
 * The classifier turns the raw annotation stream (from the fetcher
 * sub-issue) into a small set of distinct annotation classes, each with a
 * stable, version-agnostic dedup key. These tests exercise the real
 * classifier with in-memory fixtures — no network, no `gh`.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals } from "@std/assert";
import {
  ANNOTATION_CLASS_DISCRIMINATOR,
  type AnnotationClass,
  classifyAnnotations,
  normaliseAnnotationMessage,
} from "../lib/workflow_annotation_classifier.ts";
import type { WorkflowRunAnnotation } from "../lib/workflow_annotation_fetcher.ts";

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

function annotation(
  over: Partial<WorkflowRunAnnotation> = {},
): WorkflowRunAnnotation {
  return {
    level: "warning",
    message: "",
    title: "",
    path: "",
    rawDetails: "",
    runId: 1,
    runUrl: "https://github.com/acme/widgets/actions/runs/1",
    workflowName: "CI",
    workflowPath: ".github/workflows/ci.yml",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Acceptance: version-agnostic collapse
// ---------------------------------------------------------------------------

Deno.test("classifyAnnotations - two annotations differing only by runtime version map to ONE class", async () => {
  const anns = [
    annotation({
      message:
        "The following actions use a deprecated version of the runtime: node20. Please update.",
      runId: 10,
      runUrl: "https://github.com/acme/widgets/actions/runs/10",
    }),
    annotation({
      message:
        "The following actions use a deprecated version of the runtime: node22. Please update.",
      runId: 11,
      runUrl: "https://github.com/acme/widgets/actions/runs/11",
    }),
  ];

  const classes = await classifyAnnotations(anns);
  assertEquals(classes.length, 1);
  const cls = classes[0] as AnnotationClass;
  assertEquals(cls.count, 2);
  assertEquals(cls.level, "warning");
  assertEquals(cls.workflowPaths, [".github/workflows/ci.yml"]);
  // Representative message is a real, verbatim example message.
  assert(cls.representativeMessage.includes("deprecated version"));
  // Example runUrl comes from one of the grouped annotations.
  assert(
    cls.runUrl === anns[0]?.runUrl || cls.runUrl === anns[1]?.runUrl,
  );
});

Deno.test("classifyAnnotations - version differences in action refs and dotted versions also collapse", async () => {
  const anns = [
    annotation({ message: "Node.js 18.x is deprecated; upgrade to 20." }),
    annotation({ message: "Node.js 20 is deprecated; upgrade to 22." }),
    annotation({ message: "actions/checkout@v3 uses node16." }),
    annotation({ message: "actions/checkout@v4 uses node20." }),
  ];
  const classes = await classifyAnnotations(anns);
  // Two shapes: "Node.js … is deprecated; upgrade to …" and
  // "actions/checkout@v… uses node…".
  assertEquals(classes.length, 2);
});

// ---------------------------------------------------------------------------
// Acceptance: distinct problems stay distinct
// ---------------------------------------------------------------------------

Deno.test("classifyAnnotations - two genuinely different messages map to TWO classes", async () => {
  const anns = [
    annotation({
      level: "failure",
      title: "markdownlint",
      message:
        "MD033/no-inline-html: Inline HTML detected — Unicorn! error page in output.",
      workflowPath: ".github/workflows/lint.yml",
    }),
    annotation({
      level: "warning",
      message:
        "The following actions use a deprecated version of the runtime: node20.",
    }),
  ];
  const classes = await classifyAnnotations(anns);
  assertEquals(classes.length, 2);
});

Deno.test("classifyAnnotations - same message but different level are distinct classes", async () => {
  const anns = [
    annotation({ level: "warning", message: "Deprecated runtime node20." }),
    annotation({ level: "failure", message: "Deprecated runtime node20." }),
  ];
  const classes = await classifyAnnotations(anns);
  assertEquals(classes.length, 2);
});

Deno.test("classifyAnnotations - same shape in different workflows are distinct classes", async () => {
  const anns = [
    annotation({
      message: "Deprecated runtime node20.",
      workflowPath: ".github/workflows/ci.yml",
    }),
    annotation({
      message: "Deprecated runtime node22.",
      workflowPath: ".github/workflows/release.yml",
    }),
  ];
  const classes = await classifyAnnotations(anns);
  assertEquals(classes.length, 2);
  const paths = classes.map((c) => c.workflowPaths[0]).sort();
  assertEquals(paths, [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ]);
});

// ---------------------------------------------------------------------------
// Acceptance: stable ids across repeated runs
// ---------------------------------------------------------------------------

Deno.test("classifyAnnotations - class ids are byte-identical across repeated runs of identical input", async () => {
  const anns = [
    annotation({ message: "Deprecated runtime node20." }),
    annotation({
      level: "failure",
      title: "eslint",
      message: "no-unused-vars: 'x' is defined but never used.",
      workflowPath: ".github/workflows/lint.yml",
    }),
  ];
  const first = (await classifyAnnotations(anns)).map((c) => c.classId);
  const second = (await classifyAnnotations(anns)).map((c) => c.classId);
  assertEquals(first, second);
  // Ordering is deterministic regardless of input order.
  const reversed = (await classifyAnnotations([...anns].reverse())).map((c) =>
    c.classId
  );
  assertEquals(first, reversed);
});

Deno.test("classifyAnnotations - class id is a BP-prefixed 12-hex stable id", async () => {
  const classes = await classifyAnnotations([
    annotation({ message: "Deprecated runtime node20." }),
  ]);
  const id = (classes[0] as AnnotationClass).classId;
  assert(/^BP-[0-9a-f]{12}$/.test(id), `unexpected class id shape: ${id}`);
});

// ---------------------------------------------------------------------------
// Aggregation details
// ---------------------------------------------------------------------------

Deno.test("classifyAnnotations - aggregates count and dedups workflow paths within a class", async () => {
  const anns = [
    annotation({
      message: "Deprecated runtime node20.",
      workflowPath: "",
      runUrl: "https://github.com/acme/widgets/actions/runs/1",
    }),
    annotation({
      message: "Deprecated runtime node22.",
      workflowPath: "",
      runUrl: "https://github.com/acme/widgets/actions/runs/2",
    }),
    annotation({
      message: "Deprecated runtime node20.",
      workflowPath: "",
      runUrl: "https://github.com/acme/widgets/actions/runs/3",
    }),
  ];
  const classes = await classifyAnnotations(anns);
  assertEquals(classes.length, 1);
  const cls = classes[0] as AnnotationClass;
  assertEquals(cls.count, 3);
  // Empty workflow paths are dropped, never listed as "".
  assertEquals(cls.workflowPaths, []);
});

Deno.test("classifyAnnotations - empty input yields no classes", async () => {
  assertEquals(await classifyAnnotations([]), []);
});

Deno.test("classifyAnnotations - falls back to title when message is empty", async () => {
  const anns = [
    annotation({ message: "", title: "Deprecated runtime node20." }),
    annotation({ message: "", title: "Deprecated runtime node22." }),
  ];
  const classes = await classifyAnnotations(anns);
  assertEquals(classes.length, 1);
  assertEquals(
    (classes[0] as AnnotationClass).representativeMessage,
    "Deprecated runtime node20.",
  );
});

// ---------------------------------------------------------------------------
// normaliseAnnotationMessage
// ---------------------------------------------------------------------------

Deno.test("normaliseAnnotationMessage - runtime version tokens collapse", () => {
  assertEquals(
    normaliseAnnotationMessage("runtime node20 deprecated"),
    normaliseAnnotationMessage("runtime node22 deprecated"),
  );
  assertEquals(
    normaliseAnnotationMessage("uses actions/checkout@v3"),
    normaliseAnnotationMessage("uses actions/checkout@v4"),
  );
  assertEquals(
    normaliseAnnotationMessage("Node.js 18.x deprecated"),
    normaliseAnnotationMessage("Node.js 20 deprecated"),
  );
});

Deno.test("normaliseAnnotationMessage - strips timestamps, urls, commit ids and line offsets", () => {
  const a = normaliseAnnotationMessage(
    "2026-07-17T09:15:03Z run https://github.com/o/r/actions/runs/123 at abc1234def5 file.ts:42:10 failed",
  );
  const b = normaliseAnnotationMessage(
    "2025-01-02T23:59:59Z run https://github.com/o/r/actions/runs/999 at fee9911aa22 file.ts:7:3 failed",
  );
  assertEquals(a, b);
});

Deno.test("normaliseAnnotationMessage - preserves distinct wording", () => {
  assert(
    normaliseAnnotationMessage("Inline HTML detected") !==
      normaliseAnnotationMessage("Deprecated runtime"),
  );
});

Deno.test("ANNOTATION_CLASS_DISCRIMINATOR - is stable and non-empty", () => {
  assert(ANNOTATION_CLASS_DISCRIMINATOR.length > 0);
});
