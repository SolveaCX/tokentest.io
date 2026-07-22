# Multilingual Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a consistent ten-language experience for TokenTest's evaluation homepage, Blog, and Product Manual, with locale-aware Blog URLs.

**Architecture:** Add a shared locale module for server and browser URL/language metadata, a browser translation module for homepage and Manual copy, and server-side Blog copy. Blog keeps English at `/blog` and prefixes all other locale routes. The client persists selection and propagates it to Manual and Blog links.

**Tech Stack:** Node.js 20, Express 4, static HTML/CSS/JavaScript, native ES modules, Node `assert`, Playwright.

---

## File structure

- Create: `lib/site-locales.js` — ten-locale metadata and locale/path helper functions usable by Express and browser modules.
- Create: `assets/site-i18n.js` — translated homepage and Manual content plus browser helpers.
- Modify: `index.html` — dropdown language selector, locale-aware homepage links, all translated evaluation UI, and removed header Run control.
- Modify: `manual.html` — shared header and client-rendered translated Manual content.
- Modify: `server.js` — all Blog locale routes, translated Blog shell copy, and path-aware language selector.
- Modify: `scripts/server_route_test.mjs` — mock Blogger tests for every locale route and missing translations.
- Modify: `scripts/ui_e2e.mjs` — homepage/Manual header and language-switch browser assertions.

### Task 1: Define shared locale metadata

**Files:**
- Create: `lib/site-locales.js`
- Test: `scripts/server_route_test.mjs`

- [ ] **Step 1: Write the failing locale contract test**

Add this assertion near the existing static-route checks in `scripts/server_route_test.mjs`:

```js
const localeModule = await import(new URL("../lib/site-locales.js", import.meta.url));
assert.deepEqual(localeModule.SUPPORTED_LOCALES.map(({ key }) => key), ["en", "zh", "es", "fr", "pt", "ru", "ja", "vi", "de", "id"]);
assert.equal(localeModule.blogPath(localeModule.localeForKey("en")), "/blog");
assert.equal(localeModule.blogPath(localeModule.localeForKey("zh"), "model-verification"), "/zh/blog/model-verification");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/server_route_test.mjs`

Expected: failure because `lib/site-locales.js` does not exist.

- [ ] **Step 3: Add the shared locale module**

Create `lib/site-locales.js` with this API:

```js
export const SUPPORTED_LOCALES = [
  { key: "en", label: "English", pathPrefix: "", htmlLang: "en" },
  { key: "zh", label: "中文", pathPrefix: "/zh", htmlLang: "zh-CN" },
  { key: "es", label: "Español", pathPrefix: "/es", htmlLang: "es" },
  { key: "fr", label: "Français", pathPrefix: "/fr", htmlLang: "fr" },
  { key: "pt", label: "Português", pathPrefix: "/pt", htmlLang: "pt" },
  { key: "ru", label: "Русский", pathPrefix: "/ru", htmlLang: "ru" },
  { key: "ja", label: "日本語", pathPrefix: "/ja", htmlLang: "ja" },
  { key: "vi", label: "Tiếng Việt", pathPrefix: "/vi", htmlLang: "vi" },
  { key: "de", label: "Deutsch", pathPrefix: "/de", htmlLang: "de" },
  { key: "id", label: "Bahasa Indonesia", pathPrefix: "/id", htmlLang: "id" },
];
export const localeForKey = (key) => SUPPORTED_LOCALES.find((item) => item.key === key) || SUPPORTED_LOCALES[0];
export const blogPath = (locale, slug = "") => `${locale.pathPrefix}/blog${slug ? `/${encodeURIComponent(slug)}` : ""}`;
export const homepagePath = (locale) => locale.key === "en" ? "/" : `/?lang=${encodeURIComponent(locale.key)}`;
export const manualPath = (locale) => locale.key === "en" ? "/manual.html" : `/manual.html?lang=${encodeURIComponent(locale.key)}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/server_route_test.mjs`

Expected: the locale-contract assertions pass; retain the script's existing result.

- [ ] **Step 5: Commit the locale contract**

```bash
git add lib/site-locales.js scripts/server_route_test.mjs
git commit -m "feat: add shared site locale metadata"
```

### Task 2: Localize Blog routes and header

**Files:**
- Modify: `server.js:38-40,455-665`
- Modify: `scripts/server_route_test.mjs`

- [ ] **Step 1: Write failing Blog locale route tests**

Add a mock Blogger HTTP server that records its `language` query parameter and returns one localized post only when that parameter matches the requested path. Assert the route matrix and the missing-translation policy:

```js
for (const { key } of SUPPORTED_LOCALES) {
  const prefix = key === "en" ? "" : `/${key}`;
  const response = await fetch(`${appUrl}${prefix}/blog`);
  assert.equal(response.status, 200, `${key} Blog index should render`);
  assert.match(await response.text(), new RegExp(`language=${key}`));
}
const missing = await fetch(`${appUrl}/de/blog/english-only`);
assert.equal(missing.status, 404);
assert.doesNotMatch(await missing.text(), /English-only article body/);
```

- [ ] **Step 2: Run the route test to verify it fails**

Run: `node scripts/server_route_test.mjs`

Expected: routes such as `/es/blog` return a static-file 404, and the route matrix fails.

- [ ] **Step 3: Implement locale-aware Blog rendering**

In `server.js`, replace the two-entry `BLOG_LANGUAGES` list with `SUPPORTED_LOCALES` imported from `lib/site-locales.js`. Derive the locale from the first path segment only when it is a supported locale; preserve `/blog` as English. Register index and article handlers for `"/blog"`, `"/:locale/blog"`, `"/blog/:slug"`, and `"/:locale/blog/:slug"`, validating `req.params.locale` before rendering.

Use a `BLOG_COPY` map for all ten locale keys with `evaluate`, `blog`, `manual`, `home`, `empty`, `notFound`, `unavailable`, `indexTitle`, `indexDescription`, and `footer` values. Render a `<select id="localeSelect">` in the right-side header, populated from `SUPPORTED_LOCALES`; its change handler navigates to `blogPath(selectedLocale, currentSlug)`. Remove `.langSwitch` CSS and both in-body `.langSwitch` elements. Use `blogPath`, `homepagePath`, and `manualPath` for all navigation, canonical, alternate, and article links.

- [ ] **Step 4: Run the route test to verify it passes**

Run: `node scripts/server_route_test.mjs`

Expected: every supported Blog index and article route passes the locale to Blogger; a missing localized post returns a translated 404 and no English body.

- [ ] **Step 5: Commit the Blog implementation**

```bash
git add server.js scripts/server_route_test.mjs lib/site-locales.js
git commit -m "feat: add localized Blog routes and navigation"
```

### Task 3: Add browser translation resources

**Files:**
- Create: `assets/site-i18n.js`
- Modify: `index.html:450-568`
- Test: `scripts/ui_e2e.mjs`

- [ ] **Step 1: Write a failing dropdown and persistence browser test**

Replace the two-language `#langBtn` assertion in `scripts/ui_e2e.mjs` with:

```js
await page.goto(appUrl);
assert.equal(await page.locator("#localeSelect option").count(), 10);
assert.equal(await page.locator("#runTop").count(), 0);
await page.selectOption("#localeSelect", "de");
await page.waitForFunction(() => document.documentElement.lang === "de");
assert.match(await page.locator("a[data-nav='blog']").getAttribute("href"), /^\/de\/blog$/);
assert.match(await page.locator("a[data-nav='manual']").getAttribute("href"), /^\/manual\.html\?lang=de$/);
```

- [ ] **Step 2: Run the browser test to verify it fails**

Run: `node scripts/ui_e2e.mjs`

Expected: failure because the page has a two-language button, a `#runTop` element, and no ten-option selector.

- [ ] **Step 3: Implement the browser locale module and homepage integration**

Create `assets/site-i18n.js` as a browser ES module importing `SUPPORTED_LOCALES`, `blogPath`, and `manualPath` from `/lib/site-locales.js`. Export `SITE_COPY`, `MANUAL_COPY`, `readLocale`, `writeLocale`, and `interpolate`.

`SITE_COPY` must contain complete translations for every existing homepage message key and generated-report label in `index.html` for `en`, `zh`, `es`, `fr`, `pt`, `ru`, `ja`, `vi`, `de`, and `id`. Keep model identifiers, API names, JSON fields, and CSS classes untranslated. `MANUAL_COPY` must contain the complete translated Manual structure and preserve command examples exactly.

Convert the bottom script in `index.html` to `type="module"`, import the locale helpers, initialize `LANG` from a valid `lang` query parameter before `localStorage`, and replace direct `LANG === "zh"` UI literals with translation-key lookups. Replace the `<button id="langBtn">` with `<select id="localeSelect" aria-label="Language">`; remove `#runTop`; add `data-nav="blog"` and `data-nav="manual"` to their links. `applyLang()` must update `document.documentElement.lang`, every data-i18n element, selector state, and both locale-aware navigation links. Selector change stores the locale and reapplies the page without triggering a run.

- [ ] **Step 4: Run the browser test to verify it passes**

Run: `node scripts/ui_e2e.mjs`

Expected: homepage exposes all ten locales, removes top Run, and updates text/document language/Blog/Manual paths after selection.

- [ ] **Step 5: Commit homepage i18n**

```bash
git add assets/site-i18n.js index.html scripts/ui_e2e.mjs lib/site-locales.js
git commit -m "feat: localize evaluation homepage"
```

### Task 4: Render the multilingual Manual with the shared header

**Files:**
- Modify: `manual.html:1-153`
- Modify: `scripts/ui_e2e.mjs`

- [ ] **Step 1: Write a failing Manual locale test**

Add this Playwright check to `scripts/ui_e2e.mjs`:

```js
await page.goto(`${appUrl}/manual.html?lang=ja`);
await page.waitForFunction(() => document.documentElement.lang === "ja");
assert.equal(await page.locator("#localeSelect").inputValue(), "ja");
assert.match(await page.locator("a[data-nav='blog']").getAttribute("href"), /^\/ja\/blog$/);
assert.ok((await page.locator("main").innerText()).includes("評価"));
assert.ok((await page.locator("pre").first().innerText()).includes("evaluate_model"));
```

- [ ] **Step 2: Run the browser test to verify it fails**

Run: `node scripts/ui_e2e.mjs`

Expected: Manual has no selector, ignores `lang=ja`, and remains Chinese-heavy content.

- [ ] **Step 3: Implement Manual rendering**

Keep the existing Manual CSS and all immutable technical code examples in `manual.html`, but replace the static nav/header/TOC/content/footer markup with `#manualRoot`. Add a module script that imports `MANUAL_COPY`, `SUPPORTED_LOCALES`, `blogPath`, `homepagePath`, `manualPath`, `readLocale`, and `writeLocale`.

Render the same shared brand/navigation/select markup as the homepage. Use the selected `MANUAL_COPY[locale]` values for the full Manual body, table headings, sections, and footer; preserve `discover_models`, `evaluate_model`, `evaluate_batch`, URLs, curl options, JSON keys, and code examples verbatim. On selector change, update the query parameter with `history.replaceState`, persist locale, and rerender without a full request.

- [ ] **Step 4: Run the browser test to verify it passes**

Run: `node scripts/ui_e2e.mjs`

Expected: Japanese Manual is visibly Japanese, all ten selector options are available, Blog points to `/ja/blog`, and technical snippets remain exact.

- [ ] **Step 5: Commit Manual localization**

```bash
git add manual.html assets/site-i18n.js scripts/ui_e2e.mjs lib/site-locales.js
git commit -m "feat: localize product manual"
```

### Task 5: Run the complete verification suite

**Files:**
- Modify: `docs/superpowers/specs/2026-07-22-multilingual-site-design.md` only if verification reveals a requirement ambiguity.

- [ ] **Step 1: Run focused server routing verification**

Run: `npm run test:server`

Expected: exit code 0, including locale route matrix and missing translation tests.

- [ ] **Step 2: Run browser verification**

Run: `npm run test:e2e`

Expected: exit code 0, including homepage/header/Manual language checks and existing evaluation flow coverage.

- [ ] **Step 3: Run project tests that cover touched shared utilities**

Run: `npm run test:evaluator && npm run test:visual && npm run test:mcp && npm run test:http-mcp`

Expected: every command exits 0.

- [ ] **Step 4: Inspect the final change set**

Run: `git diff --check HEAD~4..HEAD && git status --short`

Expected: no whitespace errors; only intentional changes and pre-existing user-untracked files remain.

- [ ] **Step 5: Commit any verification-only adjustments**

```bash
git add server.js index.html manual.html lib/site-locales.js assets/site-i18n.js scripts/server_route_test.mjs scripts/ui_e2e.mjs
git commit -m "test: verify multilingual site support"
```
