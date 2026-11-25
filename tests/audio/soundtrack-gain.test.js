import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DUCK_RATIO,
  DUCK_RAMP_MS,
  RESTORE_RAMP_MS,
  SOUNDTRACK_MODES,
  computeGainTarget,
  createSoundtrackGain,
  resolveSoundtrackMode,
  setAudioSessionType,
  supportsEnhancedSoundtrack,
} from "../../src/soundtrack-gain.js";
import { FakeAudioContext, fakeMediaElement } from "./fakes.js";

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""} expected ${expected}, got ${actual}`);

function setup(options = {}) {
  const el = fakeMediaElement();
  let ctx;
  const states = [];
  const gain = createSoundtrackGain({
    mediaElement: el,
    createContext: () => (ctx = new FakeAudioContext(options.context)),
    onStateChange: (s) => states.push(s),
    ...options.gain,
  });
  gain.ensure(options.ensure);
  return { el, ctx, gain, param: ctx.gains[0].gain, states };
}

test("gain targets: selected volume alone, 20% of it while ducked", () => {
  assert.equal(DUCK_RATIO, 0.2);
  close(computeGainTarget(1, false), 1);
  close(computeGainTarget(0.5, false), 0.5);
  close(computeGainTarget(0.5, true), 0.1);
  close(computeGainTarget(0, true), 0);
  close(computeGainTarget(2, false), 1, "clamped");
  close(computeGainTarget(-1, true), 0, "clamped");
  close(computeGainTarget(NaN, false), 0, "non-finite");
});

test("graph is source → gain → destination, created once and lazily", () => {
  const el = fakeMediaElement();
  let created = 0;
  let ctx;
  const gain = createSoundtrackGain({ mediaElement: el, createContext: () => (created++, (ctx = new FakeAudioContext())), volume: 0.6 });
  assert.equal(created, 0, "no context before ensure()");
  assert.equal(gain.contextState, "none");
  gain.ensure();
  gain.ensure();
  assert.equal(created, 1, "one context per player");
  assert.equal(ctx.source.mediaElement, el);
  assert.equal(ctx.source.outputs[0], ctx.gains[0]);
  assert.equal(ctx.gains[0].outputs[0], ctx.destination);
  close(ctx.gains[0].gain.value, 0.6, "starts at selected volume");
  assert.equal(el.volume, 1, "element volume untouched");
});

test("ducking ramps to 20% over 400 ms and restores over 800 ms", () => {
  const { ctx, gain, param } = setup({ gain: { volume: 0.8 } });
  assert.equal(gain.setDucked(true), true);
  assert.deepEqual(param.lastRamp(), ["ramp", 0.8 * DUCK_RATIO, DUCK_RAMP_MS / 1000]);
  assert.equal(gain.setDucked(true), false, "idempotent");

  ctx.advance(1);
  close(gain.currentValue(), 0.16);
  gain.setDucked(false);
  const [, to, at] = param.lastRamp();
  close(to, 0.8);
  close(at, 1 + RESTORE_RAMP_MS / 1000);
});

test("a new request cancels the previous ramp and starts from the current value", () => {
  const { ctx, gain, param } = setup({ gain: { volume: 1 } });
  gain.setDucked(true); // 1 → 0.2 over 0.4 s
  ctx.advance(0.2); // halfway: 0.6
  close(gain.currentValue(), 0.6);
  param.calls.length = 0;
  gain.setDucked(false);
  assert.deepEqual(param.calls[0], ["cancel", 0.2]);
  assert.equal(param.calls[1][0], "set");
  close(param.calls[1][1], 0.6, "held at the interrupted value");
  const [, to, at] = param.lastRamp();
  close(to, 1);
  close(at, 0.2 + RESTORE_RAMP_MS / 1000);
});

test("volume changes while ducked keep the duck (no accidental full volume)", () => {
  const { ctx, gain, param } = setup({ gain: { volume: 1 } });
  gain.setDucked(true);
  ctx.advance(1);
  gain.setVolume(0.5);
  close(param.lastRamp()[1], 0.1, "20% of the new volume");
  assert.equal(gain.ducked, true);
  close(gain.volume, 0.5);
  gain.setDucked(false);
  close(param.lastRamp()[1], 0.5, "restores to the new selected volume");
});

test("volume change mid-duck keeps the remaining ramp time", () => {
  const { ctx, gain, param } = setup({ gain: { volume: 1 } });
  gain.setDucked(true);
  ctx.advance(0.1);
  gain.setVolume(0.5);
  const [, to, at] = param.lastRamp();
  close(to, 0.1);
  close(at, 0.4, "ends when the original duck would have ended");
});

test("fade-in on creation starts silent and ramps to the target", () => {
  const { param } = setup({ gain: { volume: 0.7 }, ensure: { fadeInMs: 800 } });
  assert.deepEqual(param.calls[0], ["set", 0, 0]);
  const [, to, at] = param.lastRamp();
  close(to, 0.7);
  close(at, 0.8);
});

test("changes before the graph exists are applied when it is created", () => {
  const el = fakeMediaElement();
  let ctx;
  const gain = createSoundtrackGain({ mediaElement: el, createContext: () => (ctx = new FakeAudioContext()), volume: 1 });
  gain.setVolume(0.5);
  gain.setDucked(true);
  gain.ensure();
  close(ctx.gains[0].gain.value, 0.1);
});

test("resume reports whether the context is actually running", async () => {
  const ok = setup({ context: { state: "suspended" } });
  assert.equal(await ok.gain.resume(), true);
  assert.equal(ok.ctx.resumeCalls, 1);
  assert.deepEqual(ok.states, ["running"]);
  assert.equal(await ok.gain.resume(), true);
  assert.equal(ok.ctx.resumeCalls, 1, "no resume when already running");

  const interrupted = setup({ context: { state: "interrupted", resumeResult: "interrupted" } });
  assert.equal(await interrupted.gain.resume(), false);

  const rejected = setup({ context: { state: "suspended", resumeRejects: true } });
  assert.equal(await rejected.gain.resume(), false);
});

test("dispose disconnects the graph and closes the context; the element cannot be reused", async () => {
  const { el, ctx, gain, states } = setup();
  await gain.dispose();
  assert.equal(ctx.source.disconnected, true);
  assert.equal(ctx.gains[0].disconnected, true);
  assert.equal(ctx.closed, true);
  assert.equal(gain.isConnected, false);
  assert.deepEqual(states, [], "listener removed before close");
  assert.equal(await gain.resume(), false);
  assert.throws(() => gain.ensure(), /disposed/);
  await gain.dispose();

  // Switching back to native output needs a fresh element: the old one stays
  // bound to its (closed) context.
  const again = createSoundtrackGain({ mediaElement: el, createContext: () => new FakeAudioContext() });
  assert.throws(() => again.ensure(), /already connected/);
  const fresh = createSoundtrackGain({ mediaElement: fakeMediaElement(), createContext: () => new FakeAudioContext() });
  assert.doesNotThrow(() => fresh.ensure());
});

test("mode resolution keeps compatibility mode unless enhanced is requested and usable", () => {
  const { COMPAT, ENHANCED } = SOUNDTRACK_MODES;
  assert.equal(resolveSoundtrackMode({}), COMPAT);
  assert.equal(resolveSoundtrackMode({ requested: COMPAT, isIOS: true, supported: true }), COMPAT);
  assert.equal(resolveSoundtrackMode({ requested: ENHANCED, isIOS: true, supported: true }), ENHANCED);
  assert.equal(resolveSoundtrackMode({ requested: ENHANCED, isIOS: true, supported: false }), COMPAT);
  assert.equal(resolveSoundtrackMode({ requested: ENHANCED, isIOS: false, supported: true }), COMPAT, "other platforms unchanged");
  assert.equal(resolveSoundtrackMode({ requested: ENHANCED, isIOS: false, allowAnyPlatform: true, supported: true }), ENHANCED);
});

test("feature detection and audio session type", () => {
  class Ctx { createMediaElementSource() {} createGain() {} }
  assert.equal(supportsEnhancedSoundtrack({ AudioContext: Ctx }), true);
  assert.equal(supportsEnhancedSoundtrack({ webkitAudioContext: Ctx }), true);
  assert.equal(supportsEnhancedSoundtrack({}), false);

  const nav = { audioSession: { type: "auto" } };
  assert.equal(setAudioSessionType("playback", nav), true);
  assert.equal(nav.audioSession.type, "playback");
  assert.equal(setAudioSessionType("playback", {}), false, "API missing");
  const throwing = { audioSession: { set type(_) { throw new Error("nope"); }, get type() { return "auto"; } } };
  assert.equal(setAudioSessionType("playback", throwing), false);
});

test("dispose while a resume is pending resolves false instead of throwing", async () => {
  const { gain } = setup({ context: { state: "suspended" } });
  const pending = gain.resume();
  gain.dispose();
  assert.equal(await pending, false);
});
