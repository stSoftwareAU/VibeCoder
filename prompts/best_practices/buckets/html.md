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
