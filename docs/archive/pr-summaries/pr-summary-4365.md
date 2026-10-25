# PR summary — #4365

Capability-scoped security guidance now lives in `prompts/capability_security/bundle.json` (revision `2026-10-26.1`). Five capabilities: resource and tenant authorisation with a writable-field allowlist, safe process and query execution, outbound URL and TLS, file boundaries and resource limits, and secret-safe logging. Selection uses the task, entry points, imports, callers and sinks. A file extension does not select a capability. `buildIssuePrompt` renders the selected sections into `prompts/issue/prompt.md` for every provider fragment under `container/providers/`. The run record is one line of revision and signal ids. An unreadable bundle is reported as not applied. The behavioural fixture is `updateResource` in `worker/deno/lib/capability_security_fixtures/resource_update.ts`.

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
