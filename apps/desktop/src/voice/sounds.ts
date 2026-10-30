/**
 * Sons curtos gerados na hora (sem arquivos): entrar/sair da sala e toque de chamada.
 * Volume baixo e duração curta, para não incomodar.
 */
let ctx: AudioContext | null = null;
const audio = () => (ctx ??= new AudioContext());

function tone(freqs: number[], durMs: number, gap = 0, volume = 0.06) {
  const c = audio();
  void c.resume();
  let t = c.currentTime;
  for (const f of freqs) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(volume, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
    osc.connect(g).connect(c.destination);
    osc.start(t);
    osc.stop(t + durMs / 1000 + 0.02);
    t += (durMs + gap) / 1000;
  }
}

export const playJoin = () => tone([660, 880], 90, 10);
export const playLeave = () => tone([660, 440], 90, 10);
export const playMute = () => tone([420], 60);
export const playUnmute = () => tone([620], 60);
/** Aviso de mensagem: dois toques curtos e suaves. */
export const playMessage = () => tone([880, 1175], 70, 30, 0.04);

/** Toque repetido até ser parado. */
export function startRingtone(): () => void {
  const ring = () => tone([740, 988, 740, 988], 120, 40, 0.05);
  ring();
  const t = setInterval(ring, 2000);
  return () => clearInterval(t);
}
