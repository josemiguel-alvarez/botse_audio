// Soundtrack gain controller backed by Web Audio:
//
//   <audio> → MediaElementAudioSourceNode → GainNode → destination
//
// The media element keeps streaming the file (it is never decoded into an
// AudioBuffer) and stays at volume 1. Both the user-selected volume and the
// narration ducking are applied through the gain node with AudioParam
// automation, so ramps run on the audio thread instead of timers that iOS
// throttles in the background.

export const DUCK_RATIO = 0.2;
export const DUCK_RAMP_MS = 400;
export const RESTORE_RAMP_MS = 800;
// Short ramp for slider changes, just enough to avoid zipper noise.
export const VOLUME_RAMP_MS = 60;

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

export function isIOSDevice(nav = globalThis.navigator) {
  const ua = nav?.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);
}

export function supportsSoundtrackGain(scope = globalThis) {
  const Ctx = getAudioContextClass(scope);
  const proto = Ctx?.prototype;
  return Boolean(proto && typeof proto.createMediaElementSource === "function" && typeof proto.createGain === "function");
}

// Sets navigator.audioSession.type where the Audio Session API exists
// (Safari 16.4+). Setting "playback" lets Web Audio continue when iOS locks.
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
 * @param {HTMLMediaElement} options.mediaElement Element to route.
 * @param {() => AudioContext} options.createContext Factory, called lazily on
 *   the first ensure()/resume() so it can happen inside a user gesture.
 * @param {number} [options.volume] User-selected volume, 0..1.
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
} = {}) {
  if (!mediaElement) throw new TypeError("mediaElement is required");
  if (typeof createContext !== "function") throw new TypeError("createContext is required");

  let ctx = null;
  let gainNode = null;
  let userVolume = clamp01(volume);
  let isDucked = Boolean(ducked);
  // Track the last scheduled segment so interrupted ramps restart from the
  // current interpolated gain instead of jumping.
  let ramp = null;

  const target = () => computeGainTarget(userVolume, isDucked, duckRatio);
  const now = () => (ctx ? ctx.currentTime : 0);

  function valueAt(time) {
    if (!ramp) return target();
    if (time >= ramp.t1) return ramp.to;
    if (time <= ramp.t0) return ramp.from;
    return ramp.from + ((ramp.to - ramp.from) * (time - ramp.t0)) / (ramp.t1 - ramp.t0);
  }

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

  function ensure() {
    if (ctx) return ctx;
    ctx = createContext();
    const source = ctx.createMediaElementSource(mediaElement);
    gainNode = ctx.createGain();
    const t0 = ctx.currentTime;
    const initial = target();
    gainNode.gain.setValueAtTime(initial, t0);
    ramp = { from: initial, to: initial, t0, t1: t0 };
    source.connect(gainNode);
    gainNode.connect(ctx.destination);
    return ctx;
  }

  return {
    ensure,

    get contextState() {
      return ctx ? ctx.state : "none";
    },

    get isConnected() {
      return Boolean(ctx);
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

    async resume() {
      ensure();
      if (ctx.state === "running") return true;
      try {
        await ctx.resume();
      } catch {
        return false;
      }
      return ctx.state === "running";
    },

    // Moving the slider while ducked updates the restored level without
    // overriding the active duck.
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
  };
}
