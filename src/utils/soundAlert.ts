/**
 * Reliable restaurant order & bill-cleared bell chimes.
 * Uses a persistent singleton Web Audio API AudioContext unlocked on the first user
 * interaction, with auto-generated PCM WAV <audio> fallbacks so incoming waiter KOTs
 * and waiter-cleared table bills chime reliably across Chrome, Edge, Safari, and PWAs.
 */

let sharedAudioCtx: AudioContext | null = null;
let cachedKotWavUrl: string | null = null;
let cachedBillWavUrl: string | null = null;
let cachedReadyWavUrl: string | null = null;
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

interface ChimeNote {
  freq: number;
  overtone: number;
  startSec: number;
  durationSec: number;
  decayRate: number;
  gain: number;
}

const KOT_CHIME_NOTES: ChimeNote[] = [
  { freq: 880, overtone: 1760, startSec: 0, durationSec: 0.45, decayRate: 8.5, gain: 0.58 },
  { freq: 1174.66, overtone: 2349.32, startSec: 0.18, durationSec: 0.65, decayRate: 6.0, gain: 0.64 },
];

// Bright ascending 3-note cash register chime (C6 -> E6 -> G6) for Bill Cleared alerts
const BILL_CHIME_NOTES: ChimeNote[] = [
  { freq: 1046.5, overtone: 2093.0, startSec: 0, durationSec: 0.35, decayRate: 9.0, gain: 0.52 },
  { freq: 1318.51, overtone: 2637.02, startSec: 0.14, durationSec: 0.38, decayRate: 8.5, gain: 0.56 },
  { freq: 1567.98, overtone: 3135.96, startSec: 0.28, durationSec: 0.65, decayRate: 5.5, gain: 0.64 },
];

// Crisp 2-tone kitchen pickup bell (E6 -> A6) for Waiter Order Ready alerts
const READY_CHIME_NOTES: ChimeNote[] = [
  { freq: 1318.51, overtone: 2637.02, startSec: 0, durationSec: 0.32, decayRate: 8.5, gain: 0.56 },
  { freq: 1760.0, overtone: 3520.0, startSec: 0.16, durationSec: 0.65, decayRate: 5.5, gain: 0.66 },
];

function buildWavDataUrl(notes: ChimeNote[], totalDurationSec: number): string | null {
  if (typeof window === 'undefined' || typeof btoa === 'undefined') return null;
  try {
    const sampleRate = 22050;
    const numSamples = Math.floor(sampleRate * totalDurationSec);
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

      for (const note of notes) {
        if (t >= note.startSec && t < note.startSec + note.durationSec) {
          const dt = t - note.startSec;
          const env = Math.min(1, dt / 0.008) * Math.exp(-dt * note.decayRate);
          sample +=
            env *
            note.gain *
            (0.75 * Math.sin(2 * Math.PI * note.freq * dt) +
              0.25 * Math.sin(2 * Math.PI * note.overtone * dt));
        }
      }

      const clamped = Math.max(-1, Math.min(1, sample * 0.9));
      view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
    }

    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:audio/wav;base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

/**
 * Unlocks the shared AudioContext on the first user click/tap/keypress so future
 * real-time Firestore order and bill arrivals can chime without autoplay blocking.
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

function scheduleNotesOnContext(ctx: AudioContext, notes: ChimeNote[]): void {
  const now = ctx.currentTime + 0.015;

  for (const note of notes) {
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(note.freq, now + note.startSec);
    gain1.gain.setValueAtTime(0.0001, now + note.startSec);
    gain1.gain.linearRampToValueAtTime(note.gain, now + note.startSec + 0.012);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + note.startSec + note.durationSec);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now + note.startSec);
    osc1.stop(now + note.startSec + note.durationSec + 0.03);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(note.overtone, now + note.startSec);
    gain2.gain.setValueAtTime(0.0001, now + note.startSec);
    gain2.gain.linearRampToValueAtTime(note.gain * 0.42, now + note.startSec + 0.01);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + note.startSec + note.durationSec * 0.72);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + note.startSec);
    osc2.stop(now + note.startSec + note.durationSec + 0.03);
  }
}

async function playChime(notes: ChimeNote[], getWavUrl: () => string | null): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  try {
    const ctx = getOrCreateAudioContext();
    if (ctx) {
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      if (ctx.state === 'running') {
        scheduleNotesOnContext(ctx, notes);
        return true;
      }
    }
  } catch {
    // Fall through to HTMLAudioElement fallback
  }

  const wavUrl = getWavUrl();
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
 * Plays a loud, unmistakable two-tone restaurant kitchen bell chime (A5 -> D6) for incoming KOTs.
 */
export async function playKitchenBellChime(): Promise<boolean> {
  return playChime(KOT_CHIME_NOTES, () => {
    if (!cachedKotWavUrl) {
      cachedKotWavUrl = buildWavDataUrl(KOT_CHIME_NOTES, 0.85);
    }
    return cachedKotWavUrl;
  });
}

/**
 * Plays a distinct bright three-tone cash register chime (C6 -> E6 -> G6) when a waiter clears a table bill.
 */
export async function playBillClearedChime(): Promise<boolean> {
  return playChime(BILL_CHIME_NOTES, () => {
    if (!cachedBillWavUrl) {
      cachedBillWavUrl = buildWavDataUrl(BILL_CHIME_NOTES, 0.96);
    }
    return cachedBillWavUrl;
  });
}

/**
 * Plays a crisp service pickup chime (E6 -> A6) when Kitchen marks an order Ready for the waiter.
 */
export async function playOrderReadyChime(): Promise<boolean> {
  return playChime(READY_CHIME_NOTES, () => {
    if (!cachedReadyWavUrl) {
      cachedReadyWavUrl = buildWavDataUrl(READY_CHIME_NOTES, 0.88);
    }
    return cachedReadyWavUrl;
  });
}

/**
 * Vibrates supported mobile devices briefly when a kitchen order becomes Ready.
 */
export function triggerReadyVibration(): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([180, 80, 180]);
    } catch {
      // Ignore vibration permission/hardware errors
    }
  }
}
