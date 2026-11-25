// Soundtrack gain controller for the enhanced (Web Audio) playback mode.
//
//   <audio> → MediaElementAudioSourceNode → GainNode → destination
//
// The media element keeps streaming the file (it is never decoded into an
// AudioBuffer) and stays at volume 1. Both the user-selected volume and the
// narration ducking are applied through the gain node with AudioParam
// automation, so ramps run on the audio thread instead of on timers that iOS
// throttles in the background.
//
// This module has no DOM or bundler dependencies so it can be unit-tested
// under Node with fake audio objects.

export const DUCK_RATIO = 0.2;
export const DUCK_RAMP_MS = 400;
export const RESTORE_RAMP_MS = 800;
// Short ramp for slider changes, just enough to avoid zipper noise.
export const VOLUME_RAMP_MS = 60;

export const SOUNDTRACK_MODES = Object.freeze({ COMPAT: "compat", ENHANCED: "enhanced" });

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function computeGainTarget(volume, ducked, duckRatio = DUCK_RATIO) {
  const v = clamp01(volume);
  return ducked ? v * clamp01(duckRatio) : v;
}

export function getAudioContextClass(scope = globalThis) {
  return scope?.AudioContext || scope?.webkitAudioContext || null;
}

export function supportsEnhancedSoundtrack(scope = globalThis) {
  const Ctx = getAudioContextClass(scope);
  const proto = Ctx?.prototype;
  return Boolean(proto && typeof proto.createMediaElementSource === "function" && typeof proto.createGain === "function");
}

// Decides which backend actually drives the soundtrack. Enhanced mode is only
// offered where it has been designed for (iOS/iPadOS), or in development
// builds so it can be exercised on a desktop browser.
export function resolveSoundtrackMode({ requested, isIOS = false, allowAnyPlatform = false, supported = false } = {}) {
  if (requested !== SOUNDTRACK_MODES.ENHANCED) return SOUNDTRACK_MODES.COMPAT;
  if (!supported) return SOUNDTRACK_MODES.COMPAT;
  if (!isIOS && !allowAnyPlatform) return SOUNDTRACK_MODES.COMPAT;
  return SOUNDTRACK_MODES.ENHANCED;
}

// Sets navigator.audioSession.type where the Audio Session API exists
// (Safari 16.4+). Returns true when the type was applied.
export function setAudioSessionType(type, nav = globalThis.navigator) {
  const session = nav?.audioSession;
  if (!session) return false;
  try {
    session.type = type;
    return session.type === type;
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {HTMLMediaElement} options.mediaElement Element to route. It can only
 *   ever be connected to one context: once disposed, create a new element to
 *   get native output back.
 * @param {() => AudioContext} options.createContext Factory, called lazily on
 *   the first ensure()/resume() so it can happen inside a user gesture.
 * @param {number} [options.volume] User-selected volume, 0..1.
 * @param {(state: string) => void} [options.onStateChange]
 */
export function createSoundtrackGain({
  mediaElement,
  createContext,
  volume = 1,
  ducked = false,
  duckRatio = DUCK_RATIO,
  duckRampMs = DUCK_RAMP_MS,
  restoreRampMs = RESTORE_RAMP_MS,
  volumeRampMs = VOLUME_RAMP_MS,
  onStateChange,
} = {}) {
  if (!mediaElement) throw new TypeError("mediaElement is required");
  if (typeof createContext !== "function") throw new TypeError("createContext is required");

  let ctx = null;
  let source = null;
  let gainNode = null;
  let disposed = false;
  let userVolume = clamp01(volume);
  let isDucked = Boolean(ducked);
  // The last scheduled segment, so the current value can be computed
  // deterministically instead of relying on AudioParam.value mid-automation.
  let ramp = null;

  const target = () => computeGainTarget(userVolume, isDucked, duckRatio);
  const now = () => (ctx ? ctx.currentTime : 0);

  function valueAt(time) {
    if (!ramp) return target();
    if (time >= ramp.t1) return ramp.to;
    if (time <= ramp.t0) return ramp.from;
    return ramp.from + ((ramp.to - ramp.from) * (time - ramp.t0)) / (ramp.t1 - ramp.t0);
  }

  // Cancels whatever is scheduled and ramps from the current value, so a new
  // request always replaces the previous one smoothly.
  function rampTo(value, ms) {
    if (!gainNode) return;
    const param = gainNode.gain;
    const t0 = now();
    const from = valueAt(t0);
    param.cancelScheduledValues(t0);
    param.setValueAtTime(from, t0);
    if (!(ms > 0) || from === value) {
      param.setValueAtTime(value, t0);
      ramp = { from: value, to: value, t0, t1: t0 };
      return;
    }
    const t1 = t0 + ms / 1000;
    param.linearRampToValueAtTime(value, t1);
    ramp = { from, to: value, t0, t1 };
  }

  function handleStateChange() {
    onStateChange?.(ctx?.state ?? "closed");
  }

  function ensure({ fadeInMs = 0 } = {}) {
    if (disposed) throw new Error("Soundtrack gain controller has been disposed");
    if (ctx) return ctx;
    ctx = createContext();
    source = ctx.createMediaElementSource(mediaElement);
    gainNode = ctx.createGain();
    const t0 = ctx.currentTime;
    const initial = fadeInMs > 0 ? 0 : target();
    gainNode.gain.setValueAtTime(initial, t0);
    ramp = { from: initial, to: initial, t0, t1: t0 };
    source.connect(gainNode);
    gainNode.connect(ctx.destination);
    if (typeof ctx.addEventListener === "function") ctx.addEventListener("statechange", handleStateChange);
    else ctx.onstatechange = handleStateChange;
    if (fadeInMs > 0) rampTo(target(), fadeInMs);
    return ctx;
  }

  return {
    ensure,

    get contextState() {
      return ctx ? ctx.state : "none";
    },

    get isConnected() {
      return Boolean(ctx) && !disposed;
    },

    get volume() {
      return userVolume;
    },

    get ducked() {
      return isDucked;
    },

    get target() {
      return target();
    },

    currentValue() {
      return valueAt(now());
    },

    // Resumes the context; call from a user interaction when it is not
    // running. Resolves to true only if the context reports "running", which
    // still does not guarantee audible output.
    async resume() {
      if (disposed) return false;
      ensure();
      // Kept locally: dispose() may run while the resume is pending.
      const context = ctx;
      if (context.state === "running") return true;
      try {
        await context.resume();
      } catch {
        return false;
      }
      return !disposed && context.state === "running";
    },

    // Separate from the ducking state: moving the slider while ducked only
    // changes the level that is restored later.
    setVolume(value) {
      userVolume = clamp01(value);
      if (!gainNode) return;
      const t0 = now();
      const remainingMs = ramp && ramp.t1 > t0 ? (ramp.t1 - t0) * 1000 : 0;
      rampTo(target(), Math.max(volumeRampMs, remainingMs));
    },

    setDucked(value) {
      const next = Boolean(value);
      if (next === isDucked) return false;
      isDucked = next;
      rampTo(target(), next ? duckRampMs : restoreRampMs);
      return true;
    },

    snapshot() {
      return {
        contextState: ctx ? ctx.state : "none",
        volume: userVolume,
        ducked: isDucked,
        target: target(),
        gain: valueAt(now()),
      };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      const closing = ctx;
      try { source?.disconnect(); } catch {}
      try { gainNode?.disconnect(); } catch {}
      if (closing) {
        if (typeof closing.removeEventListener === "function") closing.removeEventListener("statechange", handleStateChange);
        else closing.onstatechange = null;
      }
      source = null;
      gainNode = null;
      ramp = null;
      ctx = null;
      if (closing && typeof closing.close === "function" && closing.state !== "closed") {
        try { await closing.close(); } catch {}
      }
    },
  };
}
