// Narration lifecycle → soundtrack ducking and lock-screen ownership.
//
// Each narration player attaches and receives a token (its generation).
// Media events and promise callbacks report back with that token, so a late
// callback from an old narration can never restore the music over a newer one.
// Terminal transitions (finish/fail) only succeed once, which makes the
// `ended` event, the UI timer and the foreground resync safe to race.
//
// No DOM or bundler dependencies, so it can be unit-tested under Node.

export const NARRATION_STATUS = Object.freeze({
  NONE: "none",
  IDLE: "idle",
  PLAYING: "playing",
  PAUSED: "paused",
  FINISHED: "finished",
  FAILED: "failed",
});

const OWNING_STATUSES = new Set([NARRATION_STATUS.IDLE, NARRATION_STATUS.PLAYING, NARRATION_STATUS.PAUSED]);

export function createNarrationDucking({ onChange } = {}) {
  let generation = 0;
  /** @type {null | { token: number, status: string }} */
  let current = null;
  let last = null;

  function snapshot() {
    const status = current ? current.status : NARRATION_STATUS.NONE;
    return {
      token: current ? current.token : null,
      status,
      // Seeking and buffering keep the "playing" status, so ducking holds.
      ducked: status === NARRATION_STATUS.PLAYING,
      // An open narration (playing, paused or not yet started) owns the
      // lock-screen controls; once it finishes, fails or closes they return
      // to the music.
      owner: OWNING_STATUSES.has(status) ? "narration" : "music",
    };
  }

  function emit(reason) {
    const next = snapshot();
    if (last && last.token === next.token && last.status === next.status) return;
    last = next;
    onChange?.(next, reason);
  }

  const isCurrent = (token) => Boolean(current) && current.token === token;

  function transition(token, from, to, reason) {
    if (!isCurrent(token)) return false;
    if (!from.includes(current.status)) return false;
    current.status = to;
    emit(reason);
    return true;
  }

  return {
    attach() {
      generation += 1;
      current = { token: generation, status: NARRATION_STATUS.IDLE };
      emit("attach");
      return generation;
    },

    isCurrent,

    // Playback requested (start, resume, replay or seek while playing).
    play(token) {
      if (!isCurrent(token)) return false;
      if (current.status === NARRATION_STATUS.PLAYING) return true;
      current.status = NARRATION_STATUS.PLAYING;
      emit("play");
      return true;
    },

    pause(token) {
      return transition(token, [NARRATION_STATUS.PLAYING], NARRATION_STATUS.PAUSED, "pause");
    },

    // Returns true only the first time, so callers can use it as a guard.
    finish(token) {
      return transition(token, [NARRATION_STATUS.PLAYING, NARRATION_STATUS.PAUSED], NARRATION_STATUS.FINISHED, "finish");
    },

    // Playback rejected or terminal media error.
    fail(token) {
      return transition(
        token,
        [NARRATION_STATUS.IDLE, NARRATION_STATUS.PLAYING, NARRATION_STATUS.PAUSED],
        NARRATION_STATUS.FAILED,
        "fail"
      );
    },

    // Panel closed or player stopped.
    detach(token) {
      if (!isCurrent(token)) return false;
      current = null;
      emit("detach");
      return true;
    },

    snapshot,
  };
}

// Actions this app registers. Every one is (re)assigned on each call so that
// handlers from the previous owner never linger.
export const MEDIA_SESSION_ACTIONS = Object.freeze(["play", "pause", "stop", "previoustrack", "nexttrack"]);

export function applyMediaSessionControls(mediaSession, { metadata, playbackState, handlers = {} } = {}) {
  if (!mediaSession) return;
  for (const action of MEDIA_SESSION_ACTIONS) {
    try {
      mediaSession.setActionHandler(action, handlers[action] ?? null);
    } catch {
      // Unsupported action on this platform.
    }
  }
  if (metadata !== undefined) mediaSession.metadata = metadata;
  if (playbackState) {
    try { mediaSession.playbackState = playbackState; } catch {}
  }
}
