# PR summary — #4365

Capability-scoped security guidance now lives in `prompts/coding_guidelines/capability-security.json` (revision `2026-10-26.1`). Five capabilities: resource and tenant authorisation with a writable-field allowlist, safe process and query execution, outbound URL and TLS, file boundaries and resource limits, and secret-safe logging. Selection uses the task, entry points, imports, callers and sinks. A file extension does not select a capability. `buildIssuePrompt` renders the selected sections into `prompts/issue/prompt.md` for every provider fragment under `container/providers/`. The run record is one line of revision and signal ids. An unreadable bundle is reported as not applied. The behavioural fixture is `updateResource` in `worker/deno/lib/capability_security_fixtures/resource_update.ts`.

Closes #4365

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — A representative issue run for an authenticated resource update receives relevant authorisation/mass-assignment guidance; a docs-only change receives no application-security bundle. — evidence: `worker/deno/tests/capability_security_guidance_4365_test.ts` — reviewer: met
- **met** — Mixed-language and newly discovered security-sensitive paths are covered; missing/unreadable applicable guidance is reported explicitly, never recorded as successfully applied. — evidence: `worker/deno/tests/capability_security_guidance_4365_test.ts` — reviewer: met
- **met** — Tests call the actual selection/rendering path and exercise every supported provider path, relevant/irrelevant contexts and a scope change; reverting the routing makes them fail. — evidence: `worker/deno/tests/capability_security_guidance_4365_test.ts` — reviewer: met
- **met** — Behavioural fixtures prove an authorised request succeeds and an unauthorised/cross-resource request fails at the intended control, with the feature wired through its real entry point. — evidence: `worker/deno/lib/capability_security_fixtures/resource_update.ts` — reviewer: met
- **met** — Record selected guidance revision and applicability evidence in existing run evidence, without duplicating prompts or logging sensitive input. — evidence: `worker/deno/lib/prompt_builder.ts` — reviewer: met
- **met** — Run existing appropriate quality checks. Do not add another generic verification stage or prompt-presence-only test. — evidence: `worker/deno/tests/capability_security_guidance_4365_test.ts` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, tests through the real prompt path, no version bump in `worker/deno/deno.json`, and no secrets in the guidance record.

## Review follow-up

An issue run inspects the paths named in the task: the files themselves, config beside a named code file, and neighbouring callers. That set is passed into `buildIssuePrompt`, and the next run selects again when the set changes. A later import or sink renders that capability's advice. A docs-only task that names no path still receives no capability advice. The re-evaluate instruction stays when nothing matches, because a later entry point, import, caller, config or sink can make a capability apply.

## CI repair

The intentionally empty TypeScript fixture now contains only a comment. It still exports no implementation, while satisfying the repository's zero-length-file check.

The bundle is shared data under the existing coding-guidelines directory, so prompt discovery no longer mistakes it for a standalone prompt type. Callers, fixtures and documentation use the same new path. The five new modules were reviewed and registered in a sweep slice anchored to main. Evaluation subprocesses use the shared timeout helper with a 60-second bound. Validation: 40 focused capability, evaluation and timeout checks and all 866 manifest checks passed (one ignored); formatting, lint and the sweep-ancestry gate pass. The local evaluation records 14 fixture outcomes; only the secure implementations pass both dimensions, and live model comparison remains partial.
