// Minimal Web Audio fakes: enough surface for the gain controller, with a
// manually driven clock and a record of every AudioParam automation call.

export class FakeParam {
  constructor(value = 1) {
    this.value = value;
    this.calls = [];
  }
  setValueAtTime(value, time) {
    this.calls.push(["set", value, time]);
    this.value = value;
  }
  linearRampToValueAtTime(value, time) {
    this.calls.push(["ramp", value, time]);
  }
  cancelScheduledValues(time) {
    this.calls.push(["cancel", time]);
  }
  lastRamp() {
    return [...this.calls].reverse().find((c) => c[0] === "ramp") ?? null;
  }
}

class FakeNode {
  constructor(ctx) {
    this.ctx = ctx;
    this.outputs = [];
  }
  connect(node) {
    this.outputs.push(node);
    return node;
  }
}

export class FakeAudioContext {
  constructor({ state = "running", resumeResult = "running", resumeRejects = false } = {}) {
    this.state = state;
    this.currentTime = 0;
    this.destination = new FakeNode(this);
    this.resumeResult = resumeResult;
    this.resumeRejects = resumeRejects;
    this.resumeCalls = 0;
    this.gains = [];
  }
  createMediaElementSource(el) {
    const node = new FakeNode(this);
    node.mediaElement = el;
    this.source = node;
    return node;
  }
  createGain() {
    const node = new FakeNode(this);
    node.gain = new FakeParam(1);
    this.gains.push(node);
    return node;
  }
  async resume() {
    this.resumeCalls += 1;
    if (this.resumeRejects) throw new Error("NotAllowedError");
    this.state = this.resumeResult;
  }
  advance(seconds) {
    this.currentTime += seconds;
  }
}

export function fakeMediaElement() {
  return { paused: true, currentTime: 0, volume: 1, muted: false };
}
