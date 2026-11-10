/**
 * Canonical **content** label definitions for the fleet (Issue #368).
 *
 * These are the classification and finding labels the worker (and the
 * agent templates it drives) attach to issues: the `severity:*` ramp, the
 * `confidence:*` ramp, the `lang:*` buckets, and the per-scan category
 * labels. Unlike the workflow labels in `label_definitions.ts` they are
 * **not seeded onto every monitored repo** at onboarding — a repo only
 * grows `severity:critical` once a scan actually files a finding there.
 *
 * Issue #368 — before this table existed each call site hard-coded its own
 * colour literal, so a label's colour was decided by whichever call site
 * created it first in that repo. The measured result was
 * `severity:critical` grey in one repo and red in the next, which makes the
 * colour meaningless at a glance. Every colour below is lower-case hex so
 * comparisons never become a string-normalisation problem.
 *
 * Australian English throughout (colour, behaviour, organisation).
 */ /**
 * Severity ramp — red → orange → yellow → green as severity falls.
 *
 * Applied by every finding-emitting scan template. The ramp is the whole
 * point: a reader scanning an issue list must be able to tell a critical
 * finding from a low one without reading the title.
 */ const SEVERITY_LABELS = [
  {
    name: "severity:critical",
    colour: "b60205",
    description: "Critical severity finding — fix before anything else",
    category: "content"
  },
  {
    name: "severity:high",
    colour: "d93f0b",
    description: "High severity finding",
    category: "content"
  },
  {
    name: "severity:medium",
    colour: "fbca04",
    description: "Medium severity finding",
    category: "content"
  },
  {
    name: "severity:low",
    colour: "0e8a16",
    description: "Low severity finding",
    category: "content"
  }
];
/**
 * Confidence ramp — green (certain) → yellow → pale green (speculative).
 *
 * Deliberately a different hue family from the severity ramp so the two
 * never read as the same signal on one issue.
 */ const CONFIDENCE_LABELS = [
  {
    name: "confidence:high",
    colour: "0e8a16",
    description: "Finding is confirmed — high confidence",
    category: "content"
  },
  {
    name: "confidence:medium",
    colour: "fbca04",
    description: "Finding is likely but unverified — medium confidence",
    category: "content"
  },
  {
    name: "confidence:low",
    colour: "c2e0c6",
    description: "Finding is speculative — low confidence",
    category: "content"
  }
];
/**
 * Security-family labels — the security scan, its whole-tree sweep, the
 * supply-chain audits, and the dependency-audit failure notifier.
 */ const SECURITY_LABELS = [
  {
    name: "security",
    colour: "b60205",
    description: "Security finding raised by the security scan",
    category: "content"
  },
  {
    name: "security-tree-sweep",
    colour: "5319e7",
    description: "Whole-tree security sweep finding",
    category: "content"
  },
  {
    name: "security-scan-overflow",
    colour: "fbca04",
    description: "Security scan produced more findings than one batch carries",
    category: "content"
  },
  {
    name: "supply-chain-readiness",
    colour: "5319e7",
    description: "Supply-chain readiness finding",
    category: "content"
  },
  {
    name: "supply-chain:quarantine-missing",
    colour: "5319e7",
    description: "Dependency updates run with no quarantine window configured",
    category: "content"
  },
  {
    name: "supply-chain:quarantine-misconfigured",
    colour: "5319e7",
    description: "Dependency quarantine window is configured incorrectly",
    category: "content"
  },
  {
    name: "dependency-audit-failure",
    colour: "d73a4a",
    description: "A scheduled dependency audit failed — a committed dependency has a known advisory.",
    category: "content"
  }
];
/**
 * Scan-category labels — one per idle-task scan template, so a repo's
 * findings can be filtered by which scan produced them.
 */ const SCAN_CATEGORY_LABELS = [
  {
    name: "best-practices",
    colour: "5319e7",
    description: "Best-practices scan finding",
    category: "content"
  },
  {
    name: "test-audit",
    colour: "b60205",
    description: "Test-audit scan finding",
    category: "content"
  },
  {
    name: "github-actions-audit",
    colour: "b60205",
    description: "GitHub Actions audit finding",
    category: "content"
  },
  {
    name: "gate-skip-drift",
    colour: "b60205",
    description: "The local quality gate skips a tool this repo's CI enforces",
    category: "content"
  },
  {
    name: "ponytail-debt",
    colour: "0e8a16",
    description: "Ledger of SIMPLE-ON-PURPOSE markers",
    category: "content"
  },
  {
    name: "bash-syntax-audit",
    colour: "b60205",
    description: "Bash syntax audit finding",
    category: "content"
  },
  {
    name: "bash-missing-script",
    colour: "b60205",
    description: "A referenced bash script is missing from the repository",
    category: "content"
  },
  {
    name: "documentation-audit",
    colour: "1d76db",
    description: "Documentation audit finding",
    category: "content"
  },
  {
    name: "duplicated-knowledge",
    colour: "1d76db",
    description: "Duplicated-knowledge scan finding",
    category: "content"
  },
  {
    name: "retro",
    colour: "0052cc",
    description: "Retro candidate — environment improvement from a finished run",
    category: "content"
  },
  {
    name: "format-drift",
    colour: "1d76db",
    description: "Formatting drift finding",
    category: "content"
  },
  {
    name: "dead-code",
    colour: "5319e7",
    description: "Dead-code scan finding",
    category: "content"
  },
  {
    name: "deprecated-api",
    colour: "0e8a16",
    description: "Deprecated-API scan finding",
    category: "content"
  },
  {
    name: "doc-coverage",
    colour: "0e8a16",
    description: "Documentation-coverage scan finding",
    category: "content"
  },
  {
    name: "workflow-annotation-scan",
    colour: "0e8a16",
    description: "Workflow annotation scan finding",
    category: "content"
  },
  {
    name: "private-repo-reference",
    colour: "5319e7",
    description: "Reference to a private repository from a public one",
    category: "content"
  },
  {
    name: "alert-feed",
    colour: "d93f0b",
    description: "Finding raised from a monitored security alert feed",
    category: "content"
  }
];
/**
 * Outcome labels — applied by the worker to record how a piece of work
 * ended rather than what it found.
 */ const OUTCOME_LABELS = [
  {
    name: "negative-result",
    colour: "c5def5",
    description: "Performance work measured no improvement — do not re-attempt without new evidence",
    category: "content"
  },
  {
    name: "merge-conflict",
    colour: "b60205",
    description: "PR conflicts with its base branch and needs a real merge",
    category: "content"
  },
  {
    name: "merge-fallback",
    colour: "d93f0b",
    description: "A merge conflict fell back to the last known good state — what was closed or reverted, and why",
    category: "content"
  },
  {
    name: "escalated",
    colour: "d4c5f9",
    description: "The fleet filed this PR's blockage as work; it is not waiting on a human",
    category: "content"
  }
];
/**
 * `lang:*` buckets from the best-practices scan.
 *
 * One entry per {@link SupportedLanguage} bucket, plus the two
 * language-agnostic buckets (`general`, `design`) and the legacy
 * `lang:github-actions` bucket. Colours follow each language's own brand
 * colour so the bucket is recognisable at a glance.
 */ const LANGUAGE_LABELS = [
  [
    "general",
    "c2e0c6"
  ],
  [
    "design",
    "bfd4f2"
  ],
  [
    "rust",
    "dea584"
  ],
  [
    "typescript",
    "1d76db"
  ],
  [
    "react",
    "61dafb"
  ],
  [
    "java",
    "b07219"
  ],
  [
    "html",
    "e34c26"
  ],
  [
    "aws-cloudformation",
    "ff9900"
  ],
  [
    "terraform",
    "7b42bc"
  ],
  [
    "github-actions",
    "2088ff"
  ]
].map(([bucket, colour])=>({
    name: `lang:${bucket}`,
    colour: colour,
    description: `Best-practices finding for the \`${bucket}\` bucket`,
    category: "content"
  }));
/**
 * Every content label the fleet manages, grouped by family.
 *
 * Order is family-by-family so the table reads as families rather than an
 * alphabetical soup.
 */ export const CONTENT_LABEL_DEFINITIONS = [
  ...SEVERITY_LABELS,
  ...CONFIDENCE_LABELS,
  ...SECURITY_LABELS,
  ...SCAN_CATEGORY_LABELS,
  ...OUTCOME_LABELS,
  ...LANGUAGE_LABELS
];
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL3NldHVwL2NvbnRlbnRfbGFiZWxfZGVmaW5pdGlvbnMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDYW5vbmljYWwgKipjb250ZW50KiogbGFiZWwgZGVmaW5pdGlvbnMgZm9yIHRoZSBmbGVldCAoSXNzdWUgIzM2OCkuXG4gKlxuICogVGhlc2UgYXJlIHRoZSBjbGFzc2lmaWNhdGlvbiBhbmQgZmluZGluZyBsYWJlbHMgdGhlIHdvcmtlciAoYW5kIHRoZVxuICogYWdlbnQgdGVtcGxhdGVzIGl0IGRyaXZlcykgYXR0YWNoIHRvIGlzc3VlczogdGhlIGBzZXZlcml0eToqYCByYW1wLCB0aGVcbiAqIGBjb25maWRlbmNlOipgIHJhbXAsIHRoZSBgbGFuZzoqYCBidWNrZXRzLCBhbmQgdGhlIHBlci1zY2FuIGNhdGVnb3J5XG4gKiBsYWJlbHMuIFVubGlrZSB0aGUgd29ya2Zsb3cgbGFiZWxzIGluIGBsYWJlbF9kZWZpbml0aW9ucy50c2AgdGhleSBhcmVcbiAqICoqbm90IHNlZWRlZCBvbnRvIGV2ZXJ5IG1vbml0b3JlZCByZXBvKiogYXQgb25ib2FyZGluZyDigJQgYSByZXBvIG9ubHlcbiAqIGdyb3dzIGBzZXZlcml0eTpjcml0aWNhbGAgb25jZSBhIHNjYW4gYWN0dWFsbHkgZmlsZXMgYSBmaW5kaW5nIHRoZXJlLlxuICpcbiAqIElzc3VlICMzNjgg4oCUIGJlZm9yZSB0aGlzIHRhYmxlIGV4aXN0ZWQgZWFjaCBjYWxsIHNpdGUgaGFyZC1jb2RlZCBpdHMgb3duXG4gKiBjb2xvdXIgbGl0ZXJhbCwgc28gYSBsYWJlbCdzIGNvbG91ciB3YXMgZGVjaWRlZCBieSB3aGljaGV2ZXIgY2FsbCBzaXRlXG4gKiBjcmVhdGVkIGl0IGZpcnN0IGluIHRoYXQgcmVwby4gVGhlIG1lYXN1cmVkIHJlc3VsdCB3YXNcbiAqIGBzZXZlcml0eTpjcml0aWNhbGAgZ3JleSBpbiBvbmUgcmVwbyBhbmQgcmVkIGluIHRoZSBuZXh0LCB3aGljaCBtYWtlcyB0aGVcbiAqIGNvbG91ciBtZWFuaW5nbGVzcyBhdCBhIGdsYW5jZS4gRXZlcnkgY29sb3VyIGJlbG93IGlzIGxvd2VyLWNhc2UgaGV4IHNvXG4gKiBjb21wYXJpc29ucyBuZXZlciBiZWNvbWUgYSBzdHJpbmctbm9ybWFsaXNhdGlvbiBwcm9ibGVtLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChjb2xvdXIsIGJlaGF2aW91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IExhYmVsRGVmaW5pdGlvbiB9IGZyb20gXCIuL2xhYmVsX2RlZmluaXRpb25zLnRzXCI7XG5cbi8qKlxuICogU2V2ZXJpdHkgcmFtcCDigJQgcmVkIOKGkiBvcmFuZ2Ug4oaSIHllbGxvdyDihpIgZ3JlZW4gYXMgc2V2ZXJpdHkgZmFsbHMuXG4gKlxuICogQXBwbGllZCBieSBldmVyeSBmaW5kaW5nLWVtaXR0aW5nIHNjYW4gdGVtcGxhdGUuIFRoZSByYW1wIGlzIHRoZSB3aG9sZVxuICogcG9pbnQ6IGEgcmVhZGVyIHNjYW5uaW5nIGFuIGlzc3VlIGxpc3QgbXVzdCBiZSBhYmxlIHRvIHRlbGwgYSBjcml0aWNhbFxuICogZmluZGluZyBmcm9tIGEgbG93IG9uZSB3aXRob3V0IHJlYWRpbmcgdGhlIHRpdGxlLlxuICovXG5jb25zdCBTRVZFUklUWV9MQUJFTFM6IHJlYWRvbmx5IExhYmVsRGVmaW5pdGlvbltdID0gW1xuICB7XG4gICAgbmFtZTogXCJzZXZlcml0eTpjcml0aWNhbFwiLFxuICAgIGNvbG91cjogXCJiNjAyMDVcIixcbiAgICBkZXNjcmlwdGlvbjogXCJDcml0aWNhbCBzZXZlcml0eSBmaW5kaW5nIOKAlCBmaXggYmVmb3JlIGFueXRoaW5nIGVsc2VcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNldmVyaXR5OmhpZ2hcIixcbiAgICBjb2xvdXI6IFwiZDkzZjBiXCIsXG4gICAgZGVzY3JpcHRpb246IFwiSGlnaCBzZXZlcml0eSBmaW5kaW5nXCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzZXZlcml0eTptZWRpdW1cIixcbiAgICBjb2xvdXI6IFwiZmJjYTA0XCIsXG4gICAgZGVzY3JpcHRpb246IFwiTWVkaXVtIHNldmVyaXR5IGZpbmRpbmdcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNldmVyaXR5Omxvd1wiLFxuICAgIGNvbG91cjogXCIwZThhMTZcIixcbiAgICBkZXNjcmlwdGlvbjogXCJMb3cgc2V2ZXJpdHkgZmluZGluZ1wiLFxuICAgIGNhdGVnb3J5OiBcImNvbnRlbnRcIixcbiAgfSxcbl07XG5cbi8qKlxuICogQ29uZmlkZW5jZSByYW1wIOKAlCBncmVlbiAoY2VydGFpbikg4oaSIHllbGxvdyDihpIgcGFsZSBncmVlbiAoc3BlY3VsYXRpdmUpLlxuICpcbiAqIERlbGliZXJhdGVseSBhIGRpZmZlcmVudCBodWUgZmFtaWx5IGZyb20gdGhlIHNldmVyaXR5IHJhbXAgc28gdGhlIHR3b1xuICogbmV2ZXIgcmVhZCBhcyB0aGUgc2FtZSBzaWduYWwgb24gb25lIGlzc3VlLlxuICovXG5jb25zdCBDT05GSURFTkNFX0xBQkVMUzogcmVhZG9ubHkgTGFiZWxEZWZpbml0aW9uW10gPSBbXG4gIHtcbiAgICBuYW1lOiBcImNvbmZpZGVuY2U6aGlnaFwiLFxuICAgIGNvbG91cjogXCIwZThhMTZcIixcbiAgICBkZXNjcmlwdGlvbjogXCJGaW5kaW5nIGlzIGNvbmZpcm1lZCDigJQgaGlnaCBjb25maWRlbmNlXCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjb25maWRlbmNlOm1lZGl1bVwiLFxuICAgIGNvbG91cjogXCJmYmNhMDRcIixcbiAgICBkZXNjcmlwdGlvbjogXCJGaW5kaW5nIGlzIGxpa2VseSBidXQgdW52ZXJpZmllZCDigJQgbWVkaXVtIGNvbmZpZGVuY2VcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNvbmZpZGVuY2U6bG93XCIsXG4gICAgY29sb3VyOiBcImMyZTBjNlwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkZpbmRpbmcgaXMgc3BlY3VsYXRpdmUg4oCUIGxvdyBjb25maWRlbmNlXCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuXTtcblxuLyoqXG4gKiBTZWN1cml0eS1mYW1pbHkgbGFiZWxzIOKAlCB0aGUgc2VjdXJpdHkgc2NhbiwgaXRzIHdob2xlLXRyZWUgc3dlZXAsIHRoZVxuICogc3VwcGx5LWNoYWluIGF1ZGl0cywgYW5kIHRoZSBkZXBlbmRlbmN5LWF1ZGl0IGZhaWx1cmUgbm90aWZpZXIuXG4gKi9cbmNvbnN0IFNFQ1VSSVRZX0xBQkVMUzogcmVhZG9ubHkgTGFiZWxEZWZpbml0aW9uW10gPSBbXG4gIHtcbiAgICBuYW1lOiBcInNlY3VyaXR5XCIsXG4gICAgY29sb3VyOiBcImI2MDIwNVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlNlY3VyaXR5IGZpbmRpbmcgcmFpc2VkIGJ5IHRoZSBzZWN1cml0eSBzY2FuXCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzZWN1cml0eS10cmVlLXN3ZWVwXCIsXG4gICAgY29sb3VyOiBcIjUzMTllN1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIldob2xlLXRyZWUgc2VjdXJpdHkgc3dlZXAgZmluZGluZ1wiLFxuICAgIGNhdGVnb3J5OiBcImNvbnRlbnRcIixcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VjdXJpdHktc2Nhbi1vdmVyZmxvd1wiLFxuICAgIGNvbG91cjogXCJmYmNhMDRcIixcbiAgICBkZXNjcmlwdGlvbjogXCJTZWN1cml0eSBzY2FuIHByb2R1Y2VkIG1vcmUgZmluZGluZ3MgdGhhbiBvbmUgYmF0Y2ggY2Fycmllc1wiLFxuICAgIGNhdGVnb3J5OiBcImNvbnRlbnRcIixcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3VwcGx5LWNoYWluLXJlYWRpbmVzc1wiLFxuICAgIGNvbG91cjogXCI1MzE5ZTdcIixcbiAgICBkZXNjcmlwdGlvbjogXCJTdXBwbHktY2hhaW4gcmVhZGluZXNzIGZpbmRpbmdcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN1cHBseS1jaGFpbjpxdWFyYW50aW5lLW1pc3NpbmdcIixcbiAgICBjb2xvdXI6IFwiNTMxOWU3XCIsXG4gICAgZGVzY3JpcHRpb246IFwiRGVwZW5kZW5jeSB1cGRhdGVzIHJ1biB3aXRoIG5vIHF1YXJhbnRpbmUgd2luZG93IGNvbmZpZ3VyZWRcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN1cHBseS1jaGFpbjpxdWFyYW50aW5lLW1pc2NvbmZpZ3VyZWRcIixcbiAgICBjb2xvdXI6IFwiNTMxOWU3XCIsXG4gICAgZGVzY3JpcHRpb246IFwiRGVwZW5kZW5jeSBxdWFyYW50aW5lIHdpbmRvdyBpcyBjb25maWd1cmVkIGluY29ycmVjdGx5XCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkZXBlbmRlbmN5LWF1ZGl0LWZhaWx1cmVcIixcbiAgICBjb2xvdXI6IFwiZDczYTRhXCIsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICBcIkEgc2NoZWR1bGVkIGRlcGVuZGVuY3kgYXVkaXQgZmFpbGVkIOKAlCBhIGNvbW1pdHRlZCBkZXBlbmRlbmN5IGhhcyBhIGtub3duIGFkdmlzb3J5LlwiLFxuICAgIGNhdGVnb3J5OiBcImNvbnRlbnRcIixcbiAgfSxcbl07XG5cbi8qKlxuICogU2Nhbi1jYXRlZ29yeSBsYWJlbHMg4oCUIG9uZSBwZXIgaWRsZS10YXNrIHNjYW4gdGVtcGxhdGUsIHNvIGEgcmVwbydzXG4gKiBmaW5kaW5ncyBjYW4gYmUgZmlsdGVyZWQgYnkgd2hpY2ggc2NhbiBwcm9kdWNlZCB0aGVtLlxuICovXG5jb25zdCBTQ0FOX0NBVEVHT1JZX0xBQkVMUzogcmVhZG9ubHkgTGFiZWxEZWZpbml0aW9uW10gPSBbXG4gIHtcbiAgICBuYW1lOiBcImJlc3QtcHJhY3RpY2VzXCIsXG4gICAgY29sb3VyOiBcIjUzMTllN1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkJlc3QtcHJhY3RpY2VzIHNjYW4gZmluZGluZ1wiLFxuICAgIGNhdGVnb3J5OiBcImNvbnRlbnRcIixcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGVzdC1hdWRpdFwiLFxuICAgIGNvbG91cjogXCJiNjAyMDVcIixcbiAgICBkZXNjcmlwdGlvbjogXCJUZXN0LWF1ZGl0IHNjYW4gZmluZGluZ1wiLFxuICAgIGNhdGVnb3J5OiBcImNvbnRlbnRcIixcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ2l0aHViLWFjdGlvbnMtYXVkaXRcIixcbiAgICBjb2xvdXI6IFwiYjYwMjA1XCIsXG4gICAgZGVzY3JpcHRpb246IFwiR2l0SHViIEFjdGlvbnMgYXVkaXQgZmluZGluZ1wiLFxuICAgIGNhdGVnb3J5OiBcImNvbnRlbnRcIixcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ2F0ZS1za2lwLWRyaWZ0XCIsXG4gICAgY29sb3VyOiBcImI2MDIwNVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlRoZSBsb2NhbCBxdWFsaXR5IGdhdGUgc2tpcHMgYSB0b29sIHRoaXMgcmVwbydzIENJIGVuZm9yY2VzXCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwb255dGFpbC1kZWJ0XCIsXG4gICAgY29sb3VyOiBcIjBlOGExNlwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkxlZGdlciBvZiBTSU1QTEUtT04tUFVSUE9TRSBtYXJrZXJzXCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJiYXNoLXN5bnRheC1hdWRpdFwiLFxuICAgIGNvbG91cjogXCJiNjAyMDVcIixcbiAgICBkZXNjcmlwdGlvbjogXCJCYXNoIHN5bnRheCBhdWRpdCBmaW5kaW5nXCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJiYXNoLW1pc3Npbmctc2NyaXB0XCIsXG4gICAgY29sb3VyOiBcImI2MDIwNVwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIkEgcmVmZXJlbmNlZCBiYXNoIHNjcmlwdCBpcyBtaXNzaW5nIGZyb20gdGhlIHJlcG9zaXRvcnlcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3VtZW50YXRpb24tYXVkaXRcIixcbiAgICBjb2xvdXI6IFwiMWQ3NmRiXCIsXG4gICAgZGVzY3JpcHRpb246IFwiRG9jdW1lbnRhdGlvbiBhdWRpdCBmaW5kaW5nXCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkdXBsaWNhdGVkLWtub3dsZWRnZVwiLFxuICAgIGNvbG91cjogXCIxZDc2ZGJcIixcbiAgICBkZXNjcmlwdGlvbjogXCJEdXBsaWNhdGVkLWtub3dsZWRnZSBzY2FuIGZpbmRpbmdcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJldHJvXCIsXG4gICAgY29sb3VyOiBcIjAwNTJjY1wiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJSZXRybyBjYW5kaWRhdGUg4oCUIGVudmlyb25tZW50IGltcHJvdmVtZW50IGZyb20gYSBmaW5pc2hlZCBydW5cIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImZvcm1hdC1kcmlmdFwiLFxuICAgIGNvbG91cjogXCIxZDc2ZGJcIixcbiAgICBkZXNjcmlwdGlvbjogXCJGb3JtYXR0aW5nIGRyaWZ0IGZpbmRpbmdcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRlYWQtY29kZVwiLFxuICAgIGNvbG91cjogXCI1MzE5ZTdcIixcbiAgICBkZXNjcmlwdGlvbjogXCJEZWFkLWNvZGUgc2NhbiBmaW5kaW5nXCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkZXByZWNhdGVkLWFwaVwiLFxuICAgIGNvbG91cjogXCIwZThhMTZcIixcbiAgICBkZXNjcmlwdGlvbjogXCJEZXByZWNhdGVkLUFQSSBzY2FuIGZpbmRpbmdcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvYy1jb3ZlcmFnZVwiLFxuICAgIGNvbG91cjogXCIwZThhMTZcIixcbiAgICBkZXNjcmlwdGlvbjogXCJEb2N1bWVudGF0aW9uLWNvdmVyYWdlIHNjYW4gZmluZGluZ1wiLFxuICAgIGNhdGVnb3J5OiBcImNvbnRlbnRcIixcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid29ya2Zsb3ctYW5ub3RhdGlvbi1zY2FuXCIsXG4gICAgY29sb3VyOiBcIjBlOGExNlwiLFxuICAgIGRlc2NyaXB0aW9uOiBcIldvcmtmbG93IGFubm90YXRpb24gc2NhbiBmaW5kaW5nXCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwcml2YXRlLXJlcG8tcmVmZXJlbmNlXCIsXG4gICAgY29sb3VyOiBcIjUzMTllN1wiLFxuICAgIGRlc2NyaXB0aW9uOiBcIlJlZmVyZW5jZSB0byBhIHByaXZhdGUgcmVwb3NpdG9yeSBmcm9tIGEgcHVibGljIG9uZVwiLFxuICAgIGNhdGVnb3J5OiBcImNvbnRlbnRcIixcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYWxlcnQtZmVlZFwiLFxuICAgIGNvbG91cjogXCJkOTNmMGJcIixcbiAgICBkZXNjcmlwdGlvbjogXCJGaW5kaW5nIHJhaXNlZCBmcm9tIGEgbW9uaXRvcmVkIHNlY3VyaXR5IGFsZXJ0IGZlZWRcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG5dO1xuXG4vKipcbiAqIE91dGNvbWUgbGFiZWxzIOKAlCBhcHBsaWVkIGJ5IHRoZSB3b3JrZXIgdG8gcmVjb3JkIGhvdyBhIHBpZWNlIG9mIHdvcmtcbiAqIGVuZGVkIHJhdGhlciB0aGFuIHdoYXQgaXQgZm91bmQuXG4gKi9cbmNvbnN0IE9VVENPTUVfTEFCRUxTOiByZWFkb25seSBMYWJlbERlZmluaXRpb25bXSA9IFtcbiAge1xuICAgIG5hbWU6IFwibmVnYXRpdmUtcmVzdWx0XCIsXG4gICAgY29sb3VyOiBcImM1ZGVmNVwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJQZXJmb3JtYW5jZSB3b3JrIG1lYXN1cmVkIG5vIGltcHJvdmVtZW50IOKAlCBkbyBub3QgcmUtYXR0ZW1wdCB3aXRob3V0IG5ldyBldmlkZW5jZVwiLFxuICAgIGNhdGVnb3J5OiBcImNvbnRlbnRcIixcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWVyZ2UtY29uZmxpY3RcIixcbiAgICBjb2xvdXI6IFwiYjYwMjA1XCIsXG4gICAgZGVzY3JpcHRpb246IFwiUFIgY29uZmxpY3RzIHdpdGggaXRzIGJhc2UgYnJhbmNoIGFuZCBuZWVkcyBhIHJlYWwgbWVyZ2VcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1lcmdlLWZhbGxiYWNrXCIsXG4gICAgY29sb3VyOiBcImQ5M2YwYlwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJBIG1lcmdlIGNvbmZsaWN0IGZlbGwgYmFjayB0byB0aGUgbGFzdCBrbm93biBnb29kIHN0YXRlIOKAlCB3aGF0IHdhcyBjbG9zZWQgb3IgcmV2ZXJ0ZWQsIGFuZCB3aHlcIixcbiAgICBjYXRlZ29yeTogXCJjb250ZW50XCIsXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImVzY2FsYXRlZFwiLFxuICAgIGNvbG91cjogXCJkNGM1ZjlcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiVGhlIGZsZWV0IGZpbGVkIHRoaXMgUFIncyBibG9ja2FnZSBhcyB3b3JrOyBpdCBpcyBub3Qgd2FpdGluZyBvbiBhIGh1bWFuXCIsXG4gICAgY2F0ZWdvcnk6IFwiY29udGVudFwiLFxuICB9LFxuXTtcblxuLyoqXG4gKiBgbGFuZzoqYCBidWNrZXRzIGZyb20gdGhlIGJlc3QtcHJhY3RpY2VzIHNjYW4uXG4gKlxuICogT25lIGVudHJ5IHBlciB7QGxpbmsgU3VwcG9ydGVkTGFuZ3VhZ2V9IGJ1Y2tldCwgcGx1cyB0aGUgdHdvXG4gKiBsYW5ndWFnZS1hZ25vc3RpYyBidWNrZXRzIChgZ2VuZXJhbGAsIGBkZXNpZ25gKSBhbmQgdGhlIGxlZ2FjeVxuICogYGxhbmc6Z2l0aHViLWFjdGlvbnNgIGJ1Y2tldC4gQ29sb3VycyBmb2xsb3cgZWFjaCBsYW5ndWFnZSdzIG93biBicmFuZFxuICogY29sb3VyIHNvIHRoZSBidWNrZXQgaXMgcmVjb2duaXNhYmxlIGF0IGEgZ2xhbmNlLlxuICovXG5jb25zdCBMQU5HVUFHRV9MQUJFTFM6IHJlYWRvbmx5IExhYmVsRGVmaW5pdGlvbltdID0gW1xuICBbXCJnZW5lcmFsXCIsIFwiYzJlMGM2XCJdLFxuICBbXCJkZXNpZ25cIiwgXCJiZmQ0ZjJcIl0sXG4gIFtcInJ1c3RcIiwgXCJkZWE1ODRcIl0sXG4gIFtcInR5cGVzY3JpcHRcIiwgXCIxZDc2ZGJcIl0sXG4gIFtcInJlYWN0XCIsIFwiNjFkYWZiXCJdLFxuICBbXCJqYXZhXCIsIFwiYjA3MjE5XCJdLFxuICBbXCJodG1sXCIsIFwiZTM0YzI2XCJdLFxuICBbXCJhd3MtY2xvdWRmb3JtYXRpb25cIiwgXCJmZjk5MDBcIl0sXG4gIFtcInRlcnJhZm9ybVwiLCBcIjdiNDJiY1wiXSxcbiAgW1wiZ2l0aHViLWFjdGlvbnNcIiwgXCIyMDg4ZmZcIl0sXG5dLm1hcCgoW2J1Y2tldCwgY29sb3VyXSkgPT4gKHtcbiAgbmFtZTogYGxhbmc6JHtidWNrZXR9YCxcbiAgY29sb3VyOiBjb2xvdXIhLFxuICBkZXNjcmlwdGlvbjogYEJlc3QtcHJhY3RpY2VzIGZpbmRpbmcgZm9yIHRoZSBcXGAke2J1Y2tldH1cXGAgYnVja2V0YCxcbiAgY2F0ZWdvcnk6IFwiY29udGVudFwiIGFzIGNvbnN0LFxufSkpO1xuXG4vKipcbiAqIEV2ZXJ5IGNvbnRlbnQgbGFiZWwgdGhlIGZsZWV0IG1hbmFnZXMsIGdyb3VwZWQgYnkgZmFtaWx5LlxuICpcbiAqIE9yZGVyIGlzIGZhbWlseS1ieS1mYW1pbHkgc28gdGhlIHRhYmxlIHJlYWRzIGFzIGZhbWlsaWVzIHJhdGhlciB0aGFuIGFuXG4gKiBhbHBoYWJldGljYWwgc291cC5cbiAqL1xuZXhwb3J0IGNvbnN0IENPTlRFTlRfTEFCRUxfREVGSU5JVElPTlM6IHJlYWRvbmx5IExhYmVsRGVmaW5pdGlvbltdID0gW1xuICAuLi5TRVZFUklUWV9MQUJFTFMsXG4gIC4uLkNPTkZJREVOQ0VfTEFCRUxTLFxuICAuLi5TRUNVUklUWV9MQUJFTFMsXG4gIC4uLlNDQU5fQ0FURUdPUllfTEFCRUxTLFxuICAuLi5PVVRDT01FX0xBQkVMUyxcbiAgLi4uTEFOR1VBR0VfTEFCRUxTLFxuXTtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBa0JDLEdBSUQ7Ozs7OztDQU1DLEdBQ0QsTUFBTSxrQkFBOEM7RUFDbEQ7SUFDRSxNQUFNO0lBQ04sUUFBUTtJQUNSLGFBQWE7SUFDYixVQUFVO0VBQ1o7RUFDQTtJQUNFLE1BQU07SUFDTixRQUFRO0lBQ1IsYUFBYTtJQUNiLFVBQVU7RUFDWjtFQUNBO0lBQ0UsTUFBTTtJQUNOLFFBQVE7SUFDUixhQUFhO0lBQ2IsVUFBVTtFQUNaO0VBQ0E7SUFDRSxNQUFNO0lBQ04sUUFBUTtJQUNSLGFBQWE7SUFDYixVQUFVO0VBQ1o7Q0FDRDtBQUVEOzs7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
// denoCacheMetadata=4784542179555302241,149249167608036152