# 📣 Release notes

Every merge to `main` is tagged with the next patch semver automatically, and a
patch carries nothing an operator has to read: the code moved, the
[`tool-versions.json` manifest](RELEASE-TAGGING.md#the-tool-version-manifest)
says what it was cut against, and a frozen host upgrades onto it with
`./run.sh upgrade`.

This page is for the other kind of release — one that **changes a contract an
operator's configuration depends on**. Those releases move the minor or the
major, are minted from [the release floor](RELEASE-TAGGING.md#the-release-floor)
rather than from the automatic increment, and are recorded here newest first,
with the exact migration and the exact rollback.

## 1.1.0 — the post-run callback extension point

**Configuration contract change. Read the migration before upgrading a host.**

### What changed

| Change                                                                                                                | Issue |
| --------------------------------------------------------------------------------------------------------------------- | ----- |
| A `callbacks` block runs `success` / `failure` / `always` executables after every terminal issue run                    | #806  |
| Built-in fleet health reporting removed, along with the `fleet_health_dir` and `fleet_health_repo` configuration keys   | #805  |
| The extension contract documented, with a conformance fixture an extension runs against its own hooks                   | #807  |

The point of the three together: **fleet-specific reporting policy leaves
VibeCoder**. A host that wants health records, session-log archival or spend
accounting writes a hook and names it in `callbacks`; the worker guarantees
when the hook runs, what it receives and that its failure never changes the
run's own result. The full contract is [Post-Run Callbacks](CALLBACKS.md); the
configuration surface is
[Configuration — Post-Run Callbacks](CONFIGURATION.md#-post-run-callbacks).

### Breaking: two configuration keys were removed

| Removed key          | What replaces it                                                     |
| -------------------- | -------------------------------------------------------------------- |
| `fleet_health_repo`  | a `callbacks.success` or `callbacks.always` hook that owns its own checkout, schedule and record format |
| `fleet_health_dir`   | nothing — the hook decides where it writes                            |

A configuration that still carries either key **fails the config load** naming
both keys and the replacement; the worker stops and claims no issue. This is
deliberate (Issue #805): a key that reads as live and quietly does nothing is
the silent failure the config load exists to prevent. It is also why the
release moves the minor rather than the patch — a 1.0.x configuration is not
loadable by 1.1.0 until it is migrated.

The asymmetry matters for the ordering below:

- **`callbacks` is safe to add early.** A 1.0.x worker does not recognise the
  key, so it logs one unknown-key warning at config load and ignores the block.
- **`fleet_health_*` is not safe to leave.** A 1.1.0 worker refuses the config
  outright.

So the block can be staged ahead of the upgrade, and the two removed keys have
to go in the same edit window as the pin move.

### Migrating a host

```mermaid
flowchart TD
    H["Write the hook<br/>absolute path, container-visible"] --> P["deno task callback-conformance<br/>--always &lt;path&gt;"]
    P --> A["Add the callbacks block<br/>1.0.x: one unknown-key warning"]
    A --> U["./run.sh upgrade<br/>pinned_ref → 1.1.0 + tool versions"]
    U --> R["Same edit: remove fleet_health_repo<br/>and fleet_health_dir"]
    R --> L["Relaunch — first 1.1.0 run"]
    L --> O["Observe: success health record<br/>AND always log archival"]
    O --> F["Only then: the rest of the fleet"]
```

1. **Write the hook** your fleet's reporting actually needs, starting from the
   [portable examples](CALLBACKS.md#minimal-portable-hooks). Put it at an
   absolute path that is visible **inside the container** — committed to the
   worker checkout under `/workspace`, or provisioned into the work volume.
   The hook establishes its own credentials: it does not inherit the worker's
   the way the old report script did.
2. **Prove it**, inside the container, before anything depends on it:

   ```bash
   cd worker/deno
   deno task callback-conformance --always /opt/vibe-hooks/always.sh
   ```

   It exits non-zero on any failed property, so an extension can run it as a
   gate in its own CI.
3. **Add the `callbacks` block** to `.config.json`, naming the hook and the
   `timeout_seconds` the recording really needs. On a host still pinned to
   1.0.x this changes nothing but a warning line, so it can land first and be
   reviewed on its own.
4. **Move the pins.** On a frozen host, `./run.sh upgrade` rewrites
   `pinned_ref` and all three `pinned_tool_versions` to 1.1.0 and the versions
   its manifest records. It installs nothing and moves no checkout — see
   [The upgrade loop](CONFIGURATION.md#the-upgrade-loop).
5. **In the same edit, delete `fleet_health_repo` and `fleet_health_dir`.**
   Re-running `./setup.sh` also strips them, warning once per key. Both must be
   gone before the first 1.1.0 launch, or the config load fails and the host
   claims nothing.
6. **Relaunch and watch the first run.** A hook that could not be spawned, that
   exited non-zero or that timed out is reported loudly in `run_core.log` —
   the run's own outcome is unchanged either way, so a broken hook is visible
   rather than fatal.

### The canary comes first

Verify one canary host — the host carrying the private extension — through a
**complete** run before any other host is touched. The rollout gate is two
observed facts, not one:

- a **successful** run produced its health record through `callbacks.success`
  (or `callbacks.always`), and
- **`always` archived the session logs**, on a failing run as well as a
  successful one.

Until both are seen on the canary, the rest of the fleet stays on 1.0.x. A
fleet migrated on the strength of the success path alone would lose exactly the
records it needs on the day something fails.

### Pinning to 1.1.0

```json
{
  "update_mode": "frozen",
  "pinned_ref": "1.1.0",
  "pinned_tool_versions": { "claude": "…", "gh": "…", "deno": "…" }
}
```

`./run.sh upgrade` writes all four values from the release's manifest, which is
the supported way to do it. The pins are all-or-nothing: a release with no
manifest, an unreachable GitHub or a value the validator refuses leaves
`.config.json` exactly as it was.

### Rolling back to 1.0.x

`./run.sh upgrade` only ever moves forward, so a rollback is a **hand edit** —
[Moving a pin by hand](CONFIGURATION.md#moving-a-pin-by-hand) — and it is two
changes in one edit, because the configuration contract moves back with the
ref:

1. Read the tool versions the release you are returning to shipped with:

   ```bash
   gh release download 1.0.71 --repo stSoftwareAU/VibeCoder \
     --pattern tool-versions.json
   cat tool-versions.json
   ```

2. In one edit of `.config.json`:
   - set `pinned_ref` back to that tag and all three `pinned_tool_versions` to
     what the manifest names;
   - **re-add `fleet_health_repo`** (and `fleet_health_dir` if the host used
     one) — the 1.0.x worker needs them to report health at all;
   - leave the `callbacks` block in place. A 1.0.x worker ignores it with one
     unknown-key warning, so removing it only makes the next upgrade longer.
3. Relaunch. The checkout update puts the worker checkout back on the older
   ref and the launch installs exactly the pinned versions, one log line per
   tool.

The hook itself needs no rollback: nothing on 1.0.x executes it.

### Not covered by a callback

The built-in reporting ran on **every priority-loop iteration**; callbacks fire
only when an issue run terminates. A fleet that relies on a liveness signal
from an idle host still needs something else for it — a callback is not a
heartbeat. The full before/after table is
[Migrating from `fleet_health_dir` / `fleet_health_repo`](CALLBACKS.md#migrating-from-fleet_health_dir--fleet_health_repo).
