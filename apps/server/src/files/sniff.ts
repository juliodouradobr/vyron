/**
 * Tipo real de um arquivo pelos primeiros bytes (nunca pela extensão nem pelo que o cliente diz),
 * dimensões de imagens e remoção de metadados (EXIF/GPS, XMP, comentários).
 *
 * SVG e HTML nunca são tratados como imagem/página: viram texto para download. Assim nada que chega
 * de um usuário é interpretado como código no navegador de outro.
 */

export interface Sniffed {
  mime: string;
  /** Imagem que exibimos inline (PNG, JPEG, GIF, WebP). */
  image: boolean;
  /** Áudio/vídeo reproduzível no player do app. */
  media: boolean;
}

const startsWith = (b: Buffer, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (b: Buffer, at: number, len: number) => b.subarray(at, at + len).toString('latin1');

export function sniff(b: Buffer): Sniffed {
  const img = (mime: string): Sniffed => ({ mime, image: true, media: false });
  const media = (mime: string): Sniffed => ({ mime, image: false, media: true });
  const other = (mime: string): Sniffed => ({ mime, image: false, media: false });

  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return img('image/png');
  if (startsWith(b, [0xff, 0xd8, 0xff])) return img('image/jpeg');
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return img('image/gif');
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return img('image/webp');
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return media('audio/wav');
  if (ascii(b, 4, 4) === 'ftyp') return media('video/mp4');
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return media('video/webm');
  if (ascii(b, 0, 4) === 'OggS') return media('audio/ogg');
  if (ascii(b, 0, 4) === 'fLaC') return media('audio/flac');
  if (ascii(b, 0, 3) === 'ID3' || (b.length > 1 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return media('audio/mpeg');
  if (ascii(b, 0, 5) === '%PDF-') return other('application/pdf');
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return other('application/zip');
  if (looksLikeText(b)) return other('text/plain; charset=utf-8');
  return other('application/octet-stream');
}

function looksLikeText(b: Buffer): boolean {
  const head = b.subarray(0, 64 * 1024);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.length === b.length ? head : trimPartialUtf8(head));
    return true;
  } catch {
    return false;
  }
}

/** Não reprovar texto só porque o corte de 64 KB caiu no meio de um caractere multibyte. */
function trimPartialUtf8(b: Buffer): Buffer {
  let end = b.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const c = b[end - i]!;
    if ((c & 0xc0) === 0x80) continue;
    if (c >= 0xc0) end -= i;
    break;
  }
  return b.subarray(0, end);
}

/* ---------------- dimensões ---------------- */

export function imageSize(b: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
    if (mime === 'image/gif') return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : null;
    if (mime === 'image/jpeg') return jpegSize(b);
    if (mime === 'image/webp') return webpSize(b);
  } catch {
    return null;
  }
  return null;
}

function jpegSize(b: Buffer) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer) {
  const type = ascii(b, 12, 4);
  if (type === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (type === 'VP8L' && b.length >= 25) {
    const v = b.readUInt32LE(21);
    return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
  }
  if (type === 'VP8X' && b.length >= 30) return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

/* ---------------- metadados ---------------- */

/**
 * Remove metadados que podem expor a pessoa (localização GPS, modelo do aparelho, data, autor,
 * comentários). Devolve null se a imagem estiver malformada — nesse caso o envio é recusado.
 * GIF não carrega EXIF; é mantido como está.
 */
export function stripMetadata(b: Buffer, mime: string): Buffer | null {
  try {
    if (mime === 'image/jpeg') return stripJpeg(b);
    if (mime === 'image/png') return stripPng(b);
    if (mime === 'image/webp') return stripWebp(b);
    if (mime === 'image/gif') return b;
  } catch {
    return null;
  }
  return null;
}

/** Orientação EXIF (1–8) de um segmento APP1, ou 1. */
function exifOrientation(seg: Buffer): number {
  // seg = dados do APP1 (sem o marcador e o tamanho)
  if (ascii(seg, 0, 6) !== 'Exif\0\0') return 1;
  const t = seg.subarray(6);
  const le = ascii(t, 0, 2) === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** APP1 mínimo com só a orientação: a foto continua aparecendo na posição certa, sem o resto. */
function orientationApp1(o: number): Buffer {
  const body = Buffer.from([
    ...Buffer.from('Exif\0\0', 'latin1'),
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // TIFF big-endian, IFD0 em 8
    0x00, 0x01, // 1 entrada
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, o, 0x00, 0x00, // Orientation SHORT = o
    0x00, 0x00, 0x00, 0x00, // sem próximo IFD
  ]);
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = 0xe1;
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)]; // SOI
  let i = 2;
  let orientation = 1;
  let insertAt = 1; // depois do SOI (ou do APP0/JFIF, se houver)
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error('JPEG malformado');
    const m = b[i + 1]!;
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xda) {
      out.push(b.subarray(i)); // início dos dados da imagem: copia o resto inteiro
      break;
    }
    if (m === 0xd9) {
      out.push(b.subarray(i, i + 2));
      break;
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) throw new Error('JPEG malformado');
    const seg = b.subarray(i, i + 2 + len);
    if (m === 0xe1) orientation = Math.max(orientation, safeOrientation(seg.subarray(4)));
    // APP1 (EXIF/XMP), APP13 (IPTC/Photoshop) e COM (comentário) saem; o resto (JFIF, ICC, tabelas) fica.
    if (m !== 0xe1 && m !== 0xed && m !== 0xfe) {
      out.push(seg);
      if (m === 0xe0 && out.length === 2) insertAt = 2;
    }
    i += 2 + len;
  }
  if (orientation !== 1) out.splice(insertAt, 0, orientationApp1(orientation));
  return Buffer.concat(out);
}

function safeOrientation(seg: Buffer): number {
  try {
    return exifOrientation(seg);
  } catch {
    return 1;
  }
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = ascii(b, i + 4, 4);
    const end = i + 12 + len;
    if (end > b.length) throw new Error('PNG malformado');
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

function stripWebp(b: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const len = b.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (i + 8 + len > b.length) throw new Error('WebP malformado');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const c = Buffer.from(b.subarray(i, Math.min(end, b.length)));
      // VP8X anuncia a presença de EXIF (bit 3) e XMP (bit 2): os bits saem junto com os blocos.
      if (type === 'VP8X') c[8] = c[8]! & ~0x0c;
      chunks.push(c);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** Nome de arquivo seguro para guardar e exibir (sem caminho, sem caracteres de controle). */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, 200);
  return clean && clean !== '.' && clean !== '..' ? clean : 'arquivo';
}
