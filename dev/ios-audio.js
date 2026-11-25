// Development-only reproduction of the enhanced soundtrack path, isolated from
// the app: <audio> → MediaElementAudioSourceNode → GainNode → destination for
// the music, native playback for the narration. Served by `npm run dev` at
// /botse_audio/dev/ios-audio.html; not part of the production build.
import SOUNDTRACK from "../src/i18n/es/soundtrack.json";
import {
  DUCK_RATIO,
  createSoundtrackGain,
  getAudioContextClass,
  setAudioSessionType,
} from "../src/soundtrack-gain.js";

const BASE = import.meta.env.BASE_URL;
const LOG_KEY = "botse_audio:iosAudioRepro";
const LOG_LIMIT = 1500;
const ST_CACHE_NAME = "botse-soundtrack-v2"; // same cache as the app
const NARRATIONS = [
  "audios/es/misiones/cienaga_negra/a01.mp3",
  "audios/es/misiones/cienaga_negra/a05.mp3",
  "audios/es/misiones/morrowind/a12.mp3",
];

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const statusEl = $("status");

let music = null;
let gain = null;
let musicListeners = null;
let backend = "graph";
let volume = 1;
let narrationRequested = false;
let expectedEndAt = 0;
let cycleTimer = 0;
let cyclesLeft = 0;
let lastBeat = null;

const narration = new Audio();
narration.preload = "auto";

// ── Log ───────────────────────────────────────────────────
const entries = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
})();

const r2 = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

function snapshot() {
  return {
    vis: document.visibilityState,
    ctx: gain ? gain.contextState : null,
    gain: gain ? r2(gain.currentValue()) : null,
    session: navigator.audioSession ? `${navigator.audioSession.type}/${navigator.audioSession.state ?? "?"}` : null,
    music: music ? { paused: music.paused, t: r2(music.currentTime), muted: music.muted } : null,
    nar: { paused: narration.paused, t: r2(narration.currentTime), requested: narrationRequested },
  };
}

function log(event, details) {
  const entry = { at: new Date().toISOString(), ev: event, ...details, ...snapshot() };
  entries.push(entry);
  if (entries.length > LOG_LIMIT) entries.splice(0, entries.length - LOG_LIMIT);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(entries)); } catch {}
  const line = document.createElement("div");
  line.textContent = `${entry.at.slice(11, 23)} ${event}${details ? ` ${JSON.stringify(details)}` : ""}`;
  logEl.prepend(line);
  while (logEl.childElementCount > 300) logEl.lastChild.remove();
  renderStatus();
}

function renderStatus() {
  statusEl.textContent = JSON.stringify(snapshot(), null, 1);
}

for (const entry of entries.slice(-100)) {
  const line = document.createElement("div");
  line.textContent = `${entry.at.slice(11, 23)} ${entry.ev} (saved)`;
  logEl.prepend(line);
}

// ── Music ─────────────────────────────────────────────────
function networkSource() {
  const remote = SOUNDTRACK[0]?.src ?? "";
  return import.meta.env.DEV ? `/r2-dev${new URL(remote).pathname}` : remote;
}

async function cachedSource() {
  const url = networkSource();
  if (typeof caches === "undefined") return url;
  try {
    const cached = await (await caches.open(ST_CACHE_NAME)).match(url);
    if (cached) return URL.createObjectURL(await cached.blob());
    log("music:cache-miss", { url });
  } catch (err) {
    log("music:cache-error", { message: String(err) });
  }
  return url;
}

function teardownMusic() {
  if (!music) return;
  musicListeners.abort();
  music.pause();
  music.removeAttribute("src");
  music.load();
  gain?.dispose();
  music = null;
  gain = null;
  log("music:teardown");
}

async function startMusic() {
  teardownMusic();
  backend = $("backend").value;
  const sessionApplied = $("session").checked ? setAudioSessionType("playback") : setAudioSessionType("auto");
  log("session:set", { requested: $("session").checked ? "playback" : "auto", applied: sessionApplied });

  const el = new Audio();
  el.preload = "auto";
  musicListeners = new AbortController();
  for (const type of ["play", "playing", "pause", "waiting", "stalled", "ended", "error", "emptied", "suspend"]) {
    el.addEventListener(type, () => log(`music:${type}`, type === "error" ? { code: el.error?.code } : undefined), { signal: musicListeners.signal });
  }
  if (backend === "graph") {
    el.crossOrigin = "anonymous";
    el.volume = 1;
    gain = createSoundtrackGain({
      mediaElement: el,
      createContext: () => new (getAudioContextClass(window))(),
      volume,
      ducked: narrationRequested,
      onStateChange: (state) => log("ctx:state", { state }),
    });
    gain.ensure();
    gain.resume().then((running) => log("ctx:resume", { running }));
  } else {
    el.muted = narrationRequested;
  }
  music = el;

  // Network: no await, so play() stays inside the tap. Cache: needs an await
  // (like the app's cached path); a rejected play is logged.
  const src = $("source").value === "cache" ? await cachedSource() : networkSource();
  if (el !== music) return;
  el.src = src;
  el.play().then(
    () => log("music:play-ok", { backend }),
    (err) => log("music:play-rejected", { name: err?.name, message: err?.message })
  );
}

function setDucked(ducked, reason) {
  const at = performance.now();
  if (gain) gain.setDucked(ducked);
  else if (music) music.muted = ducked;
  log(ducked ? "duck" : "restore", { reason, target: gain ? r2(gain.target) : null });
  if (!ducked) {
    // How late the restoration actually lands (timers are throttled when
    // locked, so the observed delay is logged too).
    setTimeout(() => log("restore:check", {
      afterMs: Math.round(performance.now() - at),
      expected: gain ? r2(volume) : "unmuted",
      actual: gain ? r2(gain.currentValue()) : music ? (music.muted ? "muted" : "unmuted") : null,
    }), 1000);
  }
}

// ── Narration ─────────────────────────────────────────────
function playNarration(reason) {
  narrationRequested = true;
  narration.playbackRate = Number($("rate").value) || 1;
  // Ducks concurrently with play(), not before it.
  setDucked(true, reason);
  if (gain && gain.contextState !== "running") gain.resume().then((running) => log("ctx:resume", { running, reason }));
  narration.play().then(
    () => log("nar:play-ok", { reason }),
    (err) => {
      log("nar:play-rejected", { reason, name: err?.name, message: err?.message });
      if (err?.name === "AbortError") return;
      narrationRequested = false;
      setDucked(false, "play-rejected");
    }
  );
}

function stopNarration(reason, { rewind = true } = {}) {
  const wasRequested = narrationRequested;
  narrationRequested = false;
  narration.pause();
  if (rewind) narration.currentTime = 0;
  if (wasRequested) setDucked(false, reason);
}

function updateExpectedEnd() {
  const remaining = (narration.duration - narration.currentTime) / (narration.playbackRate || 1);
  expectedEndAt = Number.isFinite(remaining) ? performance.now() + remaining * 1000 : 0;
}

for (const type of ["play", "playing", "pause", "waiting", "stalled", "seeking", "seeked", "ended", "error", "ratechange"]) {
  narration.addEventListener(type, () => log(`nar:${type}`, type === "error" ? { code: narration.error?.code } : undefined));
}
narration.addEventListener("playing", updateExpectedEnd);
narration.addEventListener("ratechange", updateExpectedEnd);
narration.addEventListener("seeked", updateExpectedEnd);
narration.addEventListener("ended", () => {
  // Latency between the expected end and the `ended` delivery, which is what
  // the "music back within 1 s" acceptance criterion depends on.
  log("nar:ended-latency", { lateMs: expectedEndAt ? Math.round(performance.now() - expectedEndAt) : null });
  if (!narrationRequested) return;
  narrationRequested = false;
  setDucked(false, "ended");
  scheduleNextCycle();
});
narration.addEventListener("error", () => {
  if (!narrationRequested) return;
  narrationRequested = false;
  setDucked(false, "error");
});

function loadNarration() {
  narration.src = `${BASE}${$("narration").value}`;
  narration.load();
}

// ── Repeated cycles (for the locked-screen test) ──────────
function scheduleNextCycle() {
  if (cyclesLeft <= 0) return;
  const gapMs = Number($("gap").value) * 1000;
  cycleTimer = setTimeout(() => {
    cycleTimer = 0;
    if (cyclesLeft <= 0) return;
    cyclesLeft--;
    log("cycle:start", { left: cyclesLeft });
    narration.currentTime = 0;
    playNarration("cycle");
  }, gapMs);
}

function startCycles() {
  clearTimeout(cycleTimer);
  cyclesLeft = 9;
  log("cycle:start", { left: cyclesLeft, first: true });
  narration.currentTime = 0;
  playNarration("cycle"); // the first one starts from the tap
}

// ── Heartbeat: detects silent stalls of the music ─────────
setInterval(() => {
  const now = performance.now();
  const t = music?.currentTime ?? null;
  if (lastBeat && music && !music.paused) {
    const wall = (now - lastBeat.at) / 1000;
    const advanced = t - lastBeat.t;
    if (wall > 0 && Math.abs(advanced - wall) > 2) log("music:drift", { wall: r2(wall), advanced: r2(advanced) });
  }
  lastBeat = { at: now, t };
  if (!document.hidden) renderStatus();
}, 10000);

// ── Wiring ────────────────────────────────────────────────
for (const path of NARRATIONS) {
  const option = document.createElement("option");
  option.value = path;
  option.textContent = path.split("/").slice(-2).join("/");
  $("narration").append(option);
}
loadNarration();

$("music-start").addEventListener("click", startMusic);
$("music-pause").addEventListener("click", () => {
  if (!music) return;
  if (music.paused) {
    gain?.resume().then((running) => log("ctx:resume", { running, reason: "music-play" }));
    music.play().catch((err) => log("music:play-rejected", { name: err?.name }));
  } else {
    music.pause();
  }
});
$("music-stop").addEventListener("click", teardownMusic);
$("volume").addEventListener("input", (event) => {
  volume = Number(event.target.value) / 100;
  if (gain) gain.setVolume(volume);
  else if (music) music.volume = volume;
});
$("narration").addEventListener("change", () => { stopNarration("change"); loadNarration(); });
$("rate").addEventListener("change", () => { narration.playbackRate = Number($("rate").value) || 1; });
$("nar-play").addEventListener("click", () => { cyclesLeft = 0; playNarration("tap"); });
$("nar-pause").addEventListener("click", () => { cyclesLeft = 0; stopNarration("pause", { rewind: false }); });
$("nar-stop").addEventListener("click", () => { cyclesLeft = 0; clearTimeout(cycleTimer); stopNarration("stop"); });
$("nar-seek").addEventListener("click", () => {
  // Seeking keeps the ducking while the narration remains requested.
  narration.currentTime = Math.min((narration.duration || 0) - 0.5, narration.currentTime + 10);
});
$("cycles").addEventListener("click", startCycles);
$("copy").addEventListener("click", async () => {
  const report = JSON.stringify({ userAgent: navigator.userAgent, standalone: navigator.standalone === true, duckRatio: DUCK_RATIO, entries }, null, 1);
  try {
    await navigator.clipboard.writeText(report);
    log("log:copied");
    return;
  } catch {}
  // Clipboard API requires HTTPS; fall back to downloading the log on LAN HTTP.
  const url = URL.createObjectURL(new Blob([report], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `ios-audio-repro-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  log("log:downloaded");
});
$("clear").addEventListener("click", () => {
  entries.length = 0;
  localStorage.removeItem(LOG_KEY);
  logEl.textContent = "";
  renderStatus();
});

if (navigator.audioSession) {
  navigator.audioSession.addEventListener?.("statechange", () => log("session:statechange"));
}
document.addEventListener("visibilitychange", () => log(`page:${document.visibilityState}`));
window.addEventListener("pagehide", () => log("page:pagehide"));
window.addEventListener("pageshow", (event) => log("page:pageshow", { persisted: event.persisted }));

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => { log("ms:play"); music?.play().catch(() => {}); });
  navigator.mediaSession.setActionHandler("pause", () => { log("ms:pause"); music?.pause(); });
}

log("repro:loaded", { userAgent: navigator.userAgent });
