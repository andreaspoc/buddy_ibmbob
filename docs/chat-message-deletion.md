# Individual chat message deletion

Main chat provides **Delete question** and **Delete answer** on saved messages. Office chat provides the same controls for its temporary in-panel conversation; deleted questions and answers are removed from subsequent Office request history, and applied document edits are preserved. Each action requires confirmation and removes only the selected role. The other messages remain available for follow-up questions. Deletion is blocked while a chat or its shared project has an active job.

The authenticated deletion endpoint is `DELETE /sessions/{session_id}/messages/{message_id}`. Ownership is checked before accessing history. Legacy messages receive stable IDs derived from their history row.

Deleting a question removes its prompt, displayed prompt, context references and activity traces. Deleting an answer removes that turn's response events. A content-free boundary with stable routing IDs and deletion flags remains so the surviving sibling, original turn indices, feedback and conversation branching remain coherent. Deleted text is physically removed from active history and originating job records rather than merely hidden by the browser.

The operation clears retained native transcripts for the conversation, removes linked feedback and widgets, revokes shared conversation snapshots, updates derived titles, cleans migrated local journals/transcripts, and purges disposable transcript blob caches. Unreferenced S3 transcript objects are erased with their versions; failures remain in the durable garbage-collection queue and the UI reports pending cleanup. Shared persistent files are protected by reference checks. A disposable byte-cache flush also removes older cached transcript revisions; other files repopulate on demand.

After deletion, chat submission refuses stale retries of the deleted message and starts fresh model sessions, supplying only remaining saved conversation context. This also applies to follow-ups through configured remote agents.

Independently saved notes, files, branches, downloaded exports and copies already sent elsewhere are separate user content and are not deleted by this action. Infrastructure backups and external model-provider retention are outside this application's deletion operation.

Verification includes `tests/test_message_deletion.py`, `tests/message_deletion_integration.py`, `tests/test_message_deletion_browser.py` and `tests/message_deletion_live.py`. Live tests create and clean their own synthetic accounts and conversations.
