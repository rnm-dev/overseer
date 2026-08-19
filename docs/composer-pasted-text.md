# Huge pastes become attachments

A pasted wall of text — a log, a stack trace, a whole document — buries the
instruction it was meant to accompany, in a composer whose input is at most a
few lines tall. Past a threshold the composer captures the paste as a text file
attachment instead, leaving the field for the message.

## The rule

Plain text is attached instead of inserted when it is **2000 characters or
longer, or 50 lines or taller**. Anything smaller pastes into the field as
before. Both surfaces share these numbers:

- web: `apps/web/src/features/sessions/pastedText.ts`;
- client: `apps/client/lib/features/sessions/domain/pasted_text.dart`.

The attachment is named `pasted-text-<epoch-millis>.txt`, with a `-<index>`
suffix when a second paste lands in the same message before the clock moves.
It is sent with `type: "file"`, so the agent reads it as text rather than as
visual content. The composer chip reads "Pasted text" instead of the generated
file name.

## Falling back to an inline paste

Capturing a paste must never lose it. The text goes into the field as usual
whenever it cannot become an attachment:

- file transfer is off on the peon (web: `filesEnabled`);
- the message already carries the maximum of 10 attachments;
- the block is larger than the 25 MB per-file limit (client).

Pasted images and files are unaffected — they follow the existing clipboard
paths described in the composer's own code.

## Where it is wired

The web composer intercepts `onPaste` on the textarea; when the clipboard
carries no files it reads `text/plain` and decides there.

The client cannot see the platform paste, so `SessionComposer` overrides
`PasteTextIntent` and the selection toolbar's Paste button, reads the clipboard
itself, and offers the text to `onLongTextPasted`. The host — the session
detail page — returns whether it took the block; a `false` makes the composer
insert it at the caret instead. This is why the interception exists at all in
the client: it is the only place both the keyboard shortcut and the long-press
toolbar meet.

Related: [composer ghost convergence](composer-ghost-convergence.md) for what
happens to the message after it is sent, and
[showing a file](file-viewing.md) for how the attachment is read back.
