# People chat: collaboration review

The existing implementation already provides direct messages, private groups, discoverable open channels, membership controls, threads, mentions, emoji reactions, pinned messages, shared file copies, shared notes/artifacts, tasks with assignees/reminders, search, read receipts, typing signals, notification controls, away replies, and Buddy requests against explicitly selected messages. Private assistant histories and original private workspaces are not implicitly available to peers.

## Implemented usability improvements

- Text and explicit mention metadata are stored separately by signed-in username, room and thread. Switching threads restores that thread's draft rather than moving the main conversation's unsent text into a reply. Successful sends clear their original draft, even if the UI has since switched context. Failures retain the draft.
- Drafts use tab-scoped browser session storage, with an in-memory fallback when storage is restricted. They are not synchronized across devices. Files and selected note attachments are not persisted as drafts and are reset when moving between contexts. Browser-storage failure can prevent restoration after reload; the mounted chat still retains its in-memory text drafts.
- An Unread filter works alongside the existing Messages/Channels selection and conversation-name search. The currently selected conversation remains visible after its unread count reaches zero. Filtering never marks messages read or changes notification preferences.
- Conversation shortcuts expose Messages, Shared files, Tasks, Pinned messages and Search while retaining the existing tools.
- Date separators use actual message timestamps and the selected locale. Invalid dates do not produce invented date labels.
- A Jump to latest control lets a reader return from older messages. Existing visibility-based read acknowledgements remain responsible for read receipts; the new controls do not mark unseen messages as read.

The existing Buddy palette and compact/mobile layouts are retained. No Teams/Slack service connection or external message delivery was added.

## Further work worth considering

1. Message editing with sender authorization, an edited indicator, revision/concurrency checks and a clear retention policy.
2. Dedicated thread panels and a followed-threads inbox, with per-user read/unread tracking for replies.
3. User-specific saved-message bookmarks, distinguished from room-wide pinned messages.
4. Channel descriptions/topics, owner administration and archives, preserving membership/access checks.
5. Search filters for sender, date and attachment type, returning only authorized conversations.
6. Presence and custom status with defined expiry; online/offline must reflect real connection activity rather than inferred or fabricated availability.
7. Calls, screen sharing and meetings as a separate real-time media integration requiring an actual media/signaling service.
8. External Microsoft Teams or Slack connectivity through authorized connectors, with explicit workspace/channel scopes and an agreed synchronization policy. The local people chat does not currently imply those connections exist.

## Verification

The draft tests cover account/room/thread isolation, mention metadata, draft removal, size bounds, malformed/restricted storage, local-date keys, context switching, late send completions, and in-memory fallback. TypeScript, production build and static UI translation checks should run before deployment. Live browser interaction checks require access to the running application/browser environment.
