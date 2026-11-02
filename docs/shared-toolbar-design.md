# Shared Data Grid toolbar

## Inventory before implementation

The reference is the purple `.it-toolbar` in `web/src/lib/interactiveTable.ts`: Search, Table, Heatmap (when available), Bar, Line, Donut, Copy, and CSV. Its background comes from `--answer-frame-header` / `--brand-surface-background` in `answerFrames.css`.

| Area | Existing toolbar/header/navigation surfaces |
| --- | --- |
| App shell | Topbar; workspace navigation; workspace shortcuts; chat context/project/mode/agent controls; composer controls |
| Shared page and dialog headers | WorkspaceSectionHeader (Tasks, administration, apps, access, connections, agent catalog, personalization, comparisons, projects, templates, notifications, workflows) |
| Office | Library header; editor header; HTML editor/presentation bar; library search/filter bar; folder breadcrumbs; assistant header |
| Notes | Library hero; search/view tools; action toolbar; editor header, format bar and tabs |
| Knowledge and research | Page headers; library/type filters; source actions; research navigation |
| Settings and catalogs | Administration tabs; personalization tabs; productivity sections; Mods tabs/search; lifecycle hook controls; catalog actions |
| People | Member chat header; conversation header and shortcuts; conversation tools header |
| Interactive answers | Data Grid; structured diagrams; Mermaid; interactive answer header and tabs; clarification header; quiz header, sections and review bar; progress drawer |
| Artifacts and presentations | Artifact editor; presentation viewer; generated code preview; conversation document preview; saved Office preview; chart maximized header; presentation mod header |
| Entry/onboarding | Login header; tutorial header and chapter navigation |

Sidebar lists, content rows, document contents and third-party iframe editor ribbons retain their existing roles. Dropdown popovers reuse the shared component with its vertical menu variant; their item roles and focus behavior are retained. Iframe-owned toolbars are outside the Buddy application document.

## Implementation contract

One `Toolbar` component owns the application toolbar marker, semantic tag and layout variant. The Data Grid and other imperative renderers use its DOM adapter, retaining their existing event listeners and lifecycle. One final stylesheet owns the purple background, white foreground, control dimensions, focus, hover and selected states. Nested navigation uses the same controls without adding another outer padding layer.

Existing handlers, labels, menu items, permissions, disabled states, focus management, routes and data behavior are preserved. Responsive bars wrap at available width; no controls are hidden to make a toolbar fit.

## Shared sizes and behavior

The purple background is the Data Grid's existing `--answer-frame-header` value. Normal bars have a 48px minimum height, 8px by 16px padding, an 8px gap, 32px controls, 14px control text and 16px control icons. Narrow screens use 40px controls and wrap without clipping. Brand images and page headings retain their semantic hierarchy. The component's embedded variant avoids duplicate padding for navigation inside a toolbar; its menu variant keeps dropdown controls in a vertical layout.

Verification: TypeScript build, production bundle, `tests/test_shared_toolbar_browser.py` (synthetic accounts/data only), and cross-screen browser checks for Notes, Tasks, Knowledge, settings, Apps and Mods. The regression covers Data Grid filtering, sorting, chart views, clipboard and CSV export; responsive menus and restored focus; Office search and editor header visibility; and Greek/Hindi/Maltese layouts.
