# Bucket: `html`

Canonical guides — link, do not restate:

- HTML Living Standard — <https://html.spec.whatwg.org/>
- WCAG 2.x (Web Content Accessibility Guidelines) —
  <https://www.w3.org/WAI/standards-guidelines/wcag/>
- ARIA Authoring Practices — <https://www.w3.org/WAI/ARIA/apg/>

Apply these checks to `*.html` files and to inline HTML literals in
templates (JSX/TSX components belong to the `react` bucket).

## Checks

1. **Semantic elements over `<div>` soup.** Use `<header>`, `<nav>`,
   `<main>`, `<article>`, `<section>`, `<aside>`, `<footer>`,
   `<button>`, `<a>` where they fit. A clickable `<div>` with an
   `onclick` handler is a defect — it is unreachable by keyboard and
   invisible to assistive tech.
2. **`<html lang="...">` is set.** The root element declares the
   document language. Screen readers and translation tools rely on
   it. Flag missing or empty `lang` attributes.
3. **`alt` text on images.** Every `<img>` carries an `alt`
   attribute. Decorative images use `alt=""` (empty but present);
   informational images describe the content; functional images
   (buttons) describe the action. Flag missing `alt`.
4. **Form labels.** Every `<input>`, `<select>`, and `<textarea>` is
   associated with a `<label for="...">` or wrapped by `<label>`, or
   carries `aria-label` / `aria-labelledby` when a visible label is
   not appropriate. Placeholders are not labels.
5. **Heading order is monotonic.** Headings descend without skipping
   levels (`<h1>` → `<h2>` → `<h3>`; not `<h1>` → `<h3>`). Page has
   exactly one `<h1>`. Flag broken hierarchies.
6. **Landmark and link clarity.** Each page has one `<main>`. Link
   text describes the destination ("Read the report" beats "click
   here"). Flag duplicate landmarks of the same type without
   `aria-label` to distinguish them.
7. **`<title>` element is present and descriptive.** The document
   `<title>` summarises the page in a few words. Flag missing or
   site-name-only titles ("Home" beats "MyApp").
8. **Tables have headers.** Data tables use `<th>` with appropriate
   `scope="col"` / `scope="row"` so screen readers can associate
   cells with headers. Flag `<table>` used purely for layout (use
   CSS grid/flexbox instead).
9. **`target="_blank"` carries `rel="noopener"` (reverse tabnabbing).**
   Flag any `<a target="_blank">` — or a `target="_blank"` set on a
   generated link in an HTML literal — that lacks `rel="noopener"` or
   `rel="noreferrer"`. Without either token the opened page can reach
   `window.opener` and redirect the original tab to a phishing page
   (**reverse tabnabbing**). Modern browsers imply `noopener` for
   `target="_blank"`, but the explicit `rel` is the defence-in-depth
   default and protects older engines and embedded webviews. Cite the
   file and line. Suggested fix: add `rel="noopener noreferrer"`.
   Default severity is **`severity:low`** (browsers mitigate by
   default); bump to **`severity:medium`** when the link points to a
   user-controlled or otherwise external URL. Stable id: generic
   `BP-<12 hex>`.

## Visual design anti-patterns

What the page looks like and how it responds, not just its markup. These
checks also read the stylesheets (`*.css`) the page loads. Each links the
source that defines the bar — cite it, do not restate it.

10. **Low text contrast.** Grey-on-grey body text, pale placeholder text
    or text over a busy image that fails the WCAG contrast minimum —
    <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html>.
11. **Colour as the only signal.** An error, status or link told apart by
    colour alone, with no icon, text or underline to back it up —
    <https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html>.
12. **Focus ring removed.** `outline: none` (or `0`) on focusable elements
    with no visible replacement, so a keyboard user cannot see where they
    are — <https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html>.
13. **Tiny or crowded tap targets.** Icon buttons and inline links too
    small or too close together to hit reliably on touch —
    <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>.
14. **Zoom blocked or layout fixed-width.** A viewport `meta` with
    `user-scalable=no` or `maximum-scale=1`, or a fixed-pixel layout that
    scrolls sideways at narrow widths —
    <https://www.w3.org/WAI/WCAG22/Understanding/reflow.html>.
15. **Motion with no opt-out.** Auto-playing, parallax or large animated
    transitions with no `prefers-reduced-motion` fallback —
    <https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html>.
16. **Layout shift.** Images, embeds or late banners without reserved
    space (no `width`/`height` or `aspect-ratio`), so content jumps under
    the reader's cursor — <https://web.dev/articles/cls>.
