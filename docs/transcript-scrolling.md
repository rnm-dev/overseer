# Transcript scrolling

The web transcript follows new output while the operator is standing at the
bottom of it, and never otherwise. That is the whole rule. It is decided from
one measurement the browser already reports — how far the scroller is from its
own end — and it is re-decided on every scroll event, the operator's and
Virtuoso's alike. `apps/web/src/features/sessions/transcriptFollow.ts` holds
the thresholds and `PeonSessionDetail` holds the single ref they set.

## What this replaced

Following used to be inferred from Virtuoso's at-bottom transitions, and those
transitions were suppressed for 800 ms after each automatic scroll so that the
scroll itself would not read as the operator leaving the bottom. On a long turn
the agent appended rows faster than that window closed, so the suppression never
lifted: scrolling up to read history was ignored, and the next event dragged the
viewport back down. The transcript appeared to scroll by itself, and the effect
was worst exactly when the operator most wanted to read — a Peon that had been
working for minutes.

Position is not a guess, so nothing here needs a timer, a suppression window or
a recovery path.

## Instant, not smooth

Automatic scrolling is instant. A smooth animation is in flight while the list
is still growing: its intermediate positions read as "not at the bottom" and its
target is stale before it lands, so two arriving rows leave the viewport parked
just above the end with following switched off. The animation was also the part
that looked like the page moving on its own. The operator's own send still lands
on its ghost in one jump once Virtuoso has measured it.

## Thresholds

A few pixels of rounding — sub-pixel layout, the scrollbar's own rounding, a row
whose height settles a frame after it paints — still count as the bottom
(`TRANSCRIPT_AT_BOTTOM_PX`). The jump-to-newest control is deliberately not the
inverse: it appears only after a full screen of distance, because a couple of
rows up is still the tail of the conversation and does not need a button over
it.

## What is deliberately not here

Nothing pins the viewport to a row while history above it changes height. Rows
grow when a tool result joins its call and when a long body finishes measuring,
and Virtuoso's own size cache absorbs that. If a jump is ever traced to that
path it belongs with the virtualization window in `transcriptVirtualization.ts`,
not with following.

The Flutter client has its own transcript scrolling and is not covered by this
page. The composer's placeholder, which is a different reason for the list to
change length while a turn is pending, is in [composer ghost
convergence](composer-ghost-convergence.md).
