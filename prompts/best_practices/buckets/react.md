# Bucket: `react`

Canonical guides — link, do not restate:

- React docs — <https://react.dev/>
- Rules of Hooks — <https://react.dev/reference/rules/rules-of-hooks>
- Accessibility (WAI-ARIA + WCAG) — <https://react.dev/learn/accessibility>

Apply these checks to `*.tsx` and `*.jsx` files that import `react`.

## Checks

1. **Rules of Hooks.** Hooks (`useState`, `useEffect`, `useMemo`, …)
   are called unconditionally at the top of a component or custom
   hook — never inside a loop, condition, or nested function. Custom
   hook names start with `use`. Flag violations.
2. **Effect dependency arrays are honest.** `useEffect`,
   `useCallback`, and `useMemo` list every value from component scope
   they reference. Missing deps cause stale closures; padding deps to
   silence the linter is also a defect. Flag missing deps and
   suppressed `react-hooks/exhaustive-deps`.
3. **Memoisation is justified.** `useMemo`/`useCallback`/`React.memo`
   have a measurable cost (re-render comparisons, closure retention).
   Flag memoisation wrapped around cheap computations and primitive
   props where the optimisation is theatre.
4. **Keys on rendered lists.** Every element rendered from `.map(...)`
   has a stable `key` prop derived from the data, not the array index
   (index-as-key breaks reorder and inserts). Flag missing or
   index-based keys on lists that can change order.
5. **Controlled vs uncontrolled inputs.** A form input is either
   controlled (`value` + `onChange`) or uncontrolled
   (`defaultValue`, refs) — never both. Flag inputs that toggle
   between modes (a `value` of `undefined → "x"` is the classic
   warning).
6. **Basic accessibility.** Images carry meaningful `alt` text (or
   `alt=""` for decoration); form controls have associated `<label>`
   elements or `aria-label`; interactive elements built from `<div>`
   carry `role` and keyboard handlers. Follow WCAG 2.x AA at minimum.
7. **No setState in render.** Calling `setState` during render
   (outside the canonical "store derived state during render"
   pattern) causes infinite loops. Flag setState calls in the render
   body that are not guarded.
8. **Effects do not fetch without cleanup.** `useEffect` that starts
   a fetch / subscription / timer returns a cleanup function (or
   uses `AbortController`). Flag effects that leak on unmount or
   on dep change.
9. **`dangerouslySetInnerHTML` from unsanitised input.**
   `dangerouslySetInnerHTML={{ __html: value }}` bypasses React's
   automatic escaping and is the canonical React XSS sink. Flag any
   `dangerouslySetInnerHTML` whose `__html` value is not demonstrably
   sanitised (e.g. via `DOMPurify.sanitize(...)`) and is not a
   compile-time string constant. Cite the file and line. Suggested
   fix: render as text (drop `dangerouslySetInnerHTML` and pass the
   string as a child), or sanitise with `DOMPurify` and document in a
   comment why raw HTML is required. **Severity:** `severity:high`
   when the `__html` value is attacker-controllable (request body /
   query string, route params, props received from an untrusted
   parent, fetched API response, `localStorage`, CMS content); the
   fallback is `severity:medium` when the source cannot be proven
   untrusted but no sanitiser is present. Use the standard generic
   `BP-<12 hex>` stable id so re-runs deduplicate.

## Deprecated config on framework bump

Framework configuration and API call-sites that survive a Next.js or
React major bump but are no longer supported produce silent skew — the
file in the deprecated location is ignored, or the call-site throws at
runtime rather than build time. This check flags those patterns when the
manifest confirms the project is on the version that changed the
contract.

**Hard constraint — static evidence only.** This check reads
`next.config.*`, the source tree, and the React / Next versions pinned
in `package.json`. The scanner **does not** invoke `next build`, `next
dev`, `npm`, or any build command. **Read `package.json` to confirm the
project is actually on the version that changed the contract — do not
guess.** Every finding is filed at `severity:medium` and must cite the
offending file path and line range (e.g. `middleware.ts:1-20`). Use the
standard `BP-<12 hex>` stable-id recipe (title slug plus the primary
file) so re-runs deduplicate.

10. **Next.js `middleware.ts` at the project root on Next 15.5+.** Next
    15.5 **renamed root `middleware.ts` to `proxy.ts`** (the old name
    still works but is deprecated). Flag a root `middleware.ts` /
    `middleware.js` when `next.config.*` or `package.json` declares Next
    15.x+. Suggested fix: rename to `proxy.ts` and update the exported
    matcher config per the Next 15.5 migration note.
11. **Mixed `pages/` and `app/` routing on Next 14+.** A `pages/`
    directory alongside `app/` on Next 14+ where the rest of the app has
    migrated signals a half-finished bump. Flag the residual `pages/`
    routes. Suggested fix: migrate the remaining `pages/` routes to the
    App Router (`app/`) or document why the hybrid is intentional.
12. **React `defaultProps` on function components.** `defaultProps` on
    function components was **deprecated in React 18.3 and removed in
    React 19**. Flag `Component.defaultProps = …` on a function
    component when `package.json` declares React 18.3+ / 19. Suggested
    fix: replace with ES default parameters in the destructured props.
13. **`ReactDOM.render` / `ReactDOM.hydrate` on React 18+.** Both were
    **replaced by `createRoot` / `hydrateRoot` in React 18** and are
    removed in React 19. Flag `ReactDOM.render(...)` /
    `ReactDOM.hydrate(...)` call-sites when `package.json` declares
    React 18+. Suggested fix: switch to
    `createRoot(container).render(...)` /
    `hydrateRoot(container, ...)`.

## Test output

14. **A green test run prints a line per passing test.** Folded into
    `### Cross-bucket: verbose gate output` in the orchestrator
    prompt, which every scan applies regardless of the drawn bucket —
    see there for the full contract and the per-ecosystem quiet
    flags.

## Cost, speed and reliability

Concrete, evidence-cited checks only: skip anything you cannot tie to a
file and line. Each finding carries an `**Estimated effect:**` line
derived from the cited source and marked estimated, plus a `**Risk:**`
line naming what the change could break, and competes for the reserved
slot in Phase 3. Severity is `severity:low`, or `severity:medium` on a
production path; never `severity:high`. Each stable id uses the standard
`BP-<12 hex>` recipe with the title given and the cited file.

15. **Request waterfalls.** Flag sequential awaits or chained effects
    that fetch independent data one after another (in components,
    loaders or server components); suggest starting them together.
    Effect: load time falls from the sum of the requests to about the
    slowest one. Risk: more concurrent requests at load. Stable id:
    title `Request waterfall in <component>`.
16. **N+1 fetches from list items.** Flag a list whose item component
    fetches its own data in an effect when the API offers a batch form.
    Effect: one request instead of one per row. Risk: a larger first
    response. Stable id: title `N+1 fetches in <component>`.
17. **Fetch without a timeout.** Flag a data fetch with no timeout
    (`AbortSignal.timeout(ms)`) or retry cap; missing cleanup stays
    under check 8. Effect: a hung request no longer leaves the view
    spinning. Risk: too short a timeout fails slow networks. Stable id:
    title `Fetch in <component> has no timeout`.
18. **Bundle size.** Flag heavy routes or components loaded eagerly
    with no `React.lazy` or dynamic `import()`, and whole-library
    imports where a per-function import exists. Effect: estimate the
    saving from the library's published size. Risk: a loading state
    where there was none. Stable id: title `Eager load of <module>`.
