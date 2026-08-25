# Default the LaunchAgent / scheduled-task install prompt to NO

## Summary

The prompt read `[Y/n]`, so a bare Enter installed the LaunchAgent:

```bash
echo -n "  Install the LaunchAgent now? [Y/n] "
read -r install_launchagent
if [[ "$install_launchagent" != "n" && "$install_launchagent" != "N" ]]; then
    run_setup_cli launchagent
```

That branch installs on *everything* except a literal `n`/`N` — Enter, `no`,
`maybe`, a stray space, a typo. And what it installs is a **second worker**:
launchd then runs `run.sh` every five minutes on a host where the operator may
already be running `./loop.sh` by hand. Two workers on one host collide on the
work volumes (Issue #26), which is exactly why the prompt exists.

On GRQ-23 that is what happened. The agent was installed, launchd ran the
worker beside the operator's own loop, and it went unnoticed until the two were
found fighting over the same volume. The operator's report was "it didn't seem
to ask me" — which is what a default-yes prompt feels like from the other side
when it sits in a wall of setup output.

The safe answer is the one that changes nothing, so it is now the one Enter
gives you:

- the prompt reads `[y/N]`;
- only `y`, `Y`, `yes` or `YES` installs — every other answer, including a
  typo, declines;
- the guidance is inverted to say when to answer *yes*, and names the hazard.

`setup.ps1` gets the same treatment: the Windows scheduled task is the same
hazard, registered by the same default-yes prompt.

Neither *removal* prompt changes. Those default to yes, which is correct — the
operator has just declined the install, and "no" there must never silently mean
"keep the one you have".

## Evidence

Three tests, two of which fail against the unfixed script. They drive the real
`prompt_launchagent_setup` in a bash subprocess with the install path stubbed,
so they assert what the branch *does*, not what the prompt says:

```text
$ deno test --allow-all tests/setup_launchagent_prompt_test.ts   # before
FAILED | 1 passed | 2 failed
```

```text
$ deno test --allow-all tests/setup_launchagent_prompt_test.ts \
    tests/setup_parity_test.ts tests/launcher_parity_test.ts     # after
ok | 30 passed | 0 failed (31s)
```

- a bare Enter does **not** install;
- `y`/`Y`/`yes`/`YES` install; `n`/`N`/`no`/`maybe`/`  `/`yep` do not;
- both scripts' prompts are marked `[y/N]`, so the marker shown to the operator
  matches the branch behaviour the first two tests verify.
