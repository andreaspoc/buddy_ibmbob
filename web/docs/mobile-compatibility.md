# Phone and iPad compatibility

The web app shares the same features on desktop, phone, and tablet. Touch layouts
use 44px targets for primary navigation and composer controls, safe-area insets,
input sizes that avoid Safari focus zoom, and the visual viewport to keep focused
fields reachable when the software keyboard opens. Artifact panels start smaller
on touch devices and reserve room for chat; tool controls remain scrollable.

Phones up to 700px use flat surfaces, no header blur, a horizontally scrolling
context row, and an expandable prompt-template list. Desktop keeps its full
welcome layout. Diagram layout and PowerPoint export libraries load only when
used, rather than during normal chat startup.

## Automated verification

- `tests/test_mobile_light_browser.py`: compact phone welcome, template expansion,
  reachable context controls, deferred optional libraries, and full desktop layout.

- `tests/test_responsive_browser.py`: 19 phone, iPad and desktop dimensions;
  navigation, menu placement, drawer dismissal, density and 75/85/100% scaling.
  Set `RESPONSIVE_TOUCH=1` to enable touch emulation.
- `tests/test_mobile_features_browser.py`: 14 feature entry points at eight phone
  and tablet sizes, plus a synthetic keyboard viewport resize retaining the draft.
- `tests/test_artifact_responsive_browser.py`: touch artifact previews, separate
  chat/editor space at 14 dimensions and three scales, resizing and persistence.
- `tests/test_new_workspaces_browser.py`: synthetic chat branching, transcript
  review, structured handoff, CSV/Excel uploads and exports, calculations, recipes,
  project memory, notifications and admin/employee MCP/A2A workflows. Supports
  `WORKSPACE_TEST_WIDTH`, `WORKSPACE_TEST_HEIGHT`, and `WORKSPACE_TEST_TOUCH=1`.

These checks use Chromium and intercepted synthetic API responses. They do not
certify real connectors, microphone permissions, hardware keyboards, native file
pickers, downloads, or Safari behavior on physical iPhones/iPads. Check these on
actual devices before claiming complete browser/device compatibility.
