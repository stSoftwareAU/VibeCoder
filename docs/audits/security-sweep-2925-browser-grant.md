# Security sweep — browser grant (`browser_grant.ts`)

**Issue:** [#2925](https://github.com/stSoftwareAU/VibeCoder/issues/2925) (chunk
top-up-2925) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
after the chunk-12 slices (12a–12af) recorded their coverage:

- `worker/deno/lib/browser_grant.ts` — added by #2925.

## `worker/deno/lib/browser_grant.ts`

The module decides whether an agent run is handed the Playwright MCP browser:
every run unless the repository sets `skip_screenshot_check`. It widens the
grant Issue #192 had narrowed to an explicit screenshot need, so the review
looks at what now reaches the browser, not at the one-line predicate.

Shapes checked:

| Property                                         | Result                                                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the decision reads only operator configuration   | the sole input is the operator's `repo_config` map and the repository name; no issue, PR or comment text can switch the browser on or off                                               |
| the operator opt-out still wins                  | `skip_screenshot_check: true` returns `false`, so that repository's runs start no Chromium and no MCP server, as Issue #1584 required                                                   |
| the server's own guards are unchanged            | `generateMcpConfig` still blocks the cloud metadata origins, denies the worker's secrets by `--deny-env` and in the `env` block, and uses a disposable profile outside the checkout     |
| the grant is limited to code-changing runs       | issue execute, PR-feedback and CI-fix runs ask it; planning, question and grill-me runs never do and keep no browser                                                                    |

Residual risk, accepted by the owner on #2925: a prompt-injected agent on a
backend issue now has a browser tool it did not have. It already had outbound
network through `gh`, `git`, `deno` and `npm`, and the metadata endpoints stay
blocked.

No findings. The module is covered by
`worker/deno/tests/execute_phase_browser_grant_test.ts`,
`worker/deno/tests/execute_claude_phase_test.ts`,
`worker/deno/tests/pr_feedback_processor_codegraph_2160_test.ts` and
`worker/deno/tests/pr_ci_processor_codegraph_2160_test.ts`.
