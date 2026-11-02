# Chat navigation

The header has three entry points:

| Menu | Purpose |
| --- | --- |
| Apps | Open workspaces: chat, Notes, Office, member chat, knowledge, research, tasks, workflows, presentations, productivity and saved-work search. Availability still comes from the authenticated app registry. |
| Buddy | Control the current conversation: assistant, commands, focus, new chat, export/share, document comparison, artifacts, project memory, approvals and usage. Context-dependent actions remain unavailable until their prerequisites exist. |
| Settings | Configure account access, connected services, additional connections/agents, extensions, scale and density. |

The overlapping Tools menu is removed. Connection management appears in Settings rather than also appearing as an Apps card. Notifications retain their header bell. Office and Notes have deliberate shortcuts beside the chat input; they use the same workspace actions as Apps.

The compact row immediately above the message box contains the Office/Notes shortcuts, note/file reference pickers, Templates switch and Voice chat. Selected references appear in a separate bounded tray. Pickers and voice controls open above this row, so they do not push the input down. Notes remain available on mobile; Office keeps its existing desktop restriction. Dictate edits text in the input; Voice chat starts a spoken conversation only after the user starts it.

Prompt-template cards and quick-start suggestions are hidden by default. The Templates switch enables them on empty/new chats. The preference is stored locally per account and survives reloads; existing custom template definitions are preserved. Presentation templates remain part of explicitly requested presentation creation.

Verification: TypeScript, app-registry contract tests, responsive navigation tests, and `tests/test_chat_tools_layout_browser.py`, including 320px and 390px layouts, popup bounds, focus return, reference selection and template preference persistence.

Touch screens up to 1100px use native 100% UI scale and at least 16px input text to avoid focus zoom. The visible viewport tracks the software keyboard. Member chat follows the entire composer height, including changing references and shortcuts, and its floating launcher/notifications yield while the Buddy input is focused. The member chat panel fits the visible viewport when its own keyboard opens.
