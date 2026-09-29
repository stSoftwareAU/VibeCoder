# Path confinement guidance: resolve before you check, test `..` and symlinks

## Summary

Closes #2885.

Path-confinement guards keep missing `..` traversal because they check a
partly resolved path. Two examples:

- VibeCoder#2881: `assertSafeGitRef` accepts `..`.
- GRQ-GTC#448: a non-existent tail containing `..` is appended after
  canonicalisation.

This PR adds a short **Path Confinement** rule with four parts:

1. Resolve the path fully before checking it: join it to the cwd, canonicalise
   the existing part, and normalise or reject every `..`/`.`, including in a
   not-yet-existing tail.
2. Validate identifiers that become path segments with an allow-list that
   rejects `..`, `/` and absolute paths. Never reuse a validator written for
   another purpose.
3. Ship negative `..` tests with every guard (including `..` after a missing
   component), plus a symlink test on Unix.
4. Never claim in a PR summary that a traversal case is impossible unless a
   test proves it.

- [x] `CODING-STANDARDS.md`: new **Path Confinement — Resolve Before You
      Check** section beside Secret Redaction.
- [x] `prompts/coding_guidelines/prompt.md`: the same rule in its
      code-layer **Pre-PR Security Self-Check**, with a new checklist item. This
      is the implementation-run surface. It avoids repo-specific references
      because it is injected into other repositories.
- [x] `prompts/security_scan/prompt.md`: the A01 path-traversal bullet now also
      flags partly-resolved guards and borrowed validators.
- [x] `worker/deno/tests/coding_guidelines_layers_2574_test.ts`: adds the new
      `### Path Confinement` heading to the pinned code-phase heading list.

## Evidence

This change touches only documentation and prompts, so there is nothing to
screenshot. The rule's flow:

```mermaid
flowchart TD
  P["Input path / identifier"] --> V{"Identifier used as a segment?"}
  V -- "yes" --> A["Allow-list: reject .., /, absolute"]
  V -- "no" --> J
  A --> J["Join to cwd"]
  J --> C["Canonicalise existing prefix (symlinks)"]
  C --> N["Normalise or reject every .. and . incl. missing tail"]
  N --> K{"Inside allowed dir?"}
  K -- "yes" --> OK["Proceed"]
  K -- "no" --> F["Fail loud"]
  T["Negative tests: .. after missing component, symlink into protected dir"] -.guards.-> K
```

## Test Plan

- [x] Coding-guidelines twin-drift, layer, overlay and version tests pass.
- [x] The security-scan prompt tests pass.
- [x] `./quality.sh < /dev/null` passes.
