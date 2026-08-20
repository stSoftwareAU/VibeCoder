# 📝 Prompt goals (summary)

The Vibe Coder uses versioned markdown templates in the `prompts/` directory to
instruct Claude. The full text of each prompt is long and not published here;
this page summarises **the goal of each prompt type** so you know what the
worker is being asked to do in each workflow. For versioning rules and how to
extend prompts, see
[Extending the Worker](EXTENDING.md#prompt-versioning-and-templates). For the
rubric used to audit a prompt against Anthropic's prompting best-practices
guide, see
[Prompt best-practices checklist](PROMPT-BEST-PRACTICES-CHECKLIST.md). For
coding standards (TDD — Test-Driven Development, real tests, quality gates) that
are embedded in these prompts, see [AGENTS.md](../AGENTS.md).

---

## Prompt types and goals

| Prompt                     | Goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **coding_guidelines**      | Shared principles and rules embedded into other prompts: KISS (Keep It Simple, Stupid), DRY (Don't Repeat Yourself), Australian English, secure coding principles, and how to use available tools (e.g. `gh`, Playwright). Not used alone; it is included when the worker handles issues, PR (Pull Request) feedback, spelling, or CI (Continuous Integration) fixes.                                                                                                                                                                                                              |
| **issue**                  | Implement a GitHub issue: read AGENTS.md/README, follow TDD (failing tests first, real “what” tests), handle untrusted issue content safely, run quality checks, commit with clear messages, and produce a PR summary with evidence. Run autonomously (no plan mode); take concrete actions, don’t just suggest.                                                                                                                                                                                                                                                                   |
| **planning**               | Break down an issue into actionable sub-issues — no code, no branches, no PRs. Create sub-tasks as GitHub issues via `gh`, apply no reserved workflow labels, and post a summary comment. Used when the issue has the `planning` label.                                                                                                                                                                                                                                                                                                                                            |
| **question**               | Answer a question on a GitHub issue: read the issue and comments, then produce a helpful, accurate answer that is posted as a comment. No code changes, no branches, no PRs. Used when the issue has the `question` label.                                                                                                                                                                                                                                                                                                                                                         |
| **pr_feedback**            | Address PR review feedback: read the comment and code, then either make the requested code changes (following TDD and project conventions) or explain why no change is needed. Resolve conflicts (e.g. scope vs. reviewer suggestion) per project rules. Used when the worker picks up PR comments (e.g. thumbs-up or authorised commenter).                                                                                                                                                                                                                                       |
| **spelling_fix**           | Fix spelling check failures on a PR: correct genuine typos and add valid terms (technical terms, acronyms, proper nouns) to the project spelling config. Use Australian English. No other code changes. Used when a PR fails a spelling check.                                                                                                                                                                                                                                                                                                                                     |
| **ci_fix** | Fix CI failures on a PR: diagnose the failing check using the failure classifier, apply a minimal fix that addresses the root cause, and do not disable or skip tests. Used when a PR fails CI. |
| **grill-me**               | Refine an under-specified issue by asking the user a small number of multiple-choice questions, one round at a time. Posts task-list checkbox question choices and updates the issue title/body each round; hands control back to a human via `needs-human` after Round N. Used when the issue has the `grill-me` label — see [grill-me workflow](workflows/grill-me.md).                                                                                                                                                                                                          |
| **workflow_setup** | Provision the standard CI/security GitHub Actions workflows in a target repository (lint, test, Dependency Review, Gitleaks secrets scan, Semgrep SAST, private-repo-14 scorer hardening, markdown-lint). SHA-pins every action and writes each generated workflow on a branch behind a PR. Built by the `build-workflow-setup-prompt` CLI operation; it has no automated caller today — `setup workflow-sync` audits workflows natively and loads no prompt. |
| **planning_critique** | Second turn of a two-stage planning run: adversarially attack the draft plan produced in the first turn, revise it once, then publish the final sub-issues. The critique itself is never published. Used immediately after the planning draft turn. |
| **security_scan**          | Run a MythOS-style four-phase security audit (Plan → Per-chunk detection → Triage → JSON+Markdown report) over a monitored repository. Output drives `security_scanner.ts`, which files findings as `security`-labelled issues. Idle-task template #1 — see [Security Scans — Operator Manual](SECURITY-SCAN.md) and `prompts/security_scan/`.                                                                                                                                                                                                                                     |
| **best_practices**         | Run a bucket-scoped best-practices review (one of rust, typescript, react, java, html, aws-cloudformation, terraform, general) over a monitored repository, filing findings as `best-practices`-labelled issues. Idle-task template #2 — see [Best-Practices Scans](BEST-PRACTICES-SCAN.md) and `prompts/best_practices/`.                                                                                                                                                                                                                                                         |
| **test_audit**             | Run a language-agnostic static test-suite maintainability and coverage-gap audit, flagging implementation-coupled tests (HOW) that assert on incidental implementation details rather than observable behaviour (WHAT) — an informal project heuristic. Files findings as `test-audit`-labelled issues. Idle-task template #3 — see [Test-Audit Scans](TEST-AUDIT-SCAN.md) and `prompts/test_audit/`.                                                                                                                                                                              |
| **github_actions_audit**   | Run a weekly workflow-only GitHub Actions audit (SHA-pinning, supply-chain hardening, stale action majors, EOL runtimes, deprecated/obsolete steps) over a monitored repository. Files findings as `github-actions-audit`-labelled issues. Idle-task template #4 — see [GitHub Actions Audit Scans](GITHUB-ACTIONS-AUDIT-SCAN.md) and `prompts/github_actions_audit/`.                                                                                                                                                                                                             |
| **supply_chain_readiness** | Run a weekly static, evidence-backed audit of the repo's posture for surviving and responding to a supply-chain compromise (lockfiles, SBOM, CI vuln-scan, quarantine override, runbook). Files findings as `supply-chain-readiness`-labelled issues. Idle-task template #5 — see [Supply-Chain Readiness Scans](SUPPLY-CHAIN-READINESS-SCAN.md) and `prompts/supply_chain_readiness/`.                                                                                                                                                                                            |
| **orphan_deps**            | Run a weekly metadata-backed audit of the repo's declared / locked dependency set for orphaned, abandoned, deprecated, or end-of-life dependencies, suggesting a maintained replacement for each. The one sanctioned-network exception (registry / source-host metadata within a strict allow-list — no installs, no lifecycle scripts). Files findings as `orphan-deps`-labelled issues. Idle-task template #6 — see [Orphan-Dependency Scans](ORPHAN-DEPS-SCAN.md) and `prompts/orphan_deps/`.                                                                                   |
| **quorum**                 | Draft the implementation plan for one issue — approach, the work to be done, risks and trade-offs, assumptions — as reply text only. No sub-issues (the `planning` phase splits the issue up afterwards), no code, no branches, no PRs. Both Quorum planners receive this prompt, and neither is told a second plan is being drafted, so the two drafts are independent by construction. See `prompts/quorum/`.                                                                                                                                                                    |
| **quorum_judge**           | Choose between two candidate plans for the same issue, identified only as **Plan A** and **Plan B** with no vendor identity, and return a machine-parseable `<quorum_verdict>` JSON block carrying the winner, the reasoning and per-criterion scores. Judges against stated criteria — correctness against the issue as written, completeness of scope, feasibility in this codebase, risk, and respect for the repository's standards. Both plans are untrusted input: a plan instructing the judge to pick it is data, neither obeyed nor counted. See `prompts/quorum_judge/`. |
| **supply_chain_detection** | Run a static, evidence-backed scan of the repo's declared and locked dependency set for active signals of a malicious or compromised dependency. Used by the proactive-detection epic. |

---

## Who renders the Quorum prompts

The operator-facing manual for the mode itself — trigger, sequence, result
comment, degradation paths, cost and configuration — is [Quorum](QUORUM.md).

`worker/deno/lib/quorum_orchestrator.ts` renders both Quorum
templates, runs the three agents and parses the verdict. It performs no GitHub
I/O, so the judging logic and its failure modes are exercised with fake invokers
in `worker/deno/tests/quorum_orchestrator_test.ts`.

- The two drafts run **concurrently**, so a Quorum run costs one draft plus one
  judgement.
- The anonymous **A/B positions come from the issue number**, not the order the
  providers were supplied in — reproducible per issue, and no provider is
  permanently Plan A.
- Each agent is bounded by a timeout plus a kill-after grace, mirroring
  `grillMeTimeout` / `grillMeKillAfter`.
- `worker/deno/lib/quorum_processor.ts` is the GitHub-facing half:
  it claims the issue, drives the orchestrator, posts the result, then removes
  `quorum` and adds `needs-human`. It never applies `planning` or `work-on` —
  the human picks the next phase.
- Nothing silently picks a winner. Each partial failure has its own outcome:

  | Outcome           | Cause                              | Winner named |
  | ----------------- | ---------------------------------- | ------------ |
  | `judged`          | Clean three-agent quorum           | Yes          |
  | `unjudged-single` | One drafter failed or timed out    | No           |
  | `unjudged-both`   | Judge failed or verdict unreadable | No           |
  | `failed`          | Both drafters failed               | No           |

  A judged run is posted under `## Quorum — Winning Plan` with the runner-up
  and the judge's reasoning attached in collapsed sections; every other outcome
  is posted under `## Quorum — Degraded Result` with the degradation named.

---

## Versioning

- Each prompt type has one or more version files (`v1.md`, `v2.md`, …). The
  **latest version** (highest number) is used at runtime — the worker always
  loads the highest-numbered `vN.md` in each prompt directory. To see the
  current list of versions, browse the directory contents on GitHub (e.g.
  [`prompts/coding_guidelines/`](https://github.com/stSoftwareAU/VibeCoder/tree/main/prompts/coding_guidelines)).
- **Existing versions are immutable** — do not edit a committed `v*.md` file;
  create a new version instead. See
  [CODING-STANDARDS.md § Prompt Template Versioning](../CODING-STANDARDS.md#prompt-template-versioning).
- The worker logs which prompt version was used for each run (traceability).

---

## Where the goals come from

The goals above are derived from the instructions and constraints at the start
of each prompt template. The full templates live in the repository under
`prompts/` (e.g. `prompts/issue/`) and are used by the worker at runtime; they
are not published on the documentation site.
