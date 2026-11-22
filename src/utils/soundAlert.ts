/**
 * Reliable restaurant kitchen order bell chime.
 * Uses a persistent singleton Web Audio API AudioContext unlocked on the first user
 * interaction, with an auto-generated PCM WAV <audio> fallback so incoming waiter KOTs
 * chime reliably across Chrome, Edge, Safari, and desktop PWAs.
 */

let sharedAudioCtx: AudioContext | null = null;
let cachedBellWavUrl: string | null = null;
let unlockListenersAttached = false;

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  );
}

function getOrCreateAudioContext(): AudioContext | null {
  if (sharedAudioCtx && sharedAudioCtx.state !== 'closed') {
    return sharedAudioCtx;
  }
  const AudioCtx = getAudioContextConstructor();
  if (!AudioCtx) return null;
  try {
    sharedAudioCtx = new AudioCtx();
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

/**
 * Generates a tiny in-memory 16-bit PCM WAV data URL for a crisp two-tone kitchen bell.
 * Used as a fallback whenever Web Audio API cannot resume or is unavailable.
 */
function getBellWavDataUrl(): string | null {
  if (cachedBellWavUrl) return cachedBellWavUrl;
  if (typeof window === 'undefined' || typeof btoa === 'undefined') return null;
  try {
    const sampleRate = 22050;
    const durationSec = 0.85;
    const numSamples = Math.floor(sampleRate * durationSec);
    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      let sample = 0;

      // Ding 1: A5 (880Hz) + bright overtone (1760Hz) from 0.00s to 0.45s
      if (t >= 0 && t < 0.45) {
        const env1 = Math.min(1, t / 0.008) * Math.exp(-t * 8.5);
        sample +=
          env1 *
          (0.62 * Math.sin(2 * Math.PI * 880 * t) + 0.25 * Math.sin(2 * Math.PI * 1760 * t));
      }

      // Ding 2: D6 (1174.66Hz) + bright overtone (2349.32Hz) from 0.18s to 0.85s
      if (t >= 0.18) {
        const dt = t - 0.18;
        const env2 = Math.min(1, dt / 0.008) * Math.exp(-dt * 6.0);
        sample +=
          env2 *
          (0.68 * Math.sin(2 * Math.PI * 1174.66 * dt) +
            0.26 * Math.sin(2 * Math.PI * 2349.32 * dt));
      }

      const clamped = Math.max(-1, Math.min(1, sample * 0.85));
      view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
    }

    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    cachedBellWavUrl = `data:audio/wav;base64,${btoa(binary)}`;
    return cachedBellWavUrl;
  } catch {
    return null;
  }
}

/**
 * Unlocks the shared AudioContext on the first user click/tap/keypress so future
 * real-time Firestore order arrivals can play the bell without autoplay blocking.
 */
export function initKitchenAudioUnlock(): void {
  if (typeof window === 'undefined' || unlockListenersAttached) return;
  unlockListenersAttached = true;

  const unlock = () => {
    const ctx = getOrCreateAudioContext();
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
  };

  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('touchstart', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
}

function scheduleBellOnContext(ctx: AudioContext): void {
  const now = ctx.currentTime + 0.015;

  const strike = (
    fundamental: number,
    overtone: number,
    startOffset: number,
    duration: number,
    peakGain: number
  ) => {
    // Fundamental tone
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(fundamental, now + startOffset);
    gain1.gain.setValueAtTime(0.0001, now + startOffset);
    gain1.gain.linearRampToValueAtTime(peakGain, now + startOffset + 0.012);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now + startOffset);
    osc1.stop(now + startOffset + duration + 0.03);

    // Metallic bell overtone
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(overtone, now + startOffset);
    gain2.gain.setValueAtTime(0.0001, now + startOffset);
    gain2.gain.linearRampToValueAtTime(peakGain * 0.42, now + startOffset + 0.01);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration * 0.72);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + startOffset);
    osc2.stop(now + startOffset + duration + 0.03);
  };

  // Loud, clear two-tone restaurant kitchen bell (A5 -> D6)
  strike(880, 1760, 0, 0.36, 0.55);
  strike(1174.66, 2349.32, 0.18, 0.58, 0.62);
}

async function playFallbackAudioElement(): Promise<boolean> {
  const wavUrl = getBellWavDataUrl();
  if (!wavUrl) return false;
  try {
    const audio = new Audio(wavUrl);
    audio.volume = 1.0;
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

/**
 * Plays a loud, unmistakable two-tone restaurant kitchen bell chime.
 * Returns true if audio playback succeeded, or false if blocked by browser policy.
 */
export async function playKitchenBellChime(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  try {
    const ctx = getOrCreateAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      if (ctx.state === 'running') {
        scheduleBellOnContext(ctx);
        return true;
      }
    }
  } catch {
    // Fall through to HTMLAudioElement fallback
  }

  return playFallbackAudioElement();
}
