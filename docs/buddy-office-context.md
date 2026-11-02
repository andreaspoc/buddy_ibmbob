# Buddy Office context

Buddy's Office assistant supports DOCX, XLSX, CSV, PPTX, PDF and HTML. Each request captures fresh editor context; proposed edits remain subject to review and explicit application.

The context selector defines the request scope:

- **Current document** sends the bounded live document snapshot and recent conversation replies with their applied/discarded status. Spreadsheet analysis can additionally use the saved workbook; save changes before requesting full-workbook totals.
- **Selected text or cells** sends the selection and editor location metadata. It excludes the full document, previous replies and full saved-workbook analytics.
- **No document content** excludes text, selected values, document objects and previous replies. Editor metadata and supported action capabilities remain available so Buddy can prepare a draft.

The server enforces these boundaries in addition to the frontend. Switching to a restricted scope does not erase earlier messages from the visible conversation; it excludes them from the new model request.

Word, slide and HTML samples carry a partial-context flag when content or editable targets exceed limits. PDF support depends on the text and editing APIs available in the installed editor. An unreadable PDF must not be described as blank, and the assistant must not invent its contents. No OCR is provided. The authenticated Office file's PDF format is passed through the parent/bridge connection because ONLYOFFICE can report its PDF plugin as a Word editor; PDF context must use PDF APIs even in that case.

Verification:

- `tests/test_office_assistant.py` covers scope enforcement, history states, selection-only analytics, plans and streaming.
- `tests/test_office_bridge.js`, `tests/test_office_html_bridge.js` and `tests/test_office_html_runtime.js` cover native context and editing boundaries.
- `tests/test_office_context_browser.py` uses a disposable account to check real editor connections and ACP chat across six formats. Restricted-scope request checks use explicitly stubbed responses; these are not model-quality tests.
