/**
 * Plays a pleasant two-tone kitchen order bell chime using Web Audio API.
 * Safe no-op if audio is blocked by browser autoplay policy before first user gesture.
 */
export function playKitchenBellChime(): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const playTone = (freq: number, startOffset: number, duration: number, peakGain: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + startOffset);

      gain.gain.setValueAtTime(0.0001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(peakGain, now + startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration + 0.02);
    };

    // Crisp two-tone restaurant counter bell (A5 -> D6)
    playTone(880, 0, 0.22, 0.22);
    playTone(1174.66, 0.16, 0.34, 0.24);

    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 700);
  } catch {
    // Ignore audio errors in restricted environments
  }
}
