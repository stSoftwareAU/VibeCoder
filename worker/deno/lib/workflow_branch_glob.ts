/**
 * GitHub branch-filter glob matching, shared by the native
 * github-actions-audit trigger pre-filers.
 *
 * Extracted from `workflow_trigger_scanner.ts` (Issue #2587) so the
 * milestone-branch-filter pre-filer (Issue #3360) reuses the exact same
 * matcher rather than duplicating ~90 lines of glob logic.
 *
 * Matching never constructs a `RegExp` from non-literal input, so there
 * is no catastrophic-backtrack (ReDoS) surface: a memo over
 * `(tokenIndex, branchIndex)` keeps matching to O(tokens × branch
 * length).
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assertNever } from "./assert_never.ts";

/** A single token in a compiled branch-filter glob. */
type GlobToken =
  | { kind: "globstar" } // `**` — any run of characters including `/`
  | { kind: "star" } // `*`  — any run of characters except `/`
  | { kind: "any" } // `?`  — a single character except `/`
  | { kind: "lit"; ch: string }; // a literal character

/** Tokenise a GitHub branch-filter glob into its fixed character grammar. */
function tokeniseBranchPattern(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        tokens.push({ kind: "globstar" });
        i++;
      } else {
        tokens.push({ kind: "star" });
      }
    } else if (ch === "?") {
      tokens.push({ kind: "any" });
    } else {
      tokens.push({ kind: "lit", ch });
    }
  }
  return tokens;
}

/**
 * Match a GitHub branch-filter glob against a branch name.
 *
 *   - `**` matches any run of characters including `/`.
 *   - `*` matches any run of characters except `/`.
 *   - `?` matches a single character except `/`.
 *   - every other character is matched literally.
 */
export function branchPatternMatches(pattern: string, branch: string): boolean {
  const tokens = tokeniseBranchPattern(pattern);
  const failed = new Set<number>();

  const stride = branch.length + 1;
  const match = (ti: number, bi: number): boolean => {
    if (ti === tokens.length) return bi === branch.length;
    const key = ti * stride + bi;
    if (failed.has(key)) return false;

    const token = tokens[ti] as GlobToken;
    let ok = false;
    switch (token.kind) {
      case "lit":
        ok = bi < branch.length && branch[bi] === token.ch &&
          match(ti + 1, bi + 1);
        break;
      case "any":
        ok = bi < branch.length && branch[bi] !== "/" && match(ti + 1, bi + 1);
        break;
      case "star":
        // Consume zero-or-more non-`/` characters.
        for (let k = bi;; k++) {
          if (match(ti + 1, k)) {
            ok = true;
            break;
          }
          if (k >= branch.length || branch[k] === "/") break;
        }
        break;
      case "globstar":
        // Consume zero-or-more of any character.
        for (let k = bi; k <= branch.length; k++) {
          if (match(ti + 1, k)) {
            ok = true;
            break;
          }
        }
        break;
      default:
        return assertNever(token);
    }

    if (!ok) failed.add(key);
    return ok;
  };

  return match(0, 0);
}

/** Does any pattern in `patterns` match `branch`? */
export function anyBranchMatches(patterns: unknown, branch: string): boolean {
  if (!Array.isArray(patterns)) return false;
  return patterns.some(
    (p) => typeof p === "string" && branchPatternMatches(p, branch),
  );
}
