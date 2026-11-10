/**
 * Issue-lifecycle classification for the agent-side `gh` guard (Issue #222).
 *
 * The implementing agent may comment on the issue it is working, label it, and
 * edit its body — but deciding that an issue is **closed**, **reopened**,
 * **moved** or **locked** is the worker's call or a human's, never the agent's.
 * VibeCoder#222 records what happens when it is not: an agent that correctly
 * diagnosed a hard dependency block ran
 * `gh issue close … --reason "not planned"` on its own claimed issue, and the
 * worker's no-changes handler then mislabelled the run analysis-only.
 *
 * `gh issue close` is already classified as a mutation by
 * `audit_mutation_classifier.ts`, so it is journalled — but the write-repo
 * allowlist allows it, because the claimed repo is by construction on the
 * allowlist. This module supplies the missing distinction: *which* mutations
 * are issue-lifecycle changes, so {@link evaluateGhCommand} can refuse them for
 * the claimed repo unless the run explicitly permits the verb.
 *
 * Pure by design — it runs inside the guard's short-lived child process with
 * `--allow-read` and nothing else.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { normaliseGhArgs } from "./gh_flag_parser.ts";
/**
 * `gh issue <verb>` sub-verbs that change an issue's lifecycle state.
 *
 * `comment` and `create` are deliberately absent: posting the hand-off comment
 * and filing a follow-up issue are exactly what a blocked agent *should* do.
 */ export const ISSUE_LIFECYCLE_VERBS = [
  "close",
  "reopen",
  "edit",
  "delete",
  "transfer",
  "lock",
  "unlock",
  "pin",
  "unpin"
];
/** Lifecycle verbs the run permits by default — see {@link ClaimedIssue}. */ const LIFECYCLE_VERB_SET = new Set(ISSUE_LIFECYCLE_VERBS);
/** Issue number at the end of a positional target (`94`, or an issue URL). */ function issueNumberFromTarget(target) {
  if (!target) return undefined;
  const match = target.replace(/\/+$/, "").match(/(\d+)$/);
  if (!match) return undefined;
  const num = parseInt(match[1], 10);
  return Number.isNaN(num) ? undefined : num;
}
/** `owner/repo` from an issue URL target, when the target is one. */ function repoFromIssueUrl(target) {
  if (!target) return undefined;
  const match = target.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\/\d+/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}
/** REST endpoint path with any origin and leading slash removed. */ function endpointPath(endpoint) {
  return endpoint.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "").replace(/^\/+/, "").replace(/\/+$/, "");
}
/** Every `key=value` field the argv supplies to `gh api`, lower-cased. */ function apiFieldValues(args) {
  const fields = [];
  const flags = new Set([
    "-f",
    "-F",
    "--field",
    "--raw-field"
  ]);
  for(let i = 0; i < args.length; i++){
    const token = args[i];
    if (token === undefined) continue;
    if (flags.has(token)) {
      const value = args[i + 1];
      if (value !== undefined) {
        fields.push(value.toLowerCase());
        i++;
      }
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0 && flags.has(token.slice(0, eq))) {
      fields.push(token.slice(eq + 1).toLowerCase());
    }
  }
  return fields;
}
/**
 * Classify a REST mutation on `repos/{owner}/{repo}/issues/{n}` (Issue #222).
 *
 * `gh api -X PATCH repos/o/r/issues/94 -f state=closed` closes an issue just as
 * surely as `gh issue close 94`, so the guard reads the endpoint too. Only the
 * lifecycle shapes are claimed: a PATCH carrying `state=` (close/reopen), a
 * PATCH without one (a title/body edit), and the `/lock` sub-resource.
 * `/comments`, `/labels` and `/assignees` are not lifecycle changes and return
 * `undefined`, so they stay allowed.
 */ function classifyApiLifecycle(args, info) {
  const method = info.verb.slice("api-".length).toUpperCase();
  const path = endpointPath(info.target ?? "");
  const match = path.match(/^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/(.*))?$/);
  if (!match) return undefined;
  const owner = match[1];
  const name = match[2];
  const issueNumber = parseInt(match[3], 10);
  const sub = match[5] ?? "";
  // `repos/{owner}/{repo}/…` is gh's own placeholder form, resolved from the
  // current clone — the claimed repo during a coding run.
  const repo = owner === "{owner}" || name === "{repo}" ? undefined : `${owner}/${name}`;
  const base = {
    ...repo ? {
      repo
    } : {},
    ...Number.isNaN(issueNumber) ? {} : {
      issueNumber
    }
  };
  if (sub === "lock") {
    if (method === "PUT") return {
      verb: "lock",
      ...base
    };
    if (method === "DELETE") return {
      verb: "unlock",
      ...base
    };
    return undefined;
  }
  if (sub !== "") return undefined;
  if (method !== "PATCH") return undefined;
  const state = apiFieldValues(args).find((f)=>f.startsWith("state="));
  if (state === undefined) return {
    verb: "edit",
    ...base
  };
  return {
    verb: state.endsWith("open") ? "reopen" : "close",
    ...base
  };
}
/**
 * Classify one already-classified `gh` mutation as an issue-lifecycle change.
 *
 * @param rawArgs - Arguments passed to the `gh` binary.
 * @param info - The mutation as classified by `classifyGhMutation`.
 * @returns The attempt, or `undefined` when the command changes no issue's
 *   lifecycle state (a comment, a label, a read, a PR operation).
 */ export function classifyIssueLifecycle(rawArgs, info) {
  const args = normaliseGhArgs(rawArgs);
  if (info.verb.startsWith("api-")) return classifyApiLifecycle(args, info);
  if (!info.verb.startsWith("issue-")) return undefined;
  const verb = info.verb.slice("issue-".length);
  if (!LIFECYCLE_VERB_SET.has(verb)) return undefined;
  const repo = info.repo ?? repoFromIssueUrl(info.target);
  const issueNumber = issueNumberFromTarget(info.target);
  return {
    verb,
    ...repo ? {
      repo
    } : {},
    ...issueNumber !== undefined ? {
      issueNumber
    } : {}
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9pc3N1ZV9saWZlY3ljbGUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBJc3N1ZS1saWZlY3ljbGUgY2xhc3NpZmljYXRpb24gZm9yIHRoZSBhZ2VudC1zaWRlIGBnaGAgZ3VhcmQgKElzc3VlICMyMjIpLlxuICpcbiAqIFRoZSBpbXBsZW1lbnRpbmcgYWdlbnQgbWF5IGNvbW1lbnQgb24gdGhlIGlzc3VlIGl0IGlzIHdvcmtpbmcsIGxhYmVsIGl0LCBhbmRcbiAqIGVkaXQgaXRzIGJvZHkg4oCUIGJ1dCBkZWNpZGluZyB0aGF0IGFuIGlzc3VlIGlzICoqY2xvc2VkKiosICoqcmVvcGVuZWQqKixcbiAqICoqbW92ZWQqKiBvciAqKmxvY2tlZCoqIGlzIHRoZSB3b3JrZXIncyBjYWxsIG9yIGEgaHVtYW4ncywgbmV2ZXIgdGhlIGFnZW50J3MuXG4gKiBWaWJlQ29kZXIjMjIyIHJlY29yZHMgd2hhdCBoYXBwZW5zIHdoZW4gaXQgaXMgbm90OiBhbiBhZ2VudCB0aGF0IGNvcnJlY3RseVxuICogZGlhZ25vc2VkIGEgaGFyZCBkZXBlbmRlbmN5IGJsb2NrIHJhblxuICogYGdoIGlzc3VlIGNsb3NlIOKApiAtLXJlYXNvbiBcIm5vdCBwbGFubmVkXCJgIG9uIGl0cyBvd24gY2xhaW1lZCBpc3N1ZSwgYW5kIHRoZVxuICogd29ya2VyJ3Mgbm8tY2hhbmdlcyBoYW5kbGVyIHRoZW4gbWlzbGFiZWxsZWQgdGhlIHJ1biBhbmFseXNpcy1vbmx5LlxuICpcbiAqIGBnaCBpc3N1ZSBjbG9zZWAgaXMgYWxyZWFkeSBjbGFzc2lmaWVkIGFzIGEgbXV0YXRpb24gYnlcbiAqIGBhdWRpdF9tdXRhdGlvbl9jbGFzc2lmaWVyLnRzYCwgc28gaXQgaXMgam91cm5hbGxlZCDigJQgYnV0IHRoZSB3cml0ZS1yZXBvXG4gKiBhbGxvd2xpc3QgYWxsb3dzIGl0LCBiZWNhdXNlIHRoZSBjbGFpbWVkIHJlcG8gaXMgYnkgY29uc3RydWN0aW9uIG9uIHRoZVxuICogYWxsb3dsaXN0LiBUaGlzIG1vZHVsZSBzdXBwbGllcyB0aGUgbWlzc2luZyBkaXN0aW5jdGlvbjogKndoaWNoKiBtdXRhdGlvbnNcbiAqIGFyZSBpc3N1ZS1saWZlY3ljbGUgY2hhbmdlcywgc28ge0BsaW5rIGV2YWx1YXRlR2hDb21tYW5kfSBjYW4gcmVmdXNlIHRoZW0gZm9yXG4gKiB0aGUgY2xhaW1lZCByZXBvIHVubGVzcyB0aGUgcnVuIGV4cGxpY2l0bHkgcGVybWl0cyB0aGUgdmVyYi5cbiAqXG4gKiBQdXJlIGJ5IGRlc2lnbiDigJQgaXQgcnVucyBpbnNpZGUgdGhlIGd1YXJkJ3Mgc2hvcnQtbGl2ZWQgY2hpbGQgcHJvY2VzcyB3aXRoXG4gKiBgLS1hbGxvdy1yZWFkYCBhbmQgbm90aGluZyBlbHNlLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB0eXBlIHsgTXV0YXRpb25JbmZvIH0gZnJvbSBcIi4vYXVkaXRfbXV0YXRpb25fY2xhc3NpZmllci50c1wiO1xuaW1wb3J0IHsgbm9ybWFsaXNlR2hBcmdzIH0gZnJvbSBcIi4vZ2hfZmxhZ19wYXJzZXIudHNcIjtcblxuLyoqXG4gKiBgZ2ggaXNzdWUgPHZlcmI+YCBzdWItdmVyYnMgdGhhdCBjaGFuZ2UgYW4gaXNzdWUncyBsaWZlY3ljbGUgc3RhdGUuXG4gKlxuICogYGNvbW1lbnRgIGFuZCBgY3JlYXRlYCBhcmUgZGVsaWJlcmF0ZWx5IGFic2VudDogcG9zdGluZyB0aGUgaGFuZC1vZmYgY29tbWVudFxuICogYW5kIGZpbGluZyBhIGZvbGxvdy11cCBpc3N1ZSBhcmUgZXhhY3RseSB3aGF0IGEgYmxvY2tlZCBhZ2VudCAqc2hvdWxkKiBkby5cbiAqL1xuZXhwb3J0IGNvbnN0IElTU1VFX0xJRkVDWUNMRV9WRVJCUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwiY2xvc2VcIixcbiAgXCJyZW9wZW5cIixcbiAgXCJlZGl0XCIsXG4gIFwiZGVsZXRlXCIsXG4gIFwidHJhbnNmZXJcIixcbiAgXCJsb2NrXCIsXG4gIFwidW5sb2NrXCIsXG4gIFwicGluXCIsXG4gIFwidW5waW5cIixcbl07XG5cbi8qKiBMaWZlY3ljbGUgdmVyYnMgdGhlIHJ1biBwZXJtaXRzIGJ5IGRlZmF1bHQg4oCUIHNlZSB7QGxpbmsgQ2xhaW1lZElzc3VlfS4gKi9cbmNvbnN0IExJRkVDWUNMRV9WRVJCX1NFVDogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoSVNTVUVfTElGRUNZQ0xFX1ZFUkJTKTtcblxuLyoqIE9uZSBjbGFzc2lmaWVkIGF0dGVtcHQgdG8gY2hhbmdlIGFuIGlzc3VlJ3MgbGlmZWN5Y2xlIHN0YXRlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBJc3N1ZUxpZmVjeWNsZUF0dGVtcHQge1xuICAvKiogQmFyZSBsaWZlY3ljbGUgdmVyYiDigJQgYGNsb3NlYCwgYGVkaXRgLCBgbG9ja2AsIOKApiAqL1xuICB2ZXJiOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBgb3duZXIvcmVwb2AgdGhlIGF0dGVtcHQgbmFtZXMsIHdoZW4gdGhlIGFyZ3YgbmFtZXMgb25lLiBBYnNlbnQgd2hlblxuICAgKiBgZ2hgIHdvdWxkIHJlc29sdmUgdGhlIHJlcG8gZnJvbSB0aGUgY3VycmVudCBjbG9uZSDigJQgd2hpY2gsIGR1cmluZyBhXG4gICAqIGNvZGluZyBydW4sIGlzIHRoZSBjbGFpbWVkIHJlcG8uXG4gICAqL1xuICByZXBvPzogc3RyaW5nO1xuICAvKiogSXNzdWUgbnVtYmVyLCB3aGVuIHRoZSBhcmd2IG5hbWVzIG9uZS4gKi9cbiAgaXNzdWVOdW1iZXI/OiBudW1iZXI7XG59XG5cbi8qKiBJc3N1ZSBudW1iZXIgYXQgdGhlIGVuZCBvZiBhIHBvc2l0aW9uYWwgdGFyZ2V0IChgOTRgLCBvciBhbiBpc3N1ZSBVUkwpLiAqL1xuZnVuY3Rpb24gaXNzdWVOdW1iZXJGcm9tVGFyZ2V0KHRhcmdldDogc3RyaW5nIHwgdW5kZWZpbmVkKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCF0YXJnZXQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG1hdGNoID0gdGFyZ2V0LnJlcGxhY2UoL1xcLyskLywgXCJcIikubWF0Y2goLyhcXGQrKSQvKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgbnVtID0gcGFyc2VJbnQobWF0Y2hbMV0hLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNOYU4obnVtKSA/IHVuZGVmaW5lZCA6IG51bTtcbn1cblxuLyoqIGBvd25lci9yZXBvYCBmcm9tIGFuIGlzc3VlIFVSTCB0YXJnZXQsIHdoZW4gdGhlIHRhcmdldCBpcyBvbmUuICovXG5mdW5jdGlvbiByZXBvRnJvbUlzc3VlVXJsKHRhcmdldDogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCF0YXJnZXQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG1hdGNoID0gdGFyZ2V0Lm1hdGNoKFxuICAgIC9eaHR0cHM/OlxcL1xcL1teL10rXFwvKFteL10rKVxcLyhbXi9dKylcXC9pc3N1ZXNcXC9cXGQrL2ksXG4gICk7XG4gIHJldHVybiBtYXRjaCA/IGAke21hdGNoWzFdfS8ke21hdGNoWzJdfWAgOiB1bmRlZmluZWQ7XG59XG5cbi8qKiBSRVNUIGVuZHBvaW50IHBhdGggd2l0aCBhbnkgb3JpZ2luIGFuZCBsZWFkaW5nIHNsYXNoIHJlbW92ZWQuICovXG5mdW5jdGlvbiBlbmRwb2ludFBhdGgoZW5kcG9pbnQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBlbmRwb2ludFxuICAgIC5yZXBsYWNlKC9eW2Etel1bYS16MC05Ky4tXSo6XFwvXFwvW14vXStcXC8vaSwgXCJcIilcbiAgICAucmVwbGFjZSgvXlxcLysvLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpO1xufVxuXG4vKiogRXZlcnkgYGtleT12YWx1ZWAgZmllbGQgdGhlIGFyZ3Ygc3VwcGxpZXMgdG8gYGdoIGFwaWAsIGxvd2VyLWNhc2VkLiAqL1xuZnVuY3Rpb24gYXBpRmllbGRWYWx1ZXMoYXJnczogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGZpZWxkczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZmxhZ3MgPSBuZXcgU2V0KFtcIi1mXCIsIFwiLUZcIiwgXCItLWZpZWxkXCIsIFwiLS1yYXctZmllbGRcIl0pO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3MubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0b2tlbiA9IGFyZ3NbaV07XG4gICAgaWYgKHRva2VuID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGlmIChmbGFncy5oYXModG9rZW4pKSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGFyZ3NbaSArIDFdO1xuICAgICAgaWYgKHZhbHVlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZmllbGRzLnB1c2godmFsdWUudG9Mb3dlckNhc2UoKSk7XG4gICAgICAgIGkrKztcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBlcSA9IHRva2VuLmluZGV4T2YoXCI9XCIpO1xuICAgIGlmIChlcSA+IDAgJiYgZmxhZ3MuaGFzKHRva2VuLnNsaWNlKDAsIGVxKSkpIHtcbiAgICAgIGZpZWxkcy5wdXNoKHRva2VuLnNsaWNlKGVxICsgMSkudG9Mb3dlckNhc2UoKSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBmaWVsZHM7XG59XG5cbi8qKlxuICogQ2xhc3NpZnkgYSBSRVNUIG11dGF0aW9uIG9uIGByZXBvcy97b3duZXJ9L3tyZXBvfS9pc3N1ZXMve259YCAoSXNzdWUgIzIyMikuXG4gKlxuICogYGdoIGFwaSAtWCBQQVRDSCByZXBvcy9vL3IvaXNzdWVzLzk0IC1mIHN0YXRlPWNsb3NlZGAgY2xvc2VzIGFuIGlzc3VlIGp1c3QgYXNcbiAqIHN1cmVseSBhcyBgZ2ggaXNzdWUgY2xvc2UgOTRgLCBzbyB0aGUgZ3VhcmQgcmVhZHMgdGhlIGVuZHBvaW50IHRvby4gT25seSB0aGVcbiAqIGxpZmVjeWNsZSBzaGFwZXMgYXJlIGNsYWltZWQ6IGEgUEFUQ0ggY2FycnlpbmcgYHN0YXRlPWAgKGNsb3NlL3Jlb3BlbiksIGFcbiAqIFBBVENIIHdpdGhvdXQgb25lIChhIHRpdGxlL2JvZHkgZWRpdCksIGFuZCB0aGUgYC9sb2NrYCBzdWItcmVzb3VyY2UuXG4gKiBgL2NvbW1lbnRzYCwgYC9sYWJlbHNgIGFuZCBgL2Fzc2lnbmVlc2AgYXJlIG5vdCBsaWZlY3ljbGUgY2hhbmdlcyBhbmQgcmV0dXJuXG4gKiBgdW5kZWZpbmVkYCwgc28gdGhleSBzdGF5IGFsbG93ZWQuXG4gKi9cbmZ1bmN0aW9uIGNsYXNzaWZ5QXBpTGlmZWN5Y2xlKFxuICBhcmdzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgaW5mbzogTXV0YXRpb25JbmZvLFxuKTogSXNzdWVMaWZlY3ljbGVBdHRlbXB0IHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgbWV0aG9kID0gaW5mby52ZXJiLnNsaWNlKFwiYXBpLVwiLmxlbmd0aCkudG9VcHBlckNhc2UoKTtcbiAgY29uc3QgcGF0aCA9IGVuZHBvaW50UGF0aChpbmZvLnRhcmdldCA/PyBcIlwiKTtcbiAgY29uc3QgbWF0Y2ggPSBwYXRoLm1hdGNoKC9ecmVwb3NcXC8oW14vXSspXFwvKFteL10rKVxcL2lzc3Vlc1xcLyhcXGQrKShcXC8oLiopKT8kLyk7XG4gIGlmICghbWF0Y2gpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3Qgb3duZXIgPSBtYXRjaFsxXSE7XG4gIGNvbnN0IG5hbWUgPSBtYXRjaFsyXSE7XG4gIGNvbnN0IGlzc3VlTnVtYmVyID0gcGFyc2VJbnQobWF0Y2hbM10hLCAxMCk7XG4gIGNvbnN0IHN1YiA9IG1hdGNoWzVdID8/IFwiXCI7XG4gIC8vIGByZXBvcy97b3duZXJ9L3tyZXBvfS/igKZgIGlzIGdoJ3Mgb3duIHBsYWNlaG9sZGVyIGZvcm0sIHJlc29sdmVkIGZyb20gdGhlXG4gIC8vIGN1cnJlbnQgY2xvbmUg4oCUIHRoZSBjbGFpbWVkIHJlcG8gZHVyaW5nIGEgY29kaW5nIHJ1bi5cbiAgY29uc3QgcmVwbyA9IG93bmVyID09PSBcIntvd25lcn1cIiB8fCBuYW1lID09PSBcIntyZXBvfVwiXG4gICAgPyB1bmRlZmluZWRcbiAgICA6IGAke293bmVyfS8ke25hbWV9YDtcbiAgY29uc3QgYmFzZSA9IHtcbiAgICAuLi4ocmVwbyA/IHsgcmVwbyB9IDoge30pLFxuICAgIC4uLihOdW1iZXIuaXNOYU4oaXNzdWVOdW1iZXIpID8ge30gOiB7IGlzc3VlTnVtYmVyIH0pLFxuICB9O1xuXG4gIGlmIChzdWIgPT09IFwibG9ja1wiKSB7XG4gICAgaWYgKG1ldGhvZCA9PT0gXCJQVVRcIikgcmV0dXJuIHsgdmVyYjogXCJsb2NrXCIsIC4uLmJhc2UgfTtcbiAgICBpZiAobWV0aG9kID09PSBcIkRFTEVURVwiKSByZXR1cm4geyB2ZXJiOiBcInVubG9ja1wiLCAuLi5iYXNlIH07XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBpZiAoc3ViICE9PSBcIlwiKSByZXR1cm4gdW5kZWZpbmVkO1xuICBpZiAobWV0aG9kICE9PSBcIlBBVENIXCIpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3Qgc3RhdGUgPSBhcGlGaWVsZFZhbHVlcyhhcmdzKS5maW5kKChmKSA9PiBmLnN0YXJ0c1dpdGgoXCJzdGF0ZT1cIikpO1xuICBpZiAoc3RhdGUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgdmVyYjogXCJlZGl0XCIsIC4uLmJhc2UgfTtcbiAgcmV0dXJuIHtcbiAgICB2ZXJiOiBzdGF0ZS5lbmRzV2l0aChcIm9wZW5cIikgPyBcInJlb3BlblwiIDogXCJjbG9zZVwiLFxuICAgIC4uLmJhc2UsXG4gIH07XG59XG5cbi8qKlxuICogQ2xhc3NpZnkgb25lIGFscmVhZHktY2xhc3NpZmllZCBgZ2hgIG11dGF0aW9uIGFzIGFuIGlzc3VlLWxpZmVjeWNsZSBjaGFuZ2UuXG4gKlxuICogQHBhcmFtIHJhd0FyZ3MgLSBBcmd1bWVudHMgcGFzc2VkIHRvIHRoZSBgZ2hgIGJpbmFyeS5cbiAqIEBwYXJhbSBpbmZvIC0gVGhlIG11dGF0aW9uIGFzIGNsYXNzaWZpZWQgYnkgYGNsYXNzaWZ5R2hNdXRhdGlvbmAuXG4gKiBAcmV0dXJucyBUaGUgYXR0ZW1wdCwgb3IgYHVuZGVmaW5lZGAgd2hlbiB0aGUgY29tbWFuZCBjaGFuZ2VzIG5vIGlzc3VlJ3NcbiAqICAgbGlmZWN5Y2xlIHN0YXRlIChhIGNvbW1lbnQsIGEgbGFiZWwsIGEgcmVhZCwgYSBQUiBvcGVyYXRpb24pLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhc3NpZnlJc3N1ZUxpZmVjeWNsZShcbiAgcmF3QXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIGluZm86IE11dGF0aW9uSW5mbyxcbik6IElzc3VlTGlmZWN5Y2xlQXR0ZW1wdCB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGFyZ3MgPSBub3JtYWxpc2VHaEFyZ3MocmF3QXJncyk7XG5cbiAgaWYgKGluZm8udmVyYi5zdGFydHNXaXRoKFwiYXBpLVwiKSkgcmV0dXJuIGNsYXNzaWZ5QXBpTGlmZWN5Y2xlKGFyZ3MsIGluZm8pO1xuXG4gIGlmICghaW5mby52ZXJiLnN0YXJ0c1dpdGgoXCJpc3N1ZS1cIikpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHZlcmIgPSBpbmZvLnZlcmIuc2xpY2UoXCJpc3N1ZS1cIi5sZW5ndGgpO1xuICBpZiAoIUxJRkVDWUNMRV9WRVJCX1NFVC5oYXModmVyYikpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgcmVwbyA9IGluZm8ucmVwbyA/PyByZXBvRnJvbUlzc3VlVXJsKGluZm8udGFyZ2V0KTtcbiAgY29uc3QgaXNzdWVOdW1iZXIgPSBpc3N1ZU51bWJlckZyb21UYXJnZXQoaW5mby50YXJnZXQpO1xuICByZXR1cm4ge1xuICAgIHZlcmIsXG4gICAgLi4uKHJlcG8gPyB7IHJlcG8gfSA6IHt9KSxcbiAgICAuLi4oaXNzdWVOdW1iZXIgIT09IHVuZGVmaW5lZCA/IHsgaXNzdWVOdW1iZXIgfSA6IHt9KSxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXNCQyxHQUdELFNBQVMsZUFBZSxRQUFRLHNCQUFzQjtBQUV0RDs7Ozs7Q0FLQyxHQUNELE9BQU8sTUFBTSx3QkFBMkM7RUFDdEQ7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0NBQ0QsQ0FBQztBQUVGLDJFQUEyRSxHQUMzRSxNQUFNLHFCQUEwQyxJQUFJLElBQUk7QUFnQnhELDRFQUE0RSxHQUM1RSxTQUFTLHNCQUFzQixNQUEwQjtFQUN2RCxJQUFJLENBQUMsUUFBUSxPQUFPO0VBQ3BCLE1BQU0sUUFBUSxPQUFPLE9BQU8sQ0FBQyxRQUFRLElBQUksS0FBSyxDQUFDO0VBQy9DLElBQUksQ0FBQyxPQUFPLE9BQU87RUFDbkIsTUFBTSxNQUFNLFNBQVMsS0FBSyxDQUFDLEVBQUUsRUFBRztFQUNoQyxPQUFPLE9BQU8sS0FBSyxDQUFDLE9BQU8sWUFBWTtBQUN6QztBQUVBLG1FQUFtRSxHQUNuRSxTQUFTLGlCQUFpQixNQUEwQjtFQUNsRCxJQUFJLENBQUMsUUFBUSxPQUFPO0VBQ3BCLE1BQU0sUUFBUSxPQUFPLEtBQUssQ0FDeEI7RUFFRixPQUFPLFFBQVEsR0FBRyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUMsRUFBRSxFQUFFLEdBQUc7QUFDN0M7QUFFQSxrRUFBa0UsR0FDbEUsU0FBUyxhQUFhLFFBQWdCO0VBQ3BDLE9BQU8sU0FDSixPQUFPLENBQUMsbUNBQW1DLElBQzNDLE9BQU8sQ0FBQyxRQUFRLElBQ2hCLE9BQU8sQ0FBQyxRQUFRO0FBQ3JCO0FBRUEsd0VBQXdFLEdBQ3hFLFNBQVMsZUFBZSxJQUF1QjtFQUM3QyxNQUFNLFNBQW1CLEVBQUU7RUFDM0IsTUFBTSxR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
// denoCacheMetadata=3784782030467566601,12491714826535498961