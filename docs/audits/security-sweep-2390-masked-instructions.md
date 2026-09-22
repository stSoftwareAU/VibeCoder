# 🔎 Security sweep — the masked-instruction detector (`masked_instructions.ts`)

**Issue:** [#2390](https://github.com/stSoftwareAU/VibeCoder/issues/2390) (chunk
top-up-2390) · **Parent:** #1209

This is the written record for the one module that entered `worker/deno/lib/`
under #2390:

- `worker/deno/lib/masked_instructions.ts`

## Why a new slice rather than a line in an old one

Appending a module to a slice whose sweep ran before it existed is the cheapest
way to make `diffCoverage` green and a false record. The module is claimed by
**top-up-2390**, and this file is the reading of it.

## `worker/deno/lib/masked_instructions.ts`

A pure judgement over an issue body: which instruction lines carry a mask
placeholder as the value of an assignment. It spawns nothing, reads nothing and
writes nothing. Two callers act on it — `gh_body_redaction.ts` appends a notice
when the worker files such an issue, and `clarity_phase.ts` asks for the value
through the existing `## Clarification Needed` route instead of invoking the
agent.

| Input                                        | Source                                                                          | How it is handled                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body`                                       | an issue body — **untrusted**, writable by anyone who can open or edit an issue | scanned line by line; never executed, never interpolated into a prompt, never parsed as Markdown beyond an anchored heading test and a fence toggle. A body over 256 KiB is not scanned at all |
| `hits` (to the question and notice builders) | the detector's own output                                                       | each quoted line is cut to 160 characters and at most five are shown. Backticks in a quoted line are replaced so it cannot open a code span in the comment                                     |

| Property                                  | Result                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| can it leak a secret?                     | no. It only ever sees text **after** the mask ran (the filer calls it on the masked body; the pickup path reads the published body), and it selects lines _because_ they carry the placeholder. The clarification route applies `redactSecrets` to the questions again regardless                      |
| can it unmask, or weaken the mask?        | no. It never alters masked text; the filer appends a notice **after** the mask and the placeholder stays. The notice and the question both tell the author not to paste a real secret                                                                                                                  |
| can an attacker use it to stall an issue? | anyone who can edit an issue body can make the worker ask one question — the same power as writing an unclear issue, through the same route, under the same round cap (`maxClarificationRounds`). It cannot loop: once the worker's own question has a reply from another account the gate stands down |
| can an attacker use it to skip the gate?  | the "answered" test counts only a question posted by **this worker's account** — the marker is text anyone can write, the author is not (the Issue #1263 rule). A stranger posting the marker and a reply changes nothing                                                                              |
| prompt injection                          | none of its input or output reaches a model. Its whole effect on the agent is that the agent is **not invoked**                                                                                                                                                                                        |
| regex safety                              | three patterns: two heading-word alternations tested against a single heading line, and one assignment test with a bounded `\s{0,8}`. No nested quantifier; the scan is one pass over the lines                                                                                                        |
| network / filesystem / spawn              | none                                                                                                                                                                                                                                                                                                   |
| fail direction                            | towards asking. If the question cannot be posted the clarity phase returns `failure` rather than proceed on a masked instruction — guessing is the one outcome the gate exists to stop                                                                                                                 |
| blast radius                              | a body with no placeholder returns on the first fixed-string test, so every ordinary issue is untouched. A secret masked in running prose, a quoted log, an evidence section or a pasted-log fence is not a hit                                                                                        |
