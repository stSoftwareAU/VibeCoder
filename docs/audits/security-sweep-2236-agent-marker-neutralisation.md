# 🔎 Security sweep — agent marker neutralisation (`agent_marker_neutralisation.ts`)

**Issue:** [#2236](https://github.com/stSoftwareAU/VibeCoder/issues/2236) (chunk
top-up-2236) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2236:

- `worker/deno/lib/agent_marker_neutralisation.ts` — added by #2236.

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2236**, and this file is the reading of it.

## `worker/deno/lib/agent_marker_neutralisation.ts`

One exported pure function, `neutraliseAgentMarkers`, called from the
`readPrResponseMessage` chokepoint (`pr_branch_preparation.ts`). It makes every
HTML-comment delimiter in agent-authored text inert before that text is
concatenated into a comment body the fleet account authors.

| Input  | Source                                                      | How it is handled                                                                                                                                                |
| ------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text` | the agent's `.pr_response_message`, already secret-redacted | scanned by three fixed literal/character-class patterns and rewritten by two literal replacements. Never interpolated into an argv, a path, a query or a pattern |

| Property          | Result                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| spawn chokepoints | none — the module constructs no `Deno.Command` and calls no spawn helper                                                                                                                                                                                           |
| filesystem        | none                                                                                                                                                                                                                                                               |
| network           | none                                                                                                                                                                                                                                                               |
| regex safety      | three patterns, all linear. `/<!--/g` and `/-->/g` are literals; `/<!--\s*([A-Za-z][A-Za-z0-9_:.-]*)/g` has a single bounded-alternation-free character class after a literal anchor, so it cannot backtrack catastrophically. No pattern is built from a variable |
| output bounds     | the reported names are capped at 5 entries of 64 characters, so hostile text cannot flood a log line. The returned text is not truncated — the agent's message must stay readable                                                                                  |
| bypass surface    | neutralisation is by construction, not by marker name: a marker added years from now is defused by the same two replacements. A space is kept inside each neutralised token (`<!- -`, `- ->`) so a longer run of dashes cannot re-form the delimiter               |
| secret surface    | holds no credential; `redactSecrets` runs before this module sees the text                                                                                                                                                                                         |
| fail direction    | the count and the names are returned to the caller, which logs `AGENT_MARKER_NEUTRALISED` through `logger.security`. Nothing is swallowed and nothing is deleted — a defused marker stays visible in the posted comment                                            |

## The invariant this module exists to hold

Agent-authored text sits inside a container the fleet account signs. The CI-fix
attempt/deferral record (#1879) is gated on the comment's **author**, not on
where inside the body a marker came from, so marker syntax reaching that body
from the agent is read back as the fleet's own claim. This module removes the
syntax, at the one chokepoint every PR-comment consumer of
`.pr_response_message` reads through.

## The caller contract this module cannot enforce

The module is pure: it neither reads the file nor posts the comment. A future
sink that concatenates agent text into a fleet-authored body **without** reading
through `readPrResponseMessage` would not be covered. The three production
readers (`pr_ci_processor.ts`, `pr_feedback_processor.ts`,
`merge_conflict_agent.ts`) all go through that chokepoint, and each passes a
logger so the defusal is recorded rather than swallowed.

## Verdict

**Swept, no findings.** A pure string transform with no spawn, filesystem,
network or secret surface, bounded output, and linear patterns.
