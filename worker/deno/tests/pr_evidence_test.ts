/**
 * Tests for pr_evidence.ts — PR evidence handling (Issue #915).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  convertEvidenceImagesToRawUrls,
  convertScreenshotToGithubUrl,
  findScreenshotReferences,
  processScreenshotEvidence,
  validatePrEvidence,
} from "../lib/pr_evidence.ts";
import type { Result } from "../types.ts";

// --- convertEvidenceImagesToRawUrls (Issue #2985) ---

const SHA = "9ad209d9b3f438e12562c046c06dfc6f9ad2d4d0";
const REPO = "example-org/private-repo-22";

/** Existence predicate that treats a fixed allow-list of paths as present. */
function fakeExists(
  present: string[],
): (r: string, p: string) => Promise<boolean> {
  const set = new Set(present);
  return (_repoPath: string, relativePath: string) =>
    Promise.resolve(set.has(relativePath));
}

Deno.test("convertEvidenceImagesToRawUrls - rewrites in-repo relative images to raw URLs", async () => {
  const body = `## Evidence
![Desktop](docs/evidence/issue-277-desktop.png)
![Narrow](docs/evidence/issue-277-narrow.png)`;
  const result = await convertEvidenceImagesToRawUrls(body, {
    repoPath: "/repo",
    githubRepo: REPO,
    commitSha: SHA,
    fileExistsFn: fakeExists([
      "docs/evidence/issue-277-desktop.png",
      "docs/evidence/issue-277-narrow.png",
    ]),
  });
  assertEquals(result.conversions.length, 2);
  assertEquals(
    result.content.includes(
      `https://github.com/${REPO}/raw/${SHA}/docs/evidence/issue-277-desktop.png`,
    ),
    true,
  );
  assertEquals(
    result.content.includes(
      `https://github.com/${REPO}/raw/${SHA}/docs/evidence/issue-277-narrow.png`,
    ),
    true,
  );
  // No relative path should survive.
  assertEquals(result.content.includes("(docs/evidence/"), false);
});

Deno.test("convertEvidenceImagesToRawUrls - leaves external and absolute URLs untouched", async () => {
  const body =
    `![Hosted](https://i.imgur.com/x.png)\n![Abs](/docs/evidence/a.png)\n![Data](data:image/png;base64,zzz)`;
  const result = await convertEvidenceImagesToRawUrls(body, {
    repoPath: "/repo",
    githubRepo: REPO,
    commitSha: SHA,
    fileExistsFn: fakeExists(["docs/evidence/a.png"]),
  });
  assertEquals(result.conversions.length, 0);
  assertEquals(result.content, body);
});

Deno.test("convertEvidenceImagesToRawUrls - leaves references to missing files unchanged", async () => {
  const body = `![Gone](docs/evidence/missing.png)`;
  const result = await convertEvidenceImagesToRawUrls(body, {
    repoPath: "/repo",
    githubRepo: REPO,
    commitSha: SHA,
    fileExistsFn: fakeExists([]),
  });
  assertEquals(result.conversions.length, 0);
  assertEquals(result.content, body);
});

Deno.test("convertEvidenceImagesToRawUrls - strips a leading ./ before building the URL", async () => {
  const body = `![Rel](./docs/evidence/fix.png)`;
  const result = await convertEvidenceImagesToRawUrls(body, {
    repoPath: "/repo",
    githubRepo: REPO,
    commitSha: SHA,
    fileExistsFn: fakeExists(["docs/evidence/fix.png"]),
  });
  assertEquals(result.conversions.length, 1);
  assertEquals(
    result.content,
    `![Rel](https://github.com/${REPO}/raw/${SHA}/docs/evidence/fix.png)`,
  );
});

Deno.test("convertEvidenceImagesToRawUrls - rejects traversal paths without touching the filesystem (Issue #3658)", async () => {
  const probed: string[] = [];
  const body = [
    `![escape](../../../../home/user/.ssh/key.png)`,
    `![nested](docs/../../secrets/a.png)`,
    `![dotslash](./../secrets.png)`,
    `![ok](docs/evidence/fix.png)`,
  ].join("\n");
  const result = await convertEvidenceImagesToRawUrls(body, {
    repoPath: "/repo",
    githubRepo: REPO,
    commitSha: SHA,
    fileExistsFn: (_repoPath: string, relativePath: string) => {
      probed.push(relativePath);
      return Promise.resolve(true);
    },
  });

  // Only the in-repo reference is probed and converted.
  assertEquals(probed, ["docs/evidence/fix.png"]);
  assertEquals(result.conversions.length, 1);
  assertEquals(result.conversions[0]?.from, "docs/evidence/fix.png");
  // Traversal references survive verbatim — never rewritten into a raw URL.
  assertEquals(
    result.content.includes(`![escape](../../../../home/user/.ssh/key.png)`),
    true,
  );
  assertEquals(
    result.content.includes(`![nested](docs/../../secrets/a.png)`),
    true,
  );
  assertEquals(result.content.includes(`![dotslash](./../secrets.png)`), true);
  assertEquals(result.content.includes("/raw/"), true);
  assertEquals(result.content.includes(".."), true);
  assertEquals(result.content.includes(`/raw/${SHA}/..`), false);
});

Deno.test("convertEvidenceImagesToRawUrls - keeps filenames containing dots (Issue #3658)", async () => {
  const body = `![Dots](docs/evidence/v1..2/shot..final.png)`;
  const result = await convertEvidenceImagesToRawUrls(body, {
    repoPath: "/repo",
    githubRepo: REPO,
    commitSha: SHA,
    fileExistsFn: fakeExists(["docs/evidence/v1..2/shot..final.png"]),
  });
  assertEquals(result.conversions.length, 1);
  assertEquals(
    result.content,
    `![Dots](https://github.com/${REPO}/raw/${SHA}/docs/evidence/v1..2/shot..final.png)`,
  );
});

Deno.test("convertEvidenceImagesToRawUrls - no-ops when commit SHA is empty", async () => {
  const body = `![Desktop](docs/evidence/x.png)`;
  const result = await convertEvidenceImagesToRawUrls(body, {
    repoPath: "/repo",
    githubRepo: REPO,
    commitSha: "",
    fileExistsFn: fakeExists(["docs/evidence/x.png"]),
  });
  assertEquals(result.conversions.length, 0);
  assertEquals(result.content, body);
});

Deno.test("convertEvidenceImagesToRawUrls - ignores non-image references", async () => {
  const body =
    `[a link](docs/evidence/notes.md)\n![doc](docs/evidence/readme.txt)`;
  const result = await convertEvidenceImagesToRawUrls(body, {
    repoPath: "/repo",
    githubRepo: REPO,
    commitSha: SHA,
    fileExistsFn: fakeExists([
      "docs/evidence/notes.md",
      "docs/evidence/readme.txt",
    ]),
  });
  assertEquals(result.conversions.length, 0);
  assertEquals(result.content, body);
});

// --- convertScreenshotToGithubUrl ---

Deno.test("pr_evidence - convertScreenshotToGithubUrl builds correct URL", () => {
  const url = convertScreenshotToGithubUrl(
    "docs/evidence/fix.png",
    "stSoftwareAU/VibeCoder",
    "abc123",
  );
  assertEquals(
    url,
    "https://github.com/stSoftwareAU/VibeCoder/raw/abc123/docs/evidence/fix.png",
  );
});

Deno.test("pr_evidence - convertScreenshotToGithubUrl handles different paths", () => {
  const url = convertScreenshotToGithubUrl(
    "screenshots/test.jpg",
    "owner/repo",
    "def456",
  );
  assertEquals(
    url,
    "https://github.com/owner/repo/raw/def456/screenshots/test.jpg",
  );
});

// --- findScreenshotReferences ---

Deno.test("pr_evidence - findScreenshotReferences finds PNG references", () => {
  const content = "Some text ![Screenshot](docs/evidence/fix.png) more text";
  const refs = findScreenshotReferences(content);
  assertEquals(refs.length, 1);
  assertEquals(refs[0], "docs/evidence/fix.png");
});

Deno.test("pr_evidence - findScreenshotReferences finds multiple references", () => {
  const content = "![A](evidence/a.png) and ![B](evidence/b.jpg)";
  const refs = findScreenshotReferences(content);
  assertEquals(refs.length, 2);
});

Deno.test("pr_evidence - findScreenshotReferences returns empty for no matches", () => {
  const content = "No images here, just text.";
  const refs = findScreenshotReferences(content);
  assertEquals(refs.length, 0);
});

Deno.test("pr_evidence - findScreenshotReferences ignores non-screenshot images", () => {
  const content = "![Logo](assets/logo.svg)";
  const refs = findScreenshotReferences(content);
  assertEquals(refs.length, 0);
});

Deno.test("pr_evidence - findScreenshotReferences matches evidence directory", () => {
  const content = "![Test](docs/evidence/result.gif)";
  // .gif doesn't match png/jpg/jpeg, but "evidence" keyword does match
  const refs = findScreenshotReferences(content);
  assertEquals(refs.length, 1);
});

// --- validatePrEvidence ---

Deno.test("pr_evidence - validatePrEvidence passes for non-UI changes", () => {
  const result = validatePrEvidence("Fixed a backend bug.", "bug,enhancement");
  assertEquals(result.ok, true);
});

Deno.test("pr_evidence - validatePrEvidence detects UI labels", () => {
  const result = validatePrEvidence("Fixed something.", "ui,bug");
  assertEquals(result.ok, false);
});

// Issue #1296: Updated to require 2 UI keywords (reduces false positives
// from single common words like "visual" or "color" in non-UI contexts).
Deno.test("pr_evidence - validatePrEvidence detects UI keywords in content", () => {
  const result = validatePrEvidence(
    "Updated the button colour and modal styling.",
    "enhancement",
  );
  assertEquals(result.ok, false);
});

Deno.test("pr_evidence - validatePrEvidence passes for UI change with screenshots", () => {
  const content = "Updated button ![Screenshot](docs/evidence/button.png)";
  const result = validatePrEvidence(content, "ui");
  assertEquals(result.ok, true);
});

Deno.test("pr_evidence - validatePrEvidence appends warning when screenshots missing", () => {
  const result = validatePrEvidence(
    "Updated the CSS colour theme.",
    "enhancement",
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.includes("Screenshot evidence not provided"),
      true,
    );
  }
});

// --- Issue #1296: word boundary and false positive fixes ---

Deno.test("pr_evidence - validatePrEvidence does not false positive on 'build' label matching 'ui' substring", () => {
  const result = validatePrEvidence(
    "Fixed a build pipeline issue.",
    "build,enhancement",
  );
  assertEquals(result.ok, true);
});

Deno.test("pr_evidence - validatePrEvidence does not false positive on 'visual' in negated context", () => {
  const result = validatePrEvidence(
    "No visual output changes were made. This is a performance research task.",
    "performance",
  );
  assertEquals(result.ok, true);
});

Deno.test("pr_evidence - validatePrEvidence does not false positive on 'require' matching 'ui' substring", () => {
  const result = validatePrEvidence(
    "Fixed a required dependency.",
    "required,bug",
  );
  assertEquals(result.ok, true);
});

// --- processScreenshotEvidence ---

Deno.test("pr_evidence - processScreenshotEvidence handles empty directory", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await processScreenshotEvidence("Some PR body", {
      repoPath: tmpDir,
      screenshotDir: "nonexistent",
    });
    assertEquals(result.content, "Some PR body");
    assertEquals(result.screenshotsFound, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("pr_evidence - processScreenshotEvidence processes screenshots with GitHub URLs", async () => {
  const tmpDir = await Deno.makeTempDir();
  const evidenceDir = `${tmpDir}/docs/evidence`;
  await Deno.mkdir(evidenceDir, { recursive: true });
  await Deno.writeTextFile(`${evidenceDir}/test.png`, "fake-image-data");

  try {
    const result = await processScreenshotEvidence(
      "PR body with ![Screenshot](docs/evidence/test.png)",
      {
        repoPath: tmpDir,
        githubRepo: "owner/repo",
        screenshotDir: "docs/evidence",
        gitCommandFn: async (_args: string[]) => "abc123def",
      },
    );
    assertEquals(result.screenshotsFound, 1);
    assertEquals(result.screenshotsConverted, 1);
    assertEquals(
      result.content.includes("github.com/owner/repo/raw/abc123def"),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("pr_evidence - processScreenshotEvidence adds note when no upload method", async () => {
  const tmpDir = await Deno.makeTempDir();
  const evidenceDir = `${tmpDir}/docs/evidence`;
  await Deno.mkdir(evidenceDir, { recursive: true });
  await Deno.writeTextFile(`${evidenceDir}/test.png`, "fake-image-data");

  try {
    const result = await processScreenshotEvidence("PR body", {
      repoPath: tmpDir,
      screenshotDir: "docs/evidence",
    });
    assertEquals(result.screenshotsFound, 1);
    assertEquals(
      result.content.includes("Screenshots have been captured"),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// --- processScreenshotEvidence with imgbb upload (Issue #1232) ---

Deno.test("pr_evidence - processScreenshotEvidence uploads via imgbb when key provided", async () => {
  const tmpDir = await Deno.makeTempDir();
  const evidenceDir = `${tmpDir}/docs/evidence`;
  await Deno.mkdir(evidenceDir, { recursive: true });
  await Deno.writeTextFile(`${evidenceDir}/test.png`, "fake-image-data");

  const mockUpload = (_path: string): Promise<Result<string, Error>> => {
    return Promise.resolve({
      ok: true,
      value: "https://i.ibb.co/uploaded/test.png",
    });
  };

  try {
    const result = await processScreenshotEvidence(
      "PR body with ![Screenshot](docs/evidence/test.png)",
      {
        repoPath: tmpDir,
        screenshotDir: "docs/evidence",
        imgbbApiKey: "test-key",
        uploadFn: mockUpload,
      },
    );
    assertEquals(result.screenshotsFound, 1);
    assertEquals(result.screenshotsUploaded, 1);
    assertEquals(result.screenshotsConverted, 0);
    assertEquals(
      result.content.includes("https://i.ibb.co/uploaded/test.png"),
      true,
    );
    assertEquals(result.content.includes("docs/evidence/test.png"), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("pr_evidence - processScreenshotEvidence falls back to GitHub URLs when imgbb fails", async () => {
  const tmpDir = await Deno.makeTempDir();
  const evidenceDir = `${tmpDir}/docs/evidence`;
  await Deno.mkdir(evidenceDir, { recursive: true });
  await Deno.writeTextFile(`${evidenceDir}/test.png`, "fake-image-data");

  const failingUpload = (_path: string): Promise<Result<string, Error>> => {
    return Promise.resolve({ ok: false, error: new Error("Upload failed") });
  };

  try {
    const result = await processScreenshotEvidence(
      "PR body with ![Screenshot](docs/evidence/test.png)",
      {
        repoPath: tmpDir,
        screenshotDir: "docs/evidence",
        imgbbApiKey: "test-key",
        uploadFn: failingUpload,
        githubRepo: "owner/repo",
        gitCommandFn: async (_args: string[]) => "fallback123",
      },
    );
    assertEquals(result.screenshotsFound, 1);
    assertEquals(result.screenshotsUploaded, 0);
    assertEquals(result.screenshotsFailed, 1);
    assertEquals(result.screenshotsConverted, 1);
    // Should fall back to GitHub URL
    assertEquals(
      result.content.includes("github.com/owner/repo/raw/fallback123"),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("pr_evidence - processScreenshotEvidence adds failure note when imgbb upload fails", async () => {
  const tmpDir = await Deno.makeTempDir();
  const evidenceDir = `${tmpDir}/docs/evidence`;
  await Deno.mkdir(evidenceDir, { recursive: true });
  await Deno.writeTextFile(`${evidenceDir}/test.png`, "fake-image-data");

  const failingUpload = (_path: string): Promise<Result<string, Error>> => {
    return Promise.resolve({ ok: false, error: new Error("Upload failed") });
  };

  try {
    const result = await processScreenshotEvidence("PR body", {
      repoPath: tmpDir,
      screenshotDir: "docs/evidence",
      imgbbApiKey: "test-key",
      uploadFn: failingUpload,
    });
    assertEquals(result.screenshotsFailed, 1);
    assertEquals(
      result.content.includes("could not be uploaded automatically"),
      true,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
