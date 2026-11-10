// A soft pen-on-paper sound while typing and drawing, made with WebAudio
// (filtered noise), so no sound files ship with the plugin.

export type PenSoundKind = "off" | "pencil" | "fountain";

export class PenSound {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private last = 0;

  private setup() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    const len = Math.floor(ctx.sampleRate * 0.4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.ctx = ctx;
    this.noise = buf;
    return ctx;
  }

  /** One short stroke: a letter typed, or a bit of a line drawn. */
  stroke(kind: PenSoundKind, volume: number, length = 1) {
    if (kind === "off" || volume <= 0) return;
    const now = performance.now();
    // Fast typing: not more than one sound every 25 ms.
    if (now - this.last < 25) return;
    this.last = now;
    try {
      const ctx = this.setup();
      if (ctx.state === "suspended") void ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      const pencil = kind === "pencil";
      band.frequency.value = (pencil ? 3800 : 1900) * (0.8 + Math.random() * 0.4);
      band.Q.value = pencil ? 0.9 : 1.6;
      const gain = ctx.createGain();
      const t = ctx.currentTime;
      const dur = (pencil ? 0.045 : 0.06) * Math.min(3, Math.max(0.6, length));
      const peak = volume * (pencil ? 0.22 : 0.14);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(band).connect(gain).connect(ctx.destination);
      src.start(t, Math.random() * 0.3, dur + 0.02);
    } catch {
      /* no audio device: stay quiet */
    }
  }

  close() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
