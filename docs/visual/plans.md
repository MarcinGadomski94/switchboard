# Plans page (D99) · visual check

The Plans page is not in the prototype; its reference is the approved mockup described in `docs/plans-ui.md` → *The Plans page*. Checked: state colours and icons, hold flags, the critical path, the final node, timeline segments, layout per size, no sideways overflow.

## Desktop (1440 × 900)

- `plans-list-desktop.png`
- card left borders: done oklch(0.74 0.13 150), blocked oklch(0.68 0.17 25), stopped oklch(0.68 0.17 25) (■, "Stopped — needs you"), ready to merge oklch(0.75 0.12 310), question oklch(0.8 0.14 70), running oklch(0.72 0.12 250), waiting rgb(90, 89, 85); the "■ 1 stopped" chip on the plan and its list card
- critical path 3 items: edges 2px oklch(0.8 0.14 70), cards outlined dashed; final node dashed
- graph: wider than the panel: scrolls sideways with an edge fade; scrolled to the end the final node shows whole
- `plans-graph-end-desktop.png`
- `plans-graph-desktop.png`
- `plans-detail-merge-desktop.png`
- `plans-detail-question-desktop.png`
- `plans-detail-stopped-desktop.png`
- timeline: working oklch(0.72 0.12 250), waiting on you oklch(0.8 0.14 70), projected dashed
- `plans-timeline-desktop.png`
- `plans-list-view-desktop.png`
- `plans-mode-dialog-desktop.png`

## Tablet (1024 × 768)

- graph 1174px wide in a 990px box (scrolls sideways, fade on the right; the final node whole at the end); the page does not
- `plans-graph-tablet.png`

## Phone (390 × 844)

- `plans-list-phone.png`
- `plans-detail-phone.png`

