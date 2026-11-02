# DecisionsBuddy typography and spacing

The DecisionsBuddy interface now uses Carbon's productive type scale and IBM Plex. Font size, weight, line height and tracking are applied together through `type.type-style(...)`, rather than independently tuned inline values. The principal hierarchy follows the [official Carbon type sets](https://www.carbondesignsystem.com/building-blocks/foundations/typography/type-sets).

| Interface role | Carbon token | Size / line height |
| --- | --- | --- |
| General explanatory copy | `body-01` | 14 / 20 px |
| Compact editor and table copy | `body-compact-01` | 14 / 18 px |
| Supporting labels and metadata | `label-01` | 12 / 16 px |
| Inline expressions and identifiers | `code-01` | IBM Plex Mono, 12 / 16 px |
| Component headings | `heading-01` | 14 / 20 px, semibold |
| Small section headings | `heading-02` | 16 / 24 px, semibold |
| Section headings | `heading-03` | 20 / 28 px |
| Page heading | `heading-05` | 32 / 40 px |

IBM Plex fonts are bundled locally through Carbon's font configuration. The interface does not rely on external Google Fonts requests. Browser and application zoom remain user controls; token measurements describe the unscaled CSS sizes.

## Spacing

Custom control spacing comes from Carbon Sass tokens in `src/styles/control-tokens.scss` and `src/styles/main.scss`. The chosen increments follow the [official Carbon spacing scale](https://www.carbondesignsystem.com/building-blocks/foundations/spacing/overview).

| Token | Size | Used for |
| --- | --- | --- |
| `spacing-01` | 2 px | Tight icon-control separation |
| `spacing-02` | 4 px | Fine label separation |
| `spacing-03` | 8 px | Compact control gaps and table-cell vertical padding |
| `spacing-04` | 12 px | Compact panel insets |
| `spacing-05` | 16 px | Standard panel and table-cell horizontal insets |
| `spacing-06` | 24 px | Section separation |
| `spacing-07` | 32 px | Empty-state and broad layout insets |
| `spacing-09` | 48 px | Fixed Carbon shell header offset |

Existing non-scale values such as 6 px, 10 px, and 20 px control spacing were normalized to 8 px, 12 px, and 24 px. In total, 148 JSX style attributes had typography/spacing extracted into 35 shared Carbon token classes. Unused starter `App.css` and `index.css` files were removed so their unrelated type scales cannot be accidentally reintroduced.

The editable decision table uses Carbon's large row density without the old forced 56 px row override. The visual node rule table uses Carbon's medium table density. Graph node coordinates, handle sizes, viewport dimensions, drag geometry and React Flow's proportional `fitView` padding are retained as geometry, not treated as interface spacing tokens.

## Verification

Run:

```sh
node tests/test_decisions_carbon.mjs
node tests/test_decisions_ui.mjs
```

The Carbon checks compile the installed Sass modules and verify the resulting type/spacing tokens, then parse every JSX component to reject inline typography or spacing overrides. Three Carbon checks and eight existing interface checks passed using Node 24. Full rendered visual/accessibility certification is not claimed by these source and compiled-style checks.
