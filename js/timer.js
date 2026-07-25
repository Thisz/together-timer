class TogetherTimer {
  constructor(onTick, onStateChange) {
    this.onTick = onTick;
    this.onStateChange = onStateChange;
    this.originalDuration = 0;
    this.remaining = 0;
    this.endAt = null;
    this.running = false;
    this.intervalId = null;
  }

  setDuration(milliseconds) {
    const value = Math.max(0, Math.floor(milliseconds));
    this.stopInterval();
    this.originalDuration = value;
    this.remaining = value;
    this.endAt = null;
    this.running = false;
    this.emit();
  }

  start() {
    if (this.running || this.remaining <= 0) return;
    this.endAt = Date.now() + this.remaining;
    this.running = true;
    this.intervalId = window.setInterval(() => this.tick(), 200);
    this.tick();
    this.emitState();
  }

  pause() {
    if (!this.running) return;
    this.remaining = Math.max(0, this.endAt - Date.now());
    this.stopInterval();
    this.running = false;
    this.endAt = null;
    this.emit();
  }

  restart() {
    const wasRunning = this.running;
    this.stopInterval();
    this.running = false;
    this.endAt = null;
    this.remaining = this.originalDuration;
    this.emit();
    if (wasRunning && this.remaining > 0) this.start();
  }

  adjust(milliseconds) {
    if (this.running) {
      this.endAt += milliseconds;
      this.remaining = Math.max(0, this.endAt - Date.now());
      if (this.remaining <= 0) this.finish();
    } else {
      this.remaining = Math.max(0, this.remaining + milliseconds);
    }
    this.originalDuration = Math.max(this.originalDuration + milliseconds, 0);
    this.emit();
  }

  load({ originalDuration, remaining, running, endAt }) {
    this.stopInterval();
    this.originalDuration = Math.max(0, Number(originalDuration) || 0);
    this.remaining = Math.max(0, Number(remaining) || 0);
    this.running = Boolean(running);
    this.endAt = Number(endAt) || null;
    if (this.running && this.endAt) {
      this.remaining = Math.max(0, this.endAt - Date.now());
      if (this.remaining > 0) {
        this.intervalId = window.setInterval(() => this.tick(), 200);
      } else {
        this.running = false;
        this.endAt = null;
      }
    }
    this.emit();
  }

  snapshot() {
    return {
      originalDuration: this.originalDuration,
      remaining: this.running ? Math.max(0, this.endAt - Date.now()) : this.remaining,
      running: this.running,
      endAt: this.running ? this.endAt : null
    };
  }

  tick() {
    if (!this.running) return;
    this.remaining = Math.max(0, this.endAt - Date.now());
    if (this.remaining <= 0) {
      this.finish();
      return;
    }
    this.emitTick();
  }

  finish() {
    this.stopInterval();
    this.running = false;
    this.endAt = null;
    this.remaining = 0;
    this.emit();
  }

  stopInterval() {
    if (this.intervalId) window.clearInterval(this.intervalId);
    this.intervalId = null;
  }

  emitTick() {
    if (typeof this.onTick === 'function') this.onTick(this.snapshot());
  }

  emitState() {
    if (typeof this.onStateChange === 'function') this.onStateChange(this.snapshot());
  }

  emit() {
    this.emitTick();
    this.emitState();
  }
}

window.TogetherTimer = TogetherTimer;
