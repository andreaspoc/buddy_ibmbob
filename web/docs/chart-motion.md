# Chart motion

Use the shared values in `src/lib/motion.ts` for application charts and the bundled
Carbon runtime for generated dashboards. These are the user's chosen slower defaults:

| Interaction | Duration |
| --- | --- |
| Initial graph entrance, replay, returning to a chart tab | 1400ms |
| Data/filter/legend update | 700ms |
| Hover, tooltip, keyboard focus | Normal responsive control feedback; no added delay |
| Reduced motion | Immediate; no animated entrance or update |

Use Carbon's productive standard easing, `cubic-bezier(.2,0,.38,.9)`.
The 700ms value is Carbon slow-02. The 1400ms entrance is an application preference
built from two slow-02 intervals, not a separate Carbon token.

Animate the data marks with small opacity/scale/translation changes. Keep axes,
labels, surrounding layout and reader scroll position stable. Never animate each
streamed token, add decorative loops or delay clicks until a chart animation ends.

Keep chart instances and legend selections when switching tabs. Cache initialization
promises and mark a tab ready only after successful creation; failures must remain
retryable. Dispatch `bob:chart-activate` after showing a panel, or call the returned
handle's `replay()` method. Use `handle.update({data,options})` for changes instead
of disposing and rebuilding a chart to create an animation.

Generated HTML must preserve `bob-visual-runtime` and the trusted Carbon asset tags.
The packager embeds the runtime, library, styles and fonts for offline files.
Existing offline files carry their own bundle; rebuild their embedded chart assets
when intentionally updating their motion. Preserve source data and artifact revisions.
