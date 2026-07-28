import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audioFocusOwner,
  claimAudioFocus,
  hasAudioFocus,
  promoteAudioFocus,
  releaseAudioFocus,
  resetAudioFocus,
  setAudioFocusActive,
} from "./audioFocus.js";

test("the newest client owns audio and a disconnect hands it back to the one underneath", () => {
  resetAudioFocus();
  claimAudioFocus("operator", "desktop", "socket-desktop");
  assert.equal(audioFocusOwner("operator"), "desktop");

  claimAudioFocus("operator", "phone", "socket-phone");
  assert.equal(audioFocusOwner("operator"), "phone");
  assert.equal(hasAudioFocus("operator", "desktop"), false);

  // The desktop window never left; closing the phone must give it the sound back.
  releaseAudioFocus("operator", "phone", "socket-phone");
  assert.equal(audioFocusOwner("operator"), "desktop");

  releaseAudioFocus("operator", "desktop", "socket-desktop");
  assert.equal(audioFocusOwner("operator"), null);
});

test("a client keeps audio until its last socket closes", () => {
  resetAudioFocus();
  claimAudioFocus("operator", "desktop", "socket-selected");
  claimAudioFocus("operator", "phone", "socket-phone");
  // A fleet dashboard opens extra workspace sockets from the desktop tab. That
  // tab is already here — another socket of it is not a client arriving.
  claimAudioFocus("operator", "desktop", "socket-fleet");
  assert.equal(audioFocusOwner("operator"), "phone");

  releaseAudioFocus("operator", "phone", "socket-phone");

  releaseAudioFocus("operator", "desktop", "socket-fleet");
  assert.equal(audioFocusOwner("operator"), "desktop");
  releaseAudioFocus("operator", "desktop", "socket-selected");
  assert.equal(audioFocusOwner("operator"), null);
});

test("a backgrounded client neither holds nor steals audio", () => {
  resetAudioFocus();
  claimAudioFocus("operator", "desktop", "socket-desktop");
  claimAudioFocus("operator", "phone", "socket-phone");
  assert.equal(audioFocusOwner("operator"), "phone");

  // Phone goes into a pocket: the screen locks, the tab hides.
  setAudioFocusActive("operator", "phone", false);
  assert.equal(audioFocusOwner("operator"), "desktop");

  // Its socket flaps on a bad link. Reconnecting is not a reason to beep in a pocket.
  releaseAudioFocus("operator", "phone", "socket-phone");
  claimAudioFocus("operator", "phone", "socket-phone-2");
  assert.equal(audioFocusOwner("operator"), "desktop");

  // Picking the phone up again is.
  setAudioFocusActive("operator", "phone", true);
  assert.equal(audioFocusOwner("operator"), "phone");
});

test("returning to a client that stayed connected takes audio back", () => {
  resetAudioFocus();
  claimAudioFocus("operator", "desktop", "socket-desktop");
  setAudioFocusActive("operator", "desktop", false); // operator walked away
  claimAudioFocus("operator", "phone", "socket-phone");
  assert.equal(audioFocusOwner("operator"), "phone");

  setAudioFocusActive("operator", "desktop", true);
  assert.equal(audioFocusOwner("operator"), "desktop");
});

test("a deliberate gesture claims audio for the client it was made on", () => {
  resetAudioFocus();
  claimAudioFocus("operator", "desktop", "socket-desktop");
  claimAudioFocus("operator", "phone", "socket-phone");
  assert.equal(audioFocusOwner("operator"), "phone");

  promoteAudioFocus("operator", "desktop");
  assert.equal(audioFocusOwner("operator"), "desktop");
  // An unknown client cannot conjure itself into the stack.
  promoteAudioFocus("operator", "ghost");
  assert.equal(audioFocusOwner("operator"), "desktop");
});

test("everything silent still leaves an owner, and operators do not share a stack", () => {
  resetAudioFocus();
  claimAudioFocus("operator", "desktop", "socket-desktop");
  claimAudioFocus("operator", "phone", "socket-phone");
  setAudioFocusActive("operator", "desktop", false);
  setAudioFocusActive("operator", "phone", false);
  // Nobody is looking — that is exactly when a sound is worth playing.
  assert.equal(audioFocusOwner("operator"), "phone");

  claimAudioFocus("other-operator", "desktop", "socket-other");
  assert.equal(audioFocusOwner("other-operator"), "desktop");
  assert.equal(audioFocusOwner("operator"), "phone");
});
