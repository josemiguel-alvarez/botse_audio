import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MEDIA_SESSION_ACTIONS,
  NARRATION_STATUS,
  applyMediaSessionControls,
  createNarrationDucking,
} from "../../src/narration-ducking.js";

function setup() {
  const changes = [];
  const ducking = createNarrationDucking({ onChange: (s, reason) => changes.push({ ...s, reason }) });
  return { ducking, changes, ducked: () => ducking.snapshot().ducked, owner: () => ducking.snapshot().owner };
}

test("play ducks; pause, finish, failure and detach restore", () => {
  for (const release of ["pause", "finish", "fail", "detach"]) {
    const { ducking, ducked } = setup();
    const token = ducking.attach();
    assert.equal(ducked(), false, "attached but not playing");
    ducking.play(token);
    assert.equal(ducked(), true);
    assert.equal(ducking[release](token), true, release);
    assert.equal(ducked(), false, `${release} restores`);
  }
});

test("pause → resume → finish keeps ducking consistent", () => {
  const { ducking, ducked } = setup();
  const token = ducking.attach();
  ducking.play(token);
  ducking.pause(token);
  assert.equal(ducked(), false);
  ducking.play(token);
  assert.equal(ducked(), true);
  assert.equal(ducking.finish(token), true);
  assert.equal(ducked(), false);
});

test("repeated play (seek/buffering while requested) keeps the duck without new events", () => {
  const { ducking, changes, ducked } = setup();
  const token = ducking.attach();
  ducking.play(token);
  const count = changes.length;
  assert.equal(ducking.play(token), true);
  assert.equal(ducking.play(token), true);
  assert.equal(changes.length, count, "no duplicate change notifications");
  assert.equal(ducked(), true);
});

test("completion is idempotent (ended + timer + visibility resync)", () => {
  const { ducking, changes } = setup();
  const token = ducking.attach();
  ducking.play(token);
  assert.equal(ducking.finish(token), true, "ended event");
  assert.equal(ducking.finish(token), false, "timer reconciliation");
  assert.equal(ducking.finish(token), false, "visibility resync");
  assert.equal(ducking.fail(token), false, "late rejection after completion");
  assert.equal(changes.filter((c) => c.reason === "finish").length, 1);
});

test("replay after completion can finish again", () => {
  const { ducking, ducked } = setup();
  const token = ducking.attach();
  ducking.play(token);
  ducking.finish(token);
  ducking.play(token);
  assert.equal(ducked(), true);
  assert.equal(ducking.finish(token), true);
  assert.equal(ducked(), false);
});

test("stale callbacks from an older narration cannot restore music over a newer one", () => {
  const { ducking, ducked } = setup();
  const oldToken = ducking.attach();
  ducking.play(oldToken);
  ducking.detach(oldToken);
  const newToken = ducking.attach();
  ducking.play(newToken);

  assert.equal(ducking.isCurrent(oldToken), false);
  assert.equal(ducking.finish(oldToken), false, "old ended event");
  assert.equal(ducking.fail(oldToken), false, "old play() rejection");
  assert.equal(ducking.pause(oldToken), false);
  assert.equal(ducking.play(oldToken), false);
  assert.equal(ducking.detach(oldToken), false);
  assert.equal(ducked(), true, "newer narration still ducks");
  assert.equal(ducking.snapshot().token, newToken);
});

test("attaching a new narration supersedes the previous one even without detach", () => {
  const { ducking, ducked } = setup();
  const a = ducking.attach();
  ducking.play(a);
  const b = ducking.attach();
  assert.equal(ducked(), false, "new narration starts idle");
  assert.equal(ducking.finish(a), false);
  ducking.play(b);
  assert.equal(ducked(), true);
});

test("rejected playback releases the duck and reports failure once", () => {
  const { ducking, ducked, changes } = setup();
  const token = ducking.attach();
  ducking.play(token);
  assert.equal(ducking.fail(token), true);
  assert.equal(ducking.fail(token), false);
  assert.equal(ducked(), false);
  assert.equal(ducking.snapshot().status, NARRATION_STATUS.FAILED);
  assert.equal(changes.at(-1).reason, "fail");
  // Retrying from a user interaction is allowed.
  ducking.play(token);
  assert.equal(ducked(), true);
});

test("pause is only meaningful while playing", () => {
  const { ducking } = setup();
  const token = ducking.attach();
  assert.equal(ducking.pause(token), false, "idle");
  assert.equal(ducking.finish(token), false, "never started");
});

test("lock-screen ownership: narration while open, music afterwards", () => {
  const { ducking, owner } = setup();
  assert.equal(owner(), "music");
  const token = ducking.attach();
  assert.equal(owner(), "narration", "open narration owns controls");
  ducking.play(token);
  assert.equal(owner(), "narration");
  ducking.pause(token);
  assert.equal(owner(), "narration", "paused narration keeps controls so it can be resumed");
  ducking.play(token);
  ducking.finish(token);
  assert.equal(owner(), "music", "returns to music when finished");
  ducking.play(token);
  assert.equal(owner(), "narration", "replay takes them back");
  ducking.fail(token);
  assert.equal(owner(), "music", "returns to music on failure");
  ducking.detach(token);
  assert.equal(owner(), "music");
});

function fakeMediaSession({ unsupported = [] } = {}) {
  return {
    handlers: {},
    metadata: "initial",
    playbackState: "none",
    setActionHandler(action, handler) {
      if (unsupported.includes(action)) throw new TypeError(`${action} unsupported`);
      if (handler) this.handlers[action] = handler;
      else delete this.handlers[action];
    },
  };
}

test("media session controls replace every handler of the previous owner", () => {
  const ms = fakeMediaSession();
  const music = Object.fromEntries(["play", "pause", "previoustrack", "nexttrack"].map((a) => [a, () => `music:${a}`]));
  applyMediaSessionControls(ms, { metadata: { title: "Track" }, playbackState: "playing", handlers: music });
  assert.deepEqual(Object.keys(ms.handlers).sort(), ["nexttrack", "pause", "play", "previoustrack"]);

  const narration = { play: () => "n:play", pause: () => "n:pause", stop: () => "n:stop" };
  applyMediaSessionControls(ms, { metadata: { title: "Narration" }, playbackState: "paused", handlers: narration });
  assert.deepEqual(Object.keys(ms.handlers).sort(), ["pause", "play", "stop"], "track skipping removed");
  assert.equal(ms.handlers.play(), "n:play");
  assert.deepEqual(ms.metadata, { title: "Narration" });
  assert.equal(ms.playbackState, "paused");

  applyMediaSessionControls(ms, { metadata: null, playbackState: "none" });
  assert.deepEqual(ms.handlers, {});
  assert.equal(ms.metadata, null);
});

test("media session helper tolerates unsupported actions and a missing API", () => {
  const ms = fakeMediaSession({ unsupported: ["stop"] });
  assert.doesNotThrow(() => applyMediaSessionControls(ms, { handlers: { stop: () => {}, play: () => {} } }));
  assert.ok(ms.handlers.play);
  assert.equal(ms.metadata, "initial", "metadata untouched when not provided");
  assert.doesNotThrow(() => applyMediaSessionControls(undefined, {}));
  assert.ok(MEDIA_SESSION_ACTIONS.includes("nexttrack"));
});
