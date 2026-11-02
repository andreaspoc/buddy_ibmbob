# Interactive forms in Office Buddy

Choose **Fillable form** in Office Suite, enter a name, and select **Create & open**. The `/office/new/form` route also opens this creation dialog.

Forms are stored as PDF files. In ONLYOFFICE, select **Edit PDF** if necessary, then use the **Forms** tab to insert text fields, checkboxes, dropdowns, and other fields. Configure field names, required values, and choices in the field settings. Use the editor preview to check the form, then **Save to Office Suite** before downloading the saved PDF.

You can also upload an existing PDF and add fields using the same editor. Form files use the existing PDF library filter, folder permissions, sharing, and save callbacks. Read-only shares remain read-only. This creation option does not add response collection or a public submission endpoint.

PDF form editing requires ONLYOFFICE Docs 8.1 or newer; the repository configures 9.3.1. See the [ONLYOFFICE forms integration documentation](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/embedding-forms-into-a-web-page).

## Create a form by asking Buddy

In the main chat, ask for a form, for example: “Create a leave request form with employee name, email, start and end dates, a reason box, and an approval checkbox.” Buddy uses `office_create_form`, saves a new PDF in your Office library, and opens it. The schema includes named fields, required flags, dropdown options and an optional destination folder. Fields start empty. Use a new chat turn after a deployment so the tool list refreshes.

The service generates PDF AcroForm widgets, not text-box imitations. Supported field types are text, textarea, email, date, checkbox and dropdown. Email/date fields provide format guidance without automatic validation. Labels currently use the PDF standard Windows ANSI font and do not support other scripts. This feature does not add submission collection, signatures, conditional logic or changes to existing PDFs.

`office_capabilities` exposes the current tool schemas and PDF editor limitations to Buddy. In-editor PDF actions remain gated by live capabilities: adding text, replacing accessible editable text objects, and rotating pages. The in-editor assistant proposes a separate new form for review and does not claim static text boxes are fillable fields.

The Office sidebar also supports creating a separate new form. Ask for the form,
review its fields and choices, then select **Create form**. Creation uses the same
validated PDF generator and retry receipts as main chat. Successful creation automatically opens
the saved PDF in the editor, using the existing unsaved-changes check before
leaving the current document. A saved-form link remains available if navigation
is cancelled. No form is saved at preview time.
