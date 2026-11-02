# Buddy, Office Suite and Notes

Buddy's built-in `buddy-app` tools now connect the signed-in user's saved Notes, Office library, and current conversation files. Tools bind identity and conversation on the server; the model cannot select a different account. Office must be enabled and its storage configured.

## User scenarios

| Request or action | Behavior |
| --- | --- |
| “What documents do I have in Office?” | `office_list` lists owned and explicitly shared files, with pagination and filename search. |
| “Read the budget spreadsheet” | Resolve the actual file, then `office_read` returns saved text with row/sheet locations and truncation flags. |
| Compare Office documents and saved notes | Read authorized sources with Office and Notes tools, or explicitly select up to three Office files and five notes in the chat composer. |
| “Create a report/spreadsheet/presentation and save it in Office” | Generate a real DOCX/XLSX/PPTX/PDF in the current conversation workspace, then `office_import` copies it into Office. HTML/CSV can be created directly with `office_create`. |
| “Put this in my Reports folder” | Resolve the real folder with `office_folders`; create one with `office_create_folder` when requested. Ambiguous destinations require clarification. |
| “Save this chat as DOCX/PDF in Office Suite” | `office_save_chat` reads the current owner's persisted conversation, generates the requested file, saves it and emits an event to open the actual stored file in a preview panel. |
| “Open that Office document” | `office_open` checks access before opening a preview. |
| “Close the preview” | `office_close` closes the panel; the stored file remains in Office. Chat stays available while the panel is open. |
| “Save these notes as a document in Office” | `notes_export_office` creates an HTML copy; Notes also offers selected notes → DOCX with a folder picker. |
| “Make notes from this Office file” | Read the Office snapshot and use `notes_create` when explicitly asked to save. Office's “Save text to Notes” button copies extracted text directly into a new private note. |
| Save a generated conversation document or artifact | Existing “Save a copy to Office Suite” plus `office_import`, scoped to the current conversation. |
| Reopen a saved note | `/notes?note=ID` opens that saved note after loading, subject to ownership. |

## Boundaries

Office reads are saved text snapshots, not live editor state. Extraction can omit images, charts, comments, speaker notes and some headers. Scanned PDFs require OCR. Spreadsheet formulas are not evaluated by snapshot extraction. Office references are capped at three files; selected Notes context is capped at five notes and 30,000 body characters, with explicit truncation metadata.

Conversation exports include the owner's persisted requests and response text, respecting replacement deltas. Unfinished answers are labeled partial. Export rejects more than 100 turns or 200,000 characters rather than silently shortening the transcript. Attachments, tool logs, interactive widget state and file binaries are not embedded in the transcript. Supported Mermaid and Buddy structured flow/sequence blocks render as actual diagram images in Word and diagrams in PDF. Tables become editable Word tables and page-formatted PDF tables. Tables wider than eight columns split into labeled groups with the first column repeated. Dense diagrams include a readable labels/connections appendix (or Mermaid source). Failed diagrams include an explicit notice and source text. Rendering is offline; external images are omitted with a notice. PDF generation requires the configured Chromium/Playwright runtime.

Preview uses ONLYOFFICE in server-signed view-only mode. It does not leave unsaved editor changes when closed. HTML previews offer an explicit link to the existing Office HTML viewer. A download link remains available if the editor cannot load. UI actions apply to the active response stream; historical transcript rendering does not reopen old previews. Event IDs prevent repeated live events from reopening a dismissed panel in the same session.

Transfers create independent copies. They do not overwrite, delete or synchronize source files. Existing in-editor reviewed editing remains the way to modify an Office source. Full-content library search, cross-project automatic ingestion, background synchronization, and Docmost API retrieval are separate work; filename discovery does not imply those capabilities.

## Visual downloads and latest-answer exports

Export & share offers Download Word and Download PDF. These use `GET /sessions/{id}/export?format=docx|pdf` with owner checks. The Office `office_save_chat` tool accepts `content=latest_answer` for requests such as “save this flow as PDF in Office”; it selects the last completed saved answer, excluding a new in-progress save preamble. The default remains the whole conversation. Notes PDF exports and Notes → Office Word copies use the same visual renderer.

## Apps and Tools organization

Apps are grouped by purpose: Workspace, Knowledge & research, Automation, Tools & connections, and additional installed apps. Search includes names, descriptions and category names; empty groups are hidden. Office remains desktop-only and unavailable plugins stay absent. Internal destinations use a forward arrow; external links use the new-tab arrow. App switching closes conflicting panels. Tools groups document, presentation, planning, connection and discovery actions. A connected Microsoft account is labeled as connected without claiming unverified service permissions.

## Branding and display scale

Follow-up forms, interactive answers, Office previews and transfer dialogs share the Buddy mark, purple gradient headers, borders and action colors. New chat/Notes DOCX and PDF exports include the same identity and purple accents.

Each app opening starts in automatic display scale: 100% at viewport widths of 1440px and above, and 85% below that, including phones. Resizing updates the automatic scale. Manual choices apply to the current app session; a previous stored choice does not override the next opening.

## Deployment and verification

Both embedded and separately hosted Office are supported. The Office service must be updated together with core because the new `/api/office/app-actions` endpoint handles identity-bound tool calls. Remote calls use a short-lived JWT with a dedicated audience and exact request body hash, signed using the existing shared `OFFICE_JWT_SECRET`. Browser cookies alone cannot invoke this machine endpoint. File and folder permissions are checked again by Office.

Deploy updated core/worker code, the Office package/service, and frontend assets together. Builds write frontend assets into `app/static/dist`; existing Python processes must reload before new routes/tools become available. No new external account connector is implied.

Focused tests: `tests/test_note_office_bridge.py`, `tests/test_conversation_office_export.py`, `tests/test_office_app_actions.py`, plus the existing Office and Notes tests. These use labeled synthetic fixtures. A live acceptance check should save an existing chat in both formats, verify each file in the chosen folder, open/download it, close via chat, and confirm unauthorized file IDs are rejected. Do not report live acceptance as passed from mocked or static checks.
