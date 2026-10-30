import { deflateSync } from 'node:zlib';

/** Imagens mínimas, geradas aqui mesmo, para testar detecção, dimensões e limpeza de metadados. */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer) {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** PNG válido (decodificável) w×h, com um bloco de texto opcional (metadado a remover). */
export function png(w: number, h: number, text?: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // profundidade
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(text ? [chunk('tEXt', Buffer.from(`Comment\0${text}`, 'latin1'))] : []),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * JPEG estrutural (segmentos corretos, sem imagem decodificável): APP0 JFIF, APP1 EXIF com
 * orientação e um texto "GPS" falso, COM (comentário), SOF0 com as dimensões, SOS e EOI.
 */
export function jpeg(w: number, h: number, opts: { orientation?: number; secret?: string } = {}): Buffer {
  const seg = (marker: number, data: Buffer) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([head, data]);
  };
  const app0 = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, opts.orientation ?? 1, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const app1 = seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, Buffer.from(opts.secret ?? '', 'latin1')]));
  const com = seg(0xfe, Buffer.from(`autor: ${opts.secret ?? ''}`, 'latin1'));
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  const sos = Buffer.from([0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0, 0x12, 0x34, 0x56]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, com, sof, sos, Buffer.from([0xff, 0xd9])]);
}

/** WebP VP8X com bloco EXIF (só estrutura). */
export function webpWithExif(w: number, h: number, secret: string): Buffer {
  const chunkW = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08; // tem EXIF
  vp8x.writeUIntLE(w - 1, 4, 3);
  vp8x.writeUIntLE(h - 1, 7, 3);
  const body = Buffer.concat([chunkW('VP8X', vp8x), chunkW('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])), chunkW('EXIF', Buffer.from(secret, 'latin1'))]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
