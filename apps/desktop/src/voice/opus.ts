/**
 * Ajustes do Opus para voz, aplicados no SDP local (o fmtp diz ao outro lado como enviar para nós;
 * como todo cliente aplica o mesmo, a configuração vale nos dois sentidos):
 *  - useinbandfec=1: correção de erros embutida — perda de pacotes vira degradação suave, não cortes.
 *  - usedtx=1: transmissão descontínua — quase nada é enviado durante silêncio (economiza banda/CPU).
 *  - stereo=0 / sprop-stereo=0: voz é mono.
 *  - maxaveragebitrate: teto do codificador; 40 kbps já é fala "transparente" no Opus.
 */
export const OPUS_VOICE_PARAMS: Record<string, string> = {
  useinbandfec: '1',
  usedtx: '1',
  stereo: '0',
  'sprop-stereo': '0',
  maxaveragebitrate: '40000',
};

/**
 * Áudio da transmissão de tela (jogo, música, vídeo): estéreo, bitrate alto e sem DTX —
 * o DTX corta "silêncios" que em música são só passagens baixas.
 */
export const OPUS_MEDIA_PARAMS: Record<string, string> = {
  useinbandfec: '1',
  usedtx: '0',
  stereo: '1',
  'sprop-stereo': '1',
  maxaveragebitrate: '128000',
};

function tuneSection(section: string, params: Record<string, string>): string {
  const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(section)?.[1];
  if (!pt) return section;
  const lines = section.split('\r\n');
  const idx = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
  if (idx >= 0) {
    const current = Object.fromEntries(
      lines[idx]!
        .slice(`a=fmtp:${pt} `.length)
        .split(';')
        .filter(Boolean)
        .map((kv) => kv.split('=') as [string, string]),
    );
    lines[idx] = `a=fmtp:${pt} ${Object.entries({ ...current, ...params })
      .map(([k, v]) => `${k}=${v}`)
      .join(';')}`;
  } else {
    const rtpmap = lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
    lines.splice(rtpmap + 1, 0, `a=fmtp:${pt} ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(';')}`);
  }
  return lines.join('\r\n');
}

/**
 * A primeira seção de áudio é sempre o microfone (criado antes de qualquer transmissão);
 * as demais seções de áudio são da transmissão de tela.
 */
export function tuneOpus(sdp: string, voice: Record<string, string> = OPUS_VOICE_PARAMS, media: Record<string, string> = OPUS_MEDIA_PARAMS): string {
  const parts = sdp.split('\r\nm=');
  let audioIndex = 0;
  for (let i = 1; i < parts.length; i++) {
    if (!parts[i]!.startsWith('audio ')) continue;
    parts[i] = tuneSection(parts[i]!, audioIndex === 0 ? voice : media);
    audioIndex++;
  }
  // SDP sem seções m= (não deveria acontecer): mantém o comportamento antigo no texto inteiro.
  if (parts.length === 1) return tuneSection(sdp, voice);
  return parts.join('\r\nm=');
}
