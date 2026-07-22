# TokenTest Multilingual Site Design

## Goal

Support ten languages consistently across the evaluation homepage, Blog, and Product Manual while making the navigation identical on all three surfaces.

## Supported locales

| Key | Display name | HTML language |
| --- | --- | --- |
| `en` | English | `en` |
| `zh` | 中文 | `zh-CN` |
| `es` | Español | `es` |
| `fr` | Français | `fr` |
| `pt` | Português | `pt` |
| `ru` | Русский | `ru` |
| `ja` | 日本語 | `ja` |
| `vi` | Tiếng Việt | `vi` |
| `de` | Deutsch | `de` |
| `id` | Bahasa Indonesia | `id` |

English is the default locale. A shared locale definition is the single source of truth for display labels, URL prefixes, HTML language attributes, and locale-aware date formatting.

## Navigation and language selection

Every page has the same header composition:

1. The brand is rendered as `TokenTest.io`, with no whitespace before `.io`.
2. The primary navigation contains Evaluate, Blog, and Manual.
3. A language dropdown is in the header's right-hand area. It lists every supported locale and marks the current locale.
4. The homepage header does not contain the duplicate Run control. The only control that starts an evaluation is the in-page Start evaluation button.

The selector persists the visitor's choice locally for the evaluation homepage and generates locale-preserving links for Blog and Manual. Navigation labels, page titles, empty states, error states, and Manual content are translated rather than falling back to English.

## Blog routing and content policy

Blog is server-rendered and uses locale-prefixed paths, except for English:

| Locale | Index route | Article route |
| --- | --- | --- |
| `en` | `/blog` | `/blog/{slug}` |
| `zh` | `/zh/blog` | `/zh/blog/{slug}` |
| `es` | `/es/blog` | `/es/blog/{slug}` |
| `fr` | `/fr/blog` | `/fr/blog/{slug}` |
| `pt` | `/pt/blog` | `/pt/blog/{slug}` |
| `ru` | `/ru/blog` | `/ru/blog/{slug}` |
| `ja` | `/ja/blog` | `/ja/blog/{slug}` |
| `vi` | `/vi/blog` | `/vi/blog/{slug}` |
| `de` | `/de/blog` | `/de/blog/{slug}` |
| `id` | `/id/blog` | `/id/blog/{slug}` |

The route selects the same locale for the Blogger API request. Switching language on a Blog article preserves its slug. A post that Blogger does not provide in the selected locale is not listed in that locale's index. A direct request for that missing locale/slug receives a translated not-found response; it never silently displays an English article.

Each Blog response produces canonical and `hreflang` links for all supported locale routes. The Blog's old in-body language buttons are removed. The page title, description, navigation, footer, empty states, and errors are locale-specific.

## Evaluation homepage

The existing browser-side language map expands from English and Chinese to the ten supported locales. All visible evaluation UI strings—including report labels, controls, validation notices, export labels, and generated report text—resolve through the active locale. The initial locale honors a valid `lang` query parameter when present, then the saved selection, then English.

The language selector is a dropdown, not a two-language toggle. It updates page text and the document language, stores the selected locale, and makes Blog and Manual links point at the matching locale.

## Product Manual

The Product Manual uses the same locale model and header. The complete Manual, including headings, table labels, explanatory text, navigation anchors, and footer, is available in all ten languages. Technical identifiers, command examples, API names, and JSON property names remain unchanged. Manual links preserve the selected locale.

## Error handling

- Unknown language prefixes return the normal 404 behavior rather than being treated as an English Blog route.
- Blog API failures retain their HTTP status and render a message in the requested locale.
- Invalid homepage or Manual locale parameters are ignored and resolve to English.
- Missing localized Blog content is not substituted with content from another language.

## Verification

Automated tests cover the shared locale definitions, every Blog index and article route, alternate links, selected-language Blogger request, missing-translation behavior, and locale-specific navigation. Browser tests verify that the header has one language selector, no top Run button, no in-body Blog language selector, the brand reads `TokenTest.io`, and language choice updates links and visible text. Manual tests verify all locale variants contain the translated navigation and the unchanged technical examples.
