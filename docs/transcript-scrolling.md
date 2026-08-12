# Web transcript scrolling

The web transcript has one source of follow intent: whether its own Virtuoso
scroller is within `TRANSCRIPT_AT_BOTTOM_PX` of the bottom. Every real scroll
event recomputes that value. New rows follow instantly only while it is true;
scrolling back to the bottom or using the down button enables following again.

While the operator is detached, `PeonSessionDetail` passes literal `false` as
Virtuoso's `followOutput` prop. This is intentionally not a callback that
returns `false`: Virtuoso treats any non-false prop as permission to follow
row-height increases and viewport-height decreases. Consequently live tail,
HTTP reconciliation, reconnect recovery, ghost changes and composer resizing
all share the same policy instead of owning transport- or event-specific scroll
branches.

Older-page prepends remain a separate virtualization concern. They preserve
the visible row by adjusting `firstItemIndex`; they never change follow intent.
