# Member messaging

Open **Member chat** using the bottom-right launcher. The compact popup stays alongside your current workspace; expand a conversation to show the list and messages side by side. Minimize to keep your draft without marking new messages as read. Member messaging is separate from assistant conversations. Creating an assistant chat never shares its contents.

Use **New message** to search registered members by profile name and select the recipient. The recipient stays visible above the composer. Messages show profile names, and your own messages show “You,” instead of internal identity IDs.

In **Channels**, choose **Create group**, give it a name, and select its members. Private groups are the default: only the creator and selected registered members can discover the group or access its messages, audience list and downloads. You can instead choose an **Open channel**, which any signed-in member can discover and join. Joining grants access to its history; leaving removes access to messages and downloads. Private groups cannot be rejoined through the open-channel subscription endpoint. Channel owners can manage membership in Conversation tools → Members. New members can access earlier history and shared files; removing someone revokes access.

Notes and files are sent only after the sender selects them and presses **Send** or **Enter**. Use **Shift+Enter** for a new line; Enter used to confirm an IME composition does not send. Sharing a note copies its current title and body into that conversation. Subsequent edits to the original note do not update the shared copy. Files, including presentations, are downloaded as attachments with a 20 MB per-file limit. Message text is displayed as plain text.

Unread counts appear on the launcher and individual conversations. Fetching messages does not mark them as read. The browser explicitly acknowledges messages only after they are visible in an open conversation in a focused, foreground tab. Messages below the visible scroll area remain unread until displayed. Sent direct messages show **Sent** until the other participant acknowledges viewing them, then **Seen**. Group messages show **Seen by N**, with reader names available in the status tooltip. Receipts describe display acknowledgement, not proof that a person read or understood the text. Minimized conversations do not fetch or mark messages as read. The application uses an authenticated same-origin WebSocket for update signals, with HTTP fetching, reconnects, and polling fallback. Signals contain no message text or attachments. PostgreSQL LISTEN/NOTIFY supports multiple API processes; history and read positions remain durable in PostgreSQL. Explicit seen positions are stored separately from older unread counters, so historical fetches do not retroactively become seen receipts.

You can delete your own sent messages after an inline confirmation. This removes the message and its shared file from the application database; it cannot revoke copies already downloaded by recipients or copies in existing database backups. Other members cannot delete your messages.

Every HTTP endpoint authenticates the user. Reads, sends, and downloads check membership on the server. Direct conversations have exactly their two registered participants. A sender can select only their own saved notes. Cross-origin writes and WebSocket upgrades are rejected. WebSocket sessions are periodically revalidated for logout and expiry.

Use the existing HTTPS deployment for HTTPS/WSS transport. Content is stored server-side in PostgreSQL; this is not end-to-end encryption, and database/server operators retain access. Browser push and email notifications are not included. Conversation notification modes and quiet hours control in-app alerts.

Validation: `tests/test_community.py` covers authorization and PostgreSQL integration; `tests/test_community_browser.py` uses explicitly synthetic fixtures to check navigation, deliberate sending, and mobile layout.

## New-message popups and emojis

Incoming messages show a Buddy notification card above the launcher with your first name, the sender and, for groups/channels, the channel name. **Open chat** opens that exact conversation. Dismissing a card never marks messages read. Cards hide after ten seconds, pause while hovered or focused, and group successive messages from one conversation. Only three cards are shown at once. The launcher also pulses briefly and keeps the unread count.

Popups use incoming message IDs returned by the membership-filtered room API. They do not fetch message contents, replay the existing backlog on login, notify for your own sends, or repeat because a read receipt changed. The conversation currently being viewed is suppressed. These are in-app notifications; they do not request operating-system notification permission or display message text on a lock screen. Messages received in a hidden tab are checked when you return.

The smile button beside the composer opens the emoji picker. Choosing an emoji inserts Unicode at the draft cursor; it never sends by itself. Enter sends the completed draft and Shift+Enter inserts a new line.

## Bob away assistant

Open the robot button in the chat header. Automatic replies are **off by default**. Enter instructions containing only information Bob may share with the sender, choose a start (blank means now) and an end within seven days, then explicitly enable and save. A preview generates an example without sending it or enabling the schedule. You can disable a schedule at any time.

Bob generates a fresh, short response to each eligible incoming direct message using the saved instructions and up to three previous automatic replies from that same conversation to avoid repetition. It does not read notes, attachments, files, assistant history or other conversations. Generation runs in an isolated temporary workspace/home with a custom mode permitting no tool groups, and no connected MCP or knowledge tools. No canned message is sent when generation fails; the settings panel reports an error.

Replies are labeled **Bob · automatic reply**. They work while the browser is closed because a durable PostgreSQL queue is processed by the existing background worker. Only direct human messages qualify; group/channel messages and automatic replies do not trigger automation. At most one reply per conversation per minute is published. Manually replying pauses Bob in that conversation for the current saved schedule. Saving a new schedule resets these pauses. Settings changes, expiry, membership and manual replies are checked again before publication, so disabling while generation is underway prevents sending.

The worker uses bounded leases and retries, deduplicates triggering messages, and rejects exact normalized repeats of the recent automatic replies. Generated language may vary; variation is not a guarantee of factual accuracy, so provide clear availability and response boundaries in the instructions.

Additional validation: `tests/test_community_notifications.mjs`, `tests/test_community_notifications_browser.py`, `tests/test_community_away.py`, and `tests/test_community_away_browser.py`. Live provider generation and a disposable-account test of the deployed worker verified distinct outputs and a browser-independent generated reply; all test data was removed.


## Integrated collaboration

Notes, saved artifacts and presentations, selected assistant answers, and rendered research reports provide **Share to people**. Choose a recipient or joined channel, review the copy, and explicitly confirm. Text can be edited before sharing. Live/unsaved artifacts must be saved first. Report snapshots contain rendered text rather than private evidence attachments or source-link targets.

Conversation tools provide members, files, tasks, search, pins, notifications, and personal Bob instructions for that inbox. Message actions provide reactions, threads, pinning, saving a linked private note, assigned tasks/reminders, and selected-message Bob assistance. Assigned tasks also appear in the main Tasks view; due tasks and unread people messages appear in the unified notification inbox. Task status changes are restricted to the creator or assignee. Search only returns conversations the member can currently access.

**@Bob** opens a selection step: explicitly select up to twenty messages and ask a question. Only selected shared text and the requesting member's instructions are passed to the tool-free model. Bob's shared answer is labeled as requested assistance. Private files and assistant history are not implicitly included. Away replies and requested answers use the actual sender/recipient/conversation names, the language of the question, and fresh wording; exact repeats are retried and refused if necessary. Personal inbox instructions can be set in **Bob for this inbox**.

The @ picker inserts a named mention and notifies the selected current members. Conversation alerts can be all messages, mentions only, or muted. Quiet hours have an explicit IANA time zone and support overnight periods. These controls never mark messages read. Exact per-message acknowledgements prevent viewing a thread from marking unseen main-conversation messages Seen.

**Permanent deletion:** deleting an owned message removes its stored body, attachment, shared-card metadata, reactions and seen records. It also recursively purges tracked saved-note copies and their versions/attachments, forwarded copies, linked tasks, pending automatic-reply work, and dependent Bob replies, including derivatives in other app conversations. Other people’s independent thread replies remain their own messages. Private source notes that existed before sharing are not derivatives and remain private. Screenshots, manual exports/downloads, external services and existing backups cannot be revoked; the confirmation states this limit. SQL search and files lists reflect deletion without a separate retained content index.

Validation includes `test_community_collaboration.py` (PostgreSQL permissions, exact receipts, revocation and purge), `test_community_bob.py` (selected context, language and inbox privacy), `test_people_collaboration_browser.py`, and `test_people_sharing_browser.py`. New-chat branding is scoped to the empty assistant conversation.

## Typing indicators

Open private conversations show the other member's profile name while they type. Groups show up to two names and a count for additional typists. Thread signals stay within the matching thread. Activity is throttled while typing and stops on send, empty draft, blur, minimization or switching conversations. If a stop event is lost, the indicator expires after about seven seconds.

Typing uses authenticated same-origin POST signals and ephemeral PostgreSQL notifications delivered through the existing WebSocket. Both sender and receiver membership are checked before delivery. Draft text is rejected by the signal schema, and typing events are not written to message history or a presence table. Automated Bob replies never imply that a human is typing. Checks: `test_community_typing.py` (including real PostgreSQL/WebSocket filtering) and `test_community_typing_browser.py`.
