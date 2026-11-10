/**
 * Command-specific argument types and validation (Issue #630).
 *
 * Provides typed argument interfaces for each command and validation
 * functions that return Result types for consistent error handling.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */ /**
 * Validate and parse assess-clarity command arguments.
 *
 * Defaults: title and body default to empty string, labels to empty array.
 * Returns an error if provided values have incorrect types.
 */ export function validateAssessClarityArgs(args) {
  // Validate title if provided
  if (args.title !== undefined && typeof args.title !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'title' must be a string")
    };
  }
  // Validate body if provided
  if (args.body !== undefined && typeof args.body !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'body' must be a string")
    };
  }
  // Validate labels if provided
  if (args.labels !== undefined && !Array.isArray(args.labels)) {
    return {
      ok: false,
      error: new Error("Argument 'labels' must be an array")
    };
  }
  // Validate comments if provided
  if (args.comments !== undefined && !Array.isArray(args.comments)) {
    return {
      ok: false,
      error: new Error("Argument 'comments' must be an array")
    };
  }
  return {
    ok: true,
    value: {
      title: args.title ?? "",
      body: args.body ?? "",
      labels: args.labels ?? [],
      comments: args.comments ?? undefined
    }
  };
}
/**
 * Validate and parse check-parent-deps command arguments.
 *
 * Both repo and issue are required.
 */ export function validateCheckParentDepsArgs(args) {
  if (args.repo === undefined || args.repo === null) {
    return {
      ok: false,
      error: new Error("Required argument 'repo' is missing")
    };
  }
  if (typeof args.repo !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'repo' must be a string")
    };
  }
  if (args.issue === undefined || args.issue === null) {
    return {
      ok: false,
      error: new Error("Required argument 'issue' is missing")
    };
  }
  if (typeof args.issue !== "number") {
    return {
      ok: false,
      error: new Error("Argument 'issue' must be a number")
    };
  }
  return {
    ok: true,
    value: {
      repo: args.repo,
      issue: args.issue
    }
  };
}
/**
 * Validate and parse check-repo-availability command arguments.
 *
 * Both repo and github-user are required.
 */ export function validateCheckRepoAvailabilityArgs(args) {
  if (args.repo === undefined || args.repo === null) {
    return {
      ok: false,
      error: new Error("Required argument 'repo' is missing")
    };
  }
  if (typeof args.repo !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'repo' must be a string")
    };
  }
  const githubUser = args["github-user"];
  if (githubUser === undefined || githubUser === null) {
    return {
      ok: false,
      error: new Error("Required argument 'github-user' is missing")
    };
  }
  if (typeof githubUser !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'github-user' must be a string")
    };
  }
  return {
    ok: true,
    value: {
      repo: args.repo,
      githubUser: githubUser
    }
  };
}
/**
 * Validate and parse suggest-improvements command arguments.
 *
 * repo is optional. dry-run defaults to false.
 */ export function validateSuggestImprovementsArgs(args) {
  // Validate repo if provided
  if (args.repo !== undefined && typeof args.repo !== "string") {
    return {
      ok: false,
      error: new Error("Argument 'repo' must be a string")
    };
  }
  // Validate dry-run if provided
  const dryRunValue = args["dry-run"];
  if (dryRunValue !== undefined && typeof dryRunValue !== "boolean") {
    return {
      ok: false,
      error: new Error("Argument 'dry-run' must be a boolean")
    };
  }
  return {
    ok: true,
    value: {
      repo: args.repo,
      dryRun: dryRunValue ?? false
    }
  };
}
// =============================================================================
// Shared CLI flag coercion (Issue #1266)
// =============================================================================
/**
 * Render a rejected flag value for an operator-facing message.
 *
 * Values are summarised rather than dumped: a flag value can carry whatever
 * the operator's shell expanded into it.
 */ function describeFlagValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `a list of ${value.length}`;
  if (value !== null && typeof value === "object") return "an object";
  return String(value);
}
/**
 * Coerce a parsed CLI flag into a boolean, failing closed.
 *
 * `mod.ts::parseArgs` JSON-parses every flag value and treats a value that
 * begins with `--` as the next flag, so a boolean flag arrives as a real
 * boolean only when it was written well: `--dry-run`, `--dry-run true` and
 * `--dry-run false`. Anything else — a number, an unrecognised word, an
 * empty shell expansion that swallowed the next flag — is **refused** rather
 * than mapped to `undefined`. That distinction is the whole point: for a
 * safety flag, `undefined` means "absent", and absence selects the more
 * dangerous default, so a value that cannot be read would silently disarm
 * the guard the operator believed they had set.
 *
 * @param value    Raw value from the parsed argument record.
 * @param flag     Flag name without the leading `--`, used in the message.
 * @param fallback Value used when the flag is genuinely absent.
 */ export function coerceBooleanFlag(value, flag, fallback) {
  if (value === undefined || value === null) {
    return {
      ok: true,
      value: fallback
    };
  }
  if (typeof value === "boolean") {
    return {
      ok: true,
      value
    };
  }
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (normalised === "true") return {
      ok: true,
      value: true
    };
    if (normalised === "false") return {
      ok: true,
      value: false
    };
  }
  return {
    ok: false,
    error: new Error(`Invalid --${flag}: expected true or false, got ` + `${describeFlagValue(value)}. A flag whose value cannot be read is ` + `refused, not ignored — ignoring it would select the default.`)
  };
}
/**
 * Coerce a parsed CLI flag into a list of strings, failing closed.
 *
 * Accepts a comma-separated string (`--repos org/a,org/b`), a JSON array
 * (`parseArgs` will already have parsed `--repos '["org/a"]'` into one), or
 * absence, which yields the empty list so a caller can apply its own
 * default. A value that is *present but not a usable list* — `true` from a
 * swallowed next flag, a number, an empty expansion — is an error, because
 * quietly treating it as absence widens whatever the list was narrowing.
 *
 * @param value Raw value from the parsed argument record.
 * @param flag  Flag name without the leading `--`, used in the message.
 */ export function coerceStringListFlag(value, flag) {
  const refuse = (reason)=>({
      ok: false,
      error: new Error(`Invalid --${flag}: ${reason}. A list flag whose value cannot be read ` + `is refused, not treated as absent.`)
    });
  if (value === undefined || value === null) {
    return {
      ok: true,
      value: []
    };
  }
  const entries = [];
  if (Array.isArray(value)) {
    for (const entry of value){
      if (typeof entry !== "string" || entry.trim().length === 0) {
        return refuse(`every entry must be a non-empty string, got ` + `${describeFlagValue(entry)}`);
      }
      entries.push(entry.trim());
    }
  } else if (typeof value === "string") {
    for (const part of value.split(",")){
      const trimmed = part.trim();
      if (trimmed.length > 0) entries.push(trimmed);
    }
  } else {
    return refuse(`expected a comma-separated list, got ${describeFlagValue(value)}`);
  }
  if (entries.length === 0) {
    return refuse("present but empty");
  }
  return {
    ok: true,
    value: entries
  };
}
/**
 * List the options a command was given that it does not recognise.
 *
 * `parseArgs` ignores an unrecognised flag, so a typo is indistinguishable
 * from absence — and for a safety flag, absence is the dangerous branch. A
 * destructive command pairs this with a `KNOWN_OPTIONS` set so a misspelled
 * `--dry-run` is refused rather than silently dropped, the discipline
 * `commands/export_scrub_gate.ts` already applied.
 *
 * Injected test seams are ordinary keys, so a command that uses one lists it
 * in its own known set.
 *
 * @param args  Parsed argument record.
 * @param known Option names, without the leading `--`, the command accepts.
 * @returns The unrecognised names, without the leading `--`, in input order.
 */ export function findUnknownOptions(args, known) {
  return Object.keys(args).filter((key)=>!known.has(key));
}
/**
 * Coerce a parsed CLI flag into a positive whole number, failing closed
 * (Issue #1270).
 *
 * `mod.ts::parseArgs` JSON-parses every flag value, so a well-written
 * `--timeout 120` arrives as a number while `--timeout ""` — a wrapper
 * expanding an unset-but-quoted variable — arrives as the empty string, and a
 * bare `--timeout` at the end of the line arrives as `true`. `parseInt` maps
 * both of those to `NaN`, and `NaN` is neither nullish nor negative, so it
 * flows past a `??` default straight into arithmetic that silently disables
 * whatever the number controlled. Every unreadable value is therefore refused
 * here rather than mapped to `undefined` or `NaN`.
 *
 * @param value Raw value from the parsed argument record.
 * @param flag  Flag name without the leading `--`, used in the message.
 * @returns The parsed number, or `undefined` when the flag is absent.
 */ export function coercePositiveIntFlag(value, flag) {
  const refuse = (reason)=>({
      ok: false,
      error: new Error(`Invalid --${flag}: ${reason}. A numeric flag whose value cannot be ` + `read is refused, not treated as absent — passing it on would ` + `silently disable what it controls.`)
    });
  if (value === undefined || value === null) {
    return {
      ok: true,
      value: undefined
    };
  }
  let parsed;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    parsed = parseInt(value.trim(), 10);
  } else {
    return refuse(`expected a positive whole number, got ${describeFlagValue(value)}`);
  }
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return refuse(`expected a positive whole number, got ${describeFlagValue(value)}`);
  }
  return {
    ok: true,
    value: parsed
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb21tYW5kX2FyZ3MudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDb21tYW5kLXNwZWNpZmljIGFyZ3VtZW50IHR5cGVzIGFuZCB2YWxpZGF0aW9uIChJc3N1ZSAjNjMwKS5cbiAqXG4gKiBQcm92aWRlcyB0eXBlZCBhcmd1bWVudCBpbnRlcmZhY2VzIGZvciBlYWNoIGNvbW1hbmQgYW5kIHZhbGlkYXRpb25cbiAqIGZ1bmN0aW9ucyB0aGF0IHJldHVybiBSZXN1bHQgdHlwZXMgZm9yIGNvbnNpc3RlbnQgZXJyb3IgaGFuZGxpbmcuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggc3BlbGxpbmcgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEFzc2VzcyBDbGFyaXR5IEFyZ3Ncbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKiBUeXBlZCBhcmd1bWVudHMgZm9yIHRoZSBhc3Nlc3MtY2xhcml0eSBjb21tYW5kLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBc3Nlc3NDbGFyaXR5QXJncyB7XG4gIC8qKiBJc3N1ZSB0aXRsZSAqL1xuICB0aXRsZTogc3RyaW5nO1xuICAvKiogSXNzdWUgYm9keS9kZXNjcmlwdGlvbiAqL1xuICBib2R5OiBzdHJpbmc7XG4gIC8qKiBJc3N1ZSBsYWJlbHMgKi9cbiAgbGFiZWxzOiBzdHJpbmdbXTtcbiAgLyoqIElzc3VlIGNvbW1lbnRzIChvcHRpb25hbCwgZm9yIGZ1dHVyZSB1c2UpICovXG4gIGNvbW1lbnRzPzogc3RyaW5nW107XG59XG5cbi8qKlxuICogVmFsaWRhdGUgYW5kIHBhcnNlIGFzc2Vzcy1jbGFyaXR5IGNvbW1hbmQgYXJndW1lbnRzLlxuICpcbiAqIERlZmF1bHRzOiB0aXRsZSBhbmQgYm9keSBkZWZhdWx0IHRvIGVtcHR5IHN0cmluZywgbGFiZWxzIHRvIGVtcHR5IGFycmF5LlxuICogUmV0dXJucyBhbiBlcnJvciBpZiBwcm92aWRlZCB2YWx1ZXMgaGF2ZSBpbmNvcnJlY3QgdHlwZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUFzc2Vzc0NsYXJpdHlBcmdzKFxuICBhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbik6IFJlc3VsdDxBc3Nlc3NDbGFyaXR5QXJncz4ge1xuICAvLyBWYWxpZGF0ZSB0aXRsZSBpZiBwcm92aWRlZFxuICBpZiAoYXJncy50aXRsZSAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBhcmdzLnRpdGxlICE9PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXCJBcmd1bWVudCAndGl0bGUnIG11c3QgYmUgYSBzdHJpbmdcIiksXG4gICAgfTtcbiAgfVxuXG4gIC8vIFZhbGlkYXRlIGJvZHkgaWYgcHJvdmlkZWRcbiAgaWYgKGFyZ3MuYm9keSAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBhcmdzLmJvZHkgIT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcIkFyZ3VtZW50ICdib2R5JyBtdXN0IGJlIGEgc3RyaW5nXCIpLFxuICAgIH07XG4gIH1cblxuICAvLyBWYWxpZGF0ZSBsYWJlbHMgaWYgcHJvdmlkZWRcbiAgaWYgKGFyZ3MubGFiZWxzICE9PSB1bmRlZmluZWQgJiYgIUFycmF5LmlzQXJyYXkoYXJncy5sYWJlbHMpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXCJBcmd1bWVudCAnbGFiZWxzJyBtdXN0IGJlIGFuIGFycmF5XCIpLFxuICAgIH07XG4gIH1cblxuICAvLyBWYWxpZGF0ZSBjb21tZW50cyBpZiBwcm92aWRlZFxuICBpZiAoYXJncy5jb21tZW50cyAhPT0gdW5kZWZpbmVkICYmICFBcnJheS5pc0FycmF5KGFyZ3MuY29tbWVudHMpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXCJBcmd1bWVudCAnY29tbWVudHMnIG11c3QgYmUgYW4gYXJyYXlcIiksXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IHtcbiAgICAgIHRpdGxlOiAoYXJncy50aXRsZSBhcyBzdHJpbmcpID8/IFwiXCIsXG4gICAgICBib2R5OiAoYXJncy5ib2R5IGFzIHN0cmluZykgPz8gXCJcIixcbiAgICAgIGxhYmVsczogKGFyZ3MubGFiZWxzIGFzIHN0cmluZ1tdKSA/PyBbXSxcbiAgICAgIGNvbW1lbnRzOiAoYXJncy5jb21tZW50cyBhcyBzdHJpbmdbXSkgPz8gdW5kZWZpbmVkLFxuICAgIH0sXG4gIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBDaGVjayBQYXJlbnQgRGVwZW5kZW5jaWVzIEFyZ3Ncbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKiBUeXBlZCBhcmd1bWVudHMgZm9yIHRoZSBjaGVjay1wYXJlbnQtZGVwcyBjb21tYW5kLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDaGVja1BhcmVudERlcHNBcmdzIHtcbiAgLyoqIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0ICovXG4gIHJlcG86IHN0cmluZztcbiAgLyoqIElzc3VlIG51bWJlciB0byBjaGVjayAqL1xuICBpc3N1ZTogbnVtYmVyO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIGFuZCBwYXJzZSBjaGVjay1wYXJlbnQtZGVwcyBjb21tYW5kIGFyZ3VtZW50cy5cbiAqXG4gKiBCb3RoIHJlcG8gYW5kIGlzc3VlIGFyZSByZXF1aXJlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlQ2hlY2tQYXJlbnREZXBzQXJncyhcbiAgYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4pOiBSZXN1bHQ8Q2hlY2tQYXJlbnREZXBzQXJncz4ge1xuICBpZiAoYXJncy5yZXBvID09PSB1bmRlZmluZWQgfHwgYXJncy5yZXBvID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXCJSZXF1aXJlZCBhcmd1bWVudCAncmVwbycgaXMgbWlzc2luZ1wiKSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBhcmdzLnJlcG8gIT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcIkFyZ3VtZW50ICdyZXBvJyBtdXN0IGJlIGEgc3RyaW5nXCIpLFxuICAgIH07XG4gIH1cblxuICBpZiAoYXJncy5pc3N1ZSA9PT0gdW5kZWZpbmVkIHx8IGFyZ3MuaXNzdWUgPT09IG51bGwpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcIlJlcXVpcmVkIGFyZ3VtZW50ICdpc3N1ZScgaXMgbWlzc2luZ1wiKSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBhcmdzLmlzc3VlICE9PSBcIm51bWJlclwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXCJBcmd1bWVudCAnaXNzdWUnIG11c3QgYmUgYSBudW1iZXJcIiksXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgdmFsdWU6IHtcbiAgICAgIHJlcG86IGFyZ3MucmVwbyxcbiAgICAgIGlzc3VlOiBhcmdzLmlzc3VlLFxuICAgIH0sXG4gIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBDaGVjayBSZXBvIEF2YWlsYWJpbGl0eSBBcmdzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKiogVHlwZWQgYXJndW1lbnRzIGZvciB0aGUgY2hlY2stcmVwby1hdmFpbGFiaWxpdHkgY29tbWFuZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2hlY2tSZXBvQXZhaWxhYmlsaXR5QXJncyB7XG4gIC8qKiBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdCAqL1xuICByZXBvOiBzdHJpbmc7XG4gIC8qKiBHaXRIdWIgdXNlcm5hbWUgdG8gY2hlY2sgYXNzaWdubWVudHMgYWdhaW5zdCAqL1xuICBnaXRodWJVc2VyOiBzdHJpbmc7XG59XG5cbi8qKlxuICogVmFsaWRhdGUgYW5kIHBhcnNlIGNoZWNrLXJlcG8tYXZhaWxhYmlsaXR5IGNvbW1hbmQgYXJndW1lbnRzLlxuICpcbiAqIEJvdGggcmVwbyBhbmQgZ2l0aHViLXVzZXIgYXJlIHJlcXVpcmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVDaGVja1JlcG9BdmFpbGFiaWxpdHlBcmdzKFxuICBhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbik6IFJlc3VsdDxDaGVja1JlcG9BdmFpbGFiaWxpdHlBcmdzPiB7XG4gIGlmIChhcmdzLnJlcG8gPT09IHVuZGVmaW5lZCB8fCBhcmdzLnJlcG8gPT09IG51bGwpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcIlJlcXVpcmVkIGFyZ3VtZW50ICdyZXBvJyBpcyBtaXNzaW5nXCIpLFxuICAgIH07XG4gIH1cblxuICBpZiAodHlwZW9mIGFyZ3MucmVwbyAhPT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFwiQXJndW1lbnQgJ3JlcG8nIG11c3QgYmUgYSBzdHJpbmdcIiksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGdpdGh1YlVzZXIgPSBhcmdzW1wiZ2l0aHViLXVzZXJcIl07XG4gIGlmIChnaXRodWJVc2VyID09PSB1bmRlZmluZWQgfHwgZ2l0aHViVXNlciA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFwiUmVxdWlyZWQgYXJndW1lbnQgJ2dpdGh1Yi11c2VyJyBpcyBtaXNzaW5nXCIpLFxuICAgIH07XG4gIH1cblxuICBpZiAodHlwZW9mIGdpdGh1YlVzZXIgIT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcIkFyZ3VtZW50ICdnaXRodWItdXNlcicgbXVzdCBiZSBhIHN0cmluZ1wiKSxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICB2YWx1ZToge1xuICAgICAgcmVwbzogYXJncy5yZXBvLFxuICAgICAgZ2l0aHViVXNlcjogZ2l0aHViVXNlcixcbiAgICB9LFxuICB9O1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gU3VnZ2VzdCBJbXByb3ZlbWVudHMgQXJnc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqIFR5cGVkIGFyZ3VtZW50cyBmb3IgdGhlIHN1Z2dlc3QtaW1wcm92ZW1lbnRzIGNvbW1hbmQuICovXG5leHBvcnQgaW50ZXJmYWNlIFN1Z2dlc3RJbXByb3ZlbWVudHNBcmdzIHtcbiAgLyoqIFRhcmdldCByZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdCAob3B0aW9uYWwpICovXG4gIHJlcG8/OiBzdHJpbmc7XG4gIC8qKiBXaGVuIHRydWUsIG5vIGlzc3VlIGlzIGNyZWF0ZWQ7IHdpdGggYSByZXBvLCB0aGUgcm91dGVyJ3MgcmVhZC1vbmx5IHN0ZXBzIHJlcG9ydCB3aGF0IHdvdWxkIGJlIGZpbGVkICovXG4gIGRyeVJ1bjogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBhbmQgcGFyc2Ugc3VnZ2VzdC1pbXByb3ZlbWVudHMgY29tbWFuZCBhcmd1bWVudHMuXG4gKlxuICogcmVwbyBpcyBvcHRpb25hbC4gZHJ5LXJ1biBkZWZhdWx0cyB0byBmYWxzZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlU3VnZ2VzdEltcHJvdmVtZW50c0FyZ3MoXG4gIGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuKTogUmVzdWx0PFN1Z2dlc3RJbXByb3ZlbWVudHNBcmdzPiB7XG4gIC8vIFZhbGlkYXRlIHJlcG8gaWYgcHJvdmlkZWRcbiAgaWYgKGFyZ3MucmVwbyAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBhcmdzLnJlcG8gIT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcIkFyZ3VtZW50ICdyZXBvJyBtdXN0IGJlIGEgc3RyaW5nXCIpLFxuICAgIH07XG4gIH1cblxuICAvLyBWYWxpZGF0ZSBkcnktcnVuIGlmIHByb3ZpZGVkXG4gIGNvbnN0IGRyeVJ1blZhbHVlID0gYXJnc1tcImRyeS1ydW5cIl07XG4gIGlmIChkcnlSdW5WYWx1ZSAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBkcnlSdW5WYWx1ZSAhPT0gXCJib29sZWFuXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcIkFyZ3VtZW50ICdkcnktcnVuJyBtdXN0IGJlIGEgYm9vbGVhblwiKSxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICB2YWx1ZToge1xuICAgICAgcmVwbzogYXJncy5yZXBvIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIGRyeVJ1bjogKGRyeVJ1blZhbHVlIGFzIGJvb2xlYW4pID8/IGZhbHNlLFxuICAgIH0sXG4gIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBTaGFyZWQgQ0xJIGZsYWcgY29lcmNpb24gKElzc3VlICMxMjY2KVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBSZW5kZXIgYSByZWplY3RlZCBmbGFnIHZhbHVlIGZvciBhbiBvcGVyYXRvci1mYWNpbmcgbWVzc2FnZS5cbiAqXG4gKiBWYWx1ZXMgYXJlIHN1bW1hcmlzZWQgcmF0aGVyIHRoYW4gZHVtcGVkOiBhIGZsYWcgdmFsdWUgY2FuIGNhcnJ5IHdoYXRldmVyXG4gKiB0aGUgb3BlcmF0b3IncyBzaGVsbCBleHBhbmRlZCBpbnRvIGl0LlxuICovXG5mdW5jdGlvbiBkZXNjcmliZUZsYWdWYWx1ZSh2YWx1ZTogdW5rbm93bik6IHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIpIHJldHVybiBKU09OLnN0cmluZ2lmeSh2YWx1ZSk7XG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIGBhIGxpc3Qgb2YgJHt2YWx1ZS5sZW5ndGh9YDtcbiAgaWYgKHZhbHVlICE9PSBudWxsICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIikgcmV0dXJuIFwiYW4gb2JqZWN0XCI7XG4gIHJldHVybiBTdHJpbmcodmFsdWUpO1xufVxuXG4vKipcbiAqIENvZXJjZSBhIHBhcnNlZCBDTEkgZmxhZyBpbnRvIGEgYm9vbGVhbiwgZmFpbGluZyBjbG9zZWQuXG4gKlxuICogYG1vZC50czo6cGFyc2VBcmdzYCBKU09OLXBhcnNlcyBldmVyeSBmbGFnIHZhbHVlIGFuZCB0cmVhdHMgYSB2YWx1ZSB0aGF0XG4gKiBiZWdpbnMgd2l0aCBgLS1gIGFzIHRoZSBuZXh0IGZsYWcsIHNvIGEgYm9vbGVhbiBmbGFnIGFycml2ZXMgYXMgYSByZWFsXG4gKiBib29sZWFuIG9ubHkgd2hlbiBpdCB3YXMgd3JpdHRlbiB3ZWxsOiBgLS1kcnktcnVuYCwgYC0tZHJ5LXJ1biB0cnVlYCBhbmRcbiAqIGAtLWRyeS1ydW4gZmFsc2VgLiBBbnl0aGluZyBlbHNlIOKAlCBhIG51bWJlciwgYW4gdW5yZWNvZ25pc2VkIHdvcmQsIGFuXG4gKiBlbXB0eSBzaGVsbCBleHBhbnNpb24gdGhhdCBzd2FsbG93ZWQgdGhlIG5leHQgZmxhZyDigJQgaXMgKipyZWZ1c2VkKiogcmF0aGVyXG4gKiB0aGFuIG1hcHBlZCB0byBgdW5kZWZpbmVkYC4gVGhhdCBkaXN0aW5jdGlvbiBpcyB0aGUgd2hvbGUgcG9pbnQ6IGZvciBhXG4gKiBzYWZldHkgZmxhZywgYHVuZGVmaW5lZGAgbWVhbnMgXCJhYnNlbnRcIiwgYW5kIGFic2VuY2Ugc2VsZWN0cyB0aGUgbW9yZVxuICogZGFuZ2Vyb3VzIGRlZmF1bHQsIHNvIGEgdmFsdWUgdGhhdCBjYW5ub3QgYmUgcmVhZCB3b3VsZCBzaWxlbnRseSBkaXNhcm1cbiAqIHRoZSBndWFyZCB0aGUgb3BlcmF0b3IgYmVsaWV2ZWQgdGhleSBoYWQgc2V0LlxuICpcbiAqIEBwYXJhbSB2YWx1ZSAgICBSYXcgdmFsdWUgZnJvbSB0aGUgcGFyc2VkIGFyZ3VtZW50IHJlY29yZC5cbiAqIEBwYXJhbSBmbGFnICAgICBGbGFnIG5hbWUgd2l0aG91dCB0aGUgbGVhZGluZyBgLS1gLCB1c2VkIGluIHRoZSBtZXNzYWdlLlxuICogQHBhcmFtIGZhbGxiYWNrIFZhbHVlIHVzZWQgd2hlbiB0aGUgZmxhZyBpcyBnZW51aW5lbHkgYWJzZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29lcmNlQm9vbGVhbkZsYWcoXG4gIHZhbHVlOiB1bmtub3duLFxuICBmbGFnOiBzdHJpbmcsXG4gIGZhbGxiYWNrOiBib29sZWFuLFxuKTogUmVzdWx0PGJvb2xlYW4+IHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGZhbGxiYWNrIH07XG4gIH1cbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJib29sZWFuXCIpIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWUgfTtcbiAgfVxuICBpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3Qgbm9ybWFsaXNlZCA9IHZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmIChub3JtYWxpc2VkID09PSBcInRydWVcIikgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB0cnVlIH07XG4gICAgaWYgKG5vcm1hbGlzZWQgPT09IFwiZmFsc2VcIikgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBmYWxzZSB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICBgSW52YWxpZCAtLSR7ZmxhZ306IGV4cGVjdGVkIHRydWUgb3IgZmFsc2UsIGdvdCBgICtcbiAgICAgICAgYCR7ZGVzY3JpYmVGbGFnVmFsdWUodmFsdWUpfS4gQSBmbGFnIHdob3NlIHZhbHVlIGNhbm5vdCBiZSByZWFkIGlzIGAgK1xuICAgICAgICBgcmVmdXNlZCwgbm90IGlnbm9yZWQg4oCUIGlnbm9yaW5nIGl0IHdvdWxkIHNlbGVjdCB0aGUgZGVmYXVsdC5gLFxuICAgICksXG4gIH07XG59XG5cbi8qKlxuICogQ29lcmNlIGEgcGFyc2VkIENMSSBmbGFnIGludG8gYSBsaXN0IG9mIHN0cmluZ3MsIGZhaWxpbmcgY2xvc2VkLlxuICpcbiAqIEFjY2VwdHMgYSBjb21tYS1zZXBhcmF0ZWQgc3RyaW5nIChgLS1yZXBvcyBvcmcvYSxvcmcvYmApLCBhIEpTT04gYXJyYXlcbiAqIChgcGFyc2VBcmdzYCB3aWxsIGFscmVhZHkgaGF2ZSBwYXJzZWQgYC0tcmVwb3MgJ1tcIm9yZy9hXCJdJ2AgaW50byBvbmUpLCBvclxuICogYWJzZW5jZSwgd2hpY2ggeWllbGRzIHRoZSBlbXB0eSBsaXN0IHNvIGEgY2FsbGVyIGNhbiBhcHBseSBpdHMgb3duXG4gKiBkZWZhdWx0LiBBIHZhbHVlIHRoYXQgaXMgKnByZXNlbnQgYnV0IG5vdCBhIHVzYWJsZSBsaXN0KiDigJQgYHRydWVgIGZyb20gYVxuICogc3dhbGxvd2VkIG5leHQgZmxhZywgYSBudW1iZXIsIGFuIGVtcHR5IGV4cGFuc2lvbiDigJQgaXMgYW4gZXJyb3IsIGJlY2F1c2VcbiAqIHF1aWV0bHkgdHJlYXRpbmcgaXQgYXMgYWJzZW5jZSB3aWRlbnMgd2hhdGV2ZXIgdGhlIGxpc3Qgd2FzIG5hcnJvd2luZy5cbiAqXG4gKiBAcGFyYW0gdmFsdWUgUmF3IHZhbHVlIGZyb20gdGhlIHBhcnNlZCBhcmd1bWVudCByZWNvcmQuXG4gKiBAcGFyYW0gZmxhZyAgRmxhZyBuYW1lIHdpdGhvdXQgdGhlIGxlYWRpbmcgYC0tYCwgdXNlZCBpbiB0aGUgbWVzc2FnZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvZXJjZVN0cmluZ0xpc3RGbGFnKFxuICB2YWx1ZTogdW5rbm93bixcbiAgZmxhZzogc3RyaW5nLFxuKTogUmVzdWx0PHN0cmluZ1tdPiB7XG4gIGNvbnN0IHJlZnVzZSA9IChyZWFzb246IHN0cmluZyk6IFJlc3VsdDxzdHJpbmdbXT4gPT4gKHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgIGBJbnZhbGlkIC0tJHtmbGFnfTogJHtyZWFzb259LiBBIGxpc3QgZmxhZyB3aG9zZSB2YWx1ZSBjYW5ub3QgYmUgcmVhZCBgICtcbiAgICAgICAgYGlzIHJlZnVzZWQsIG5vdCB0cmVhdGVkIGFzIGFic2VudC5gLFxuICAgICksXG4gIH0pO1xuXG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBbXSB9O1xuICB9XG5cbiAgY29uc3QgZW50cmllczogc3RyaW5nW10gPSBbXTtcbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiB2YWx1ZSkge1xuICAgICAgaWYgKHR5cGVvZiBlbnRyeSAhPT0gXCJzdHJpbmdcIiB8fCBlbnRyeS50cmltKCkubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHJldHVybiByZWZ1c2UoXG4gICAgICAgICAgYGV2ZXJ5IGVudHJ5IG11c3QgYmUgYSBub24tZW1wdHkgc3RyaW5nLCBnb3QgYCArXG4gICAgICAgICAgICBgJHtkZXNjcmliZUZsYWdWYWx1ZShlbnRyeSl9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGVudHJpZXMucHVzaChlbnRyeS50cmltKCkpO1xuICAgIH1cbiAgfSBlbHNlIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIpIHtcbiAgICBmb3IgKGNvbnN0IHBhcnQgb2YgdmFsdWUuc3BsaXQoXCIsXCIpKSB7XG4gICAgICBjb25zdCB0cmltbWVkID0gcGFydC50cmltKCk7XG4gICAgICBpZiAodHJpbW1lZC5sZW5ndGggPiAwKSBlbnRyaWVzLnB1c2godHJpbW1lZCk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHJldHVybiByZWZ1c2UoXG4gICAgICBgZXhwZWN0ZWQgYSBjb21tYS1zZXBhcmF0ZWQgbGlzdCwgZ290ICR7ZGVzY3JpYmVGbGFnVmFsdWUodmFsdWUpfWAsXG4gICAgKTtcbiAgfVxuXG4gIGlmIChlbnRyaWVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiByZWZ1c2UoXCJwcmVzZW50IGJ1dCBlbXB0eVwiKTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGVudHJpZXMgfTtcbn1cblxuLyoqXG4gKiBMaXN0IHRoZSBvcHRpb25zIGEgY29tbWFuZCB3YXMgZ2l2ZW4gdGhhdCBpdCBkb2VzIG5vdCByZWNvZ25pc2UuXG4gKlxuICogYHBhcnNlQXJnc2AgaWdub3JlcyBhbiB1bnJlY29nbmlzZWQgZmxhZywgc28gYSB0eXBvIGlzIGluZGlzdGluZ3Vpc2hhYmxlXG4gKiBmcm9tIGFic2VuY2Ug4oCUIGFuZCBmb3IgYSBzYWZldHkgZmxhZywgYWJzZW5jZSBpcyB0aGUgZGFuZ2Vyb3VzIGJyYW5jaC4gQVxuICogZGVzdHJ1Y3RpdmUgY29tbWFuZCBwYWlycyB0aGlzIHdpdGggYSBgS05PV05fT1BUSU9OU2Agc2V0IHNvIGEgbWlzc3BlbGxlZFxuICogYC0tZHJ5LXJ1bmAgaXMgcmVmdXNlZCByYXRoZXIgdGhhbiBzaWxlbnRseSBkcm9wcGVkLCB0aGUgZGlzY2lwbGluZVxuICogYGNvbW1hbmRzL2V4cG9ydF9zY3J1Yl9nYXRlLnRzYCBhbHJlYWR5IGFwcGxpZWQuXG4gKlxuICogSW5qZWN0ZWQgdGVzdCBzZWFtcyBhcmUgb3JkaW5hcnkga2V5cywgc28gYSBjb21tYW5kIHRoYXQgdXNlcyBvbmUgbGlzdHMgaXRcbiAqIGluIGl0cyBvd24ga25vd24gc2V0LlxuICpcbiAqIEBwYXJhbSBhcmdzICBQYXJzZWQgYXJndW1lbnQgcmVjb3JkLlxuICogQHBhcmFtIGtub3duIE9wdGlvbiBuYW1lcywgd2l0aG91dCB0aGUgbGVhZGluZyBgLS1gLCB0aGUgY29tbWFuZCBhY2NlcHRzLlxuICogQHJldHVybnMgVGhlIHVucmVjb2duaXNlZCBuYW1lcywgd2l0aG91dCB0aGUgbGVhZGluZyBgLS1gLCBpbiBpbnB1dCBvcmRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRVbmtub3duT3B0aW9ucyhcbiAgYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIGtub3duOiBSZWFkb25seVNldDxzdHJpbmc+LFxuKTogc3RyaW5nW10ge1xuICByZXR1cm4gT2JqZWN0LmtleXMoYXJncykuZmlsdGVyKChrZXkpID0+ICFrbm93bi5oYXMoa2V5KSk7XG59XG5cbi8qKlxuICogQ29lcmNlIGEgcGFyc2VkIENMSSBmbGFnIGludG8gYSBwb3NpdGl2ZSB3aG9sZSBudW1iZXIsIGZhaWxpbmcgY2xvc2VkXG4gKiAoSXNzdWUgIzEyNzApLlxuICpcbiAqIGBtb2QudHM6OnBhcnNlQXJnc2AgSlNPTi1wYXJzZXMgZXZlcnkgZmxhZyB2YWx1ZSwgc28gYSB3ZWxsLXdyaXR0ZW5cbiAqIGAtLXRpbWVvdXQgMTIwYCBhcnJpdmVzIGFzIGEgbnVtYmVyIHdoaWxlIGAtLXRpbWVvdXQgXCJcImAg4oCUIGEgd3JhcHBlclxuICogZXhwYW5kaW5nIGFuIHVuc2V0LWJ1dC1xdW90ZWQgdmFyaWFibGUg4oCUIGFycml2ZXMgYXMgdGhlIGVtcHR5IHN0cmluZywgYW5kIGFcbiAqIGJhcmUgYC0tdGltZW91dGAgYXQgdGhlIGVuZCBvZiB0aGUgbGluZSBhcnJpdmVzIGFzIGB0cnVlYC4gYHBhcnNlSW50YCBtYXBzXG4gKiBib3RoIG9mIHRob3NlIHRvIGBOYU5gLCBhbmQgYE5hTmAgaXMgbmVpdGhlciBudWxsaXNoIG5vciBuZWdhdGl2ZSwgc28gaXRcbiAqIGZsb3dzIHBhc3QgYSBgPz9gIGRlZmF1bHQgc3RyYWlnaHQgaW50byBhcml0aG1ldGljIHRoYXQgc2lsZW50bHkgZGlzYWJsZXNcbiAqIHdoYXRldmVyIHRoZSBudW1iZXIgY29udHJvbGxlZC4gRXZlcnkgdW5yZWFkYWJsZSB2YWx1ZSBpcyB0aGVyZWZvcmUgcmVmdXNlZFxuICogaGVyZSByYXRoZXIgdGhhbiBtYXBwZWQgdG8gYHVuZGVmaW5lZGAgb3IgYE5hTmAuXG4gKlxuICogQHBhcmFtIHZhbHVlIFJhdyB2YWx1ZSBmcm9tIHRoZSBwYXJzZWQgYXJndW1lbnQgcmVjb3JkLlxuICogQHBhcmFtIGZsYWcgIEZsYWcgbmFtZSB3aXRob3V0IHRoZSBsZWFkaW5nIGAtLWAsIHVzZWQgaW4gdGhlIG1lc3NhZ2UuXG4gKiBAcmV0dXJucyBUaGUgcGFyc2VkIG51bWJlciwgb3IgYHVuZGVmaW5lZGAgd2hlbiB0aGUgZmxhZyBpcyBhYnNlbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb2VyY2VQb3NpdGl2ZUludEZsYWcoXG4gIHZhbHVlOiB1bmtub3duLFxuICBmbGFnOiBzdHJpbmcsXG4pOiBSZXN1bHQ8bnVtYmVyIHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IHJlZnVzZSA9IChyZWFzb246IHN0cmluZyk6IFJlc3VsdDxudW1iZXIgfCB1bmRlZmluZWQ+ID0+ICh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICBgSW52YWxpZCAtLSR7ZmxhZ306ICR7cmVhc29ufS4gQSBudW1lcmljIGZsYWcgd2hvc2UgdmFsdWUgY2Fubm90IGJlIGAgK1xuICAgICAgICBgcmVhZCBpcyByZWZ1c2VkLCBub3QgdHJlYXRlZCBhcyBhYnNlbnQg4oCUIHBhc3NpbmcgaXQgb24gd291bGQgYCArXG4gICAgICAgIGBzaWxlbnRseSBkaXNhYmxlIHdoYXQgaXQgY29udHJvbHMuYCxcbiAgICApLFxuICB9KTtcblxuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG4gIH1cblxuICBsZXQgcGFyc2VkOiBudW1iZXI7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwibnVtYmVyXCIpIHtcbiAgICBwYXJzZWQgPSB2YWx1ZTtcbiAgfSBlbHNlIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiYgL15cXGQrJC8udGVzdCh2YWx1ZS50cmltKCkpKSB7XG4gICAgcGFyc2VkID0gcGFyc2VJbnQodmFsdWUudHJpbSgpLCAxMCk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIHJlZnVzZShcbiAgICAgIGBleHBlY3RlZCBhIHBvc2l0aXZlIHdob2xlIG51bWJlciwgZ290ICR7ZGVzY3JpYmVGbGFnVmFsdWUodmFsdWUpfWAsXG4gICAgKTtcbiAgfVxuXG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHBhcnNlZCkgfHwgIU51bWJlci5pc0ludGVnZXIocGFyc2VkKSB8fCBwYXJzZWQgPD0gMCkge1xuICAgIHJldHVybiByZWZ1c2UoXG4gICAgICBgZXhwZWN0ZWQgYSBwb3NpdGl2ZSB3aG9sZSBudW1iZXIsIGdvdCAke2Rlc2NyaWJlRmxhZ1ZhbHVlKHZhbHVlKX1gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBwYXJzZWQgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7OztDQU9DLEdBb0JEOzs7OztDQUtDLEdBQ0QsT0FBTyxTQUFTLDBCQUNkLElBQTZCO0VBRTdCLDZCQUE2QjtFQUM3QixJQUFJLEtBQUssS0FBSyxLQUFLLGFBQWEsT0FBTyxLQUFLLEtBQUssS0FBSyxVQUFVO0lBQzlELE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxJQUFJLE1BQU07SUFDbkI7RUFDRjtFQUVBLDRCQUE0QjtFQUM1QixJQUFJLEtBQUssSUFBSSxLQUFLLGFBQWEsT0FBTyxLQUFLLElBQUksS0FBSyxVQUFVO0lBQzVELE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxJQUFJLE1BQU07SUFDbkI7RUFDRjtFQUVBLDhCQUE4QjtFQUM5QixJQUFJLEtB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
// denoCacheMetadata=3853493618605764493,8163386956910352742