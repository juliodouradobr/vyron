import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Permission as P, type Attachment, type Message, type ServerDetail } from '@nexo/protocol';
import { imageSize, safeFilename, sniff, stripMetadata } from '../src/files/sniff';
import { bearer, befriend, createTestApp, user, type TestUser } from './helpers';
import { jpeg, png, webpWithExif } from './images';

describe('detecção de tipo e metadados (puro)', () => {
  it('tipo vem do conteúdo, não do nome; SVG/HTML nunca viram imagem/página', () => {
    expect(sniff(png(2, 2))).toMatchObject({ mime: 'image/png', image: true });
    expect(sniff(jpeg(10, 10))).toMatchObject({ mime: 'image/jpeg', image: true });
    expect(sniff(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).toMatchObject({ mime: 'image/gif' });
    expect(sniff(webpWithExif(3, 4, 'x'))).toMatchObject({ mime: 'image/webp' });
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toMatchObject({ mime: 'text/plain; charset=utf-8', image: false });
    expect(sniff(Buffer.from('<html><script>x</script></html>')).mime).toBe('text/plain; charset=utf-8');
    expect(sniff(Buffer.from([0, 1, 2, 3, 0xfe, 0xff])).mime).toBe('application/octet-stream');
    expect(sniff(Buffer.from('%PDF-1.7')).mime).toBe('application/pdf');
  });

  it('lê as dimensões de PNG, JPEG e WebP', () => {
    expect(imageSize(png(7, 5), 'image/png')).toEqual({ width: 7, height: 5 });
    expect(imageSize(jpeg(640, 480), 'image/jpeg')).toEqual({ width: 640, height: 480 });
    expect(imageSize(webpWithExif(300, 200, 'x'), 'image/webp')).toEqual({ width: 300, height: 200 });
  });

  it('JPEG: remove EXIF (GPS, aparelho) e comentário, mas preserva a orientação', () => {
    const src = jpeg(640, 480, { orientation: 6, secret: 'GPS -23.55,-46.63 iPhone' });
    const out = stripMetadata(src, 'image/jpeg')!;
    expect(out.toString('latin1')).not.toContain('GPS');
    expect(out.toString('latin1')).not.toContain('iPhone');
    expect(out.toString('latin1')).toContain('JFIF');
    expect(imageSize(out, 'image/jpeg')).toEqual({ width: 640, height: 480 });
    // A orientação 6 (girar 90°) continua lá, num EXIF mínimo.
    const i = out.indexOf(Buffer.from([0x01, 0x12, 0x00, 0x03]));
    expect(i).toBeGreaterThan(0);
    expect(out[i + 9]).toBe(6);
    // Sem orientação especial, nenhum EXIF fica.
    expect(stripMetadata(jpeg(10, 10, { secret: 'x' }), 'image/jpeg')!.includes(Buffer.from('Exif'))).toBe(false);
  });

  it('PNG e WebP: blocos de texto/EXIF saem; a imagem continua válida', () => {
    const p = stripMetadata(png(4, 4, 'Local: casa da vó'), 'image/png')!;
    expect(p.toString('latin1')).not.toContain('casa');
    expect(p.toString('latin1')).toContain('IEND');
    const w = stripMetadata(webpWithExif(8, 8, 'GPS segredo'), 'image/webp')!;
    expect(w.toString('latin1')).not.toContain('segredo');
    expect(w[20]! & 0x08).toBe(0); // bit "tem EXIF" do VP8X desligado
    expect(w.readUInt32LE(4)).toBe(w.length - 8); // tamanho RIFF recalculado
  });

  it('JPEG malformado é recusado (não guardamos o que não sabemos ler)', () => {
    expect(stripMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2]), 'image/jpeg')).toBeNull();
  });

  it('nome de arquivo sem caminho nem caracteres de controle', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Windows\\foto.png')).toBe('foto.png');
    expect(safeFilename('a\u202egnp.exe')).toBe('agnp.exe');
    expect(safeFilename('..')).toBe('arquivo');
  });
});

let app: FastifyInstance;
beforeAll(async () => {
  app = await createTestApp({ files: { maxAttachmentBytes: 64 * 1024, maxImageBytes: 32 * 1024 } as never });
});
afterAll(async () => {
  await app.close();
});

const put = (u: TestUser, url: string, body: Buffer, method: 'POST' | 'PUT' = 'POST') =>
  app.inject({ method, url: `/api/v1${url}`, headers: { ...bearer(u.token), 'content-type': 'application/octet-stream' }, payload: body });
const getFile = (u: TestUser, id: string) => app.inject({ method: 'GET', url: `/api/v1/files/${id}`, headers: bearer(u.token) });

async function setup() {
  const owner = await user(app);
  const member = await user(app);
  const outsider = await user(app);
  const d = (await owner.post('/servers', { name: 'Arquivos' })).body as ServerDetail;
  await member.post(`/invites/${(await owner.post(`/servers/${d.server.id}/invites`, {})).body.code}`);
  const text = d.channels.find((c) => c.type === 'text')!;
  const everyone = d.roles.find((r) => r.isDefault)!;
  return { owner, member, outsider, d, text, everyone };
}

describe('anexos', () => {
  it('enviar, anexar à mensagem e baixar; quem não vê o canal não baixa (nem sabendo o id)', async () => {
    const { owner, member, outsider, text } = await setup();
    const up = await put(member, `/channels/${text.id}/attachments?filename=${encodeURIComponent('relatório.png')}`, Buffer.from('só texto, apesar do nome'));
    expect(up.statusCode).toBe(201);
    const att = up.json<Attachment>();
    expect(att).toMatchObject({ filename: 'relatório.png', contentType: 'text/plain; charset=utf-8', width: null });

    // Pendente: só quem enviou enxerga.
    expect((await getFile(owner, att.id)).statusCode).toBe(404);
    expect((await getFile(member, att.id)).statusCode).toBe(200);

    const sent = await member.post(`/channels/${text.id}/messages`, { content: '', attachmentIds: [att.id] });
    expect(sent.status).toBe(201);
    expect((sent.body as Message).attachments).toEqual([att]);
    expect(((await owner.get(`/channels/${text.id}/messages`)).body as Message[]).at(-1)!.attachments[0]!.id).toBe(att.id);

    const dl = await getFile(owner, att.id);
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('só texto, apesar do nome');
    expect(dl.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(dl.headers['content-disposition']).toMatch(/^attachment;.*filename\*=UTF-8''relat%C3%B3rio\.png/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-security-policy']).toContain('sandbox');
    expect(dl.headers['cache-control']).toBe('private, max-age=86400, immutable');

    expect((await getFile(outsider, att.id)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${att.id}` })).statusCode).toBe(401);
  });

  it('perder acesso ao canal corta o acesso ao arquivo na hora', async () => {
    const { owner, member, text, everyone } = await setup();
    const att = (await put(owner, `/channels/${text.id}/attachments?filename=a.txt`, Buffer.from('oi'))).json<Attachment>();
    await owner.post(`/channels/${text.id}/messages`, { content: 'veja', attachmentIds: [att.id] });
    expect((await getFile(member, att.id)).statusCode).toBe(200);
    await owner.put(`/channels/${text.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: '0', deny: P.VIEW_CHANNEL.toString() });
    expect((await getFile(member, att.id)).statusCode).toBe(404);
  });

  it('não dá para usar anexo de outra pessoa, de outro canal ou já usado', async () => {
    const { owner, member, d, text } = await setup();
    const other = (await owner.post(`/servers/${d.server.id}/channels`, { name: 'outro', type: 'text' })).body;
    const mine = (await put(member, `/channels/${text.id}/attachments?filename=a.txt`, Buffer.from('a'))).json<Attachment>();
    const fromOther = (await put(member, `/channels/${other.id}/attachments?filename=b.txt`, Buffer.from('b'))).json<Attachment>();

    expect((await owner.post(`/channels/${text.id}/messages`, { content: 'roubando', attachmentIds: [mine.id] })).status).toBe(400);
    expect((await member.post(`/channels/${text.id}/messages`, { content: 'x', attachmentIds: [fromOther.id] })).status).toBe(400);
    expect((await member.post(`/channels/${text.id}/messages`, { content: 'ok', attachmentIds: [mine.id] })).status).toBe(201);
    expect((await member.post(`/channels/${text.id}/messages`, { content: 'de novo', attachmentIds: [mine.id] })).status).toBe(400);
  });

  it('sem ATTACH_FILES não envia; mensagem vazia sem anexo é recusada', async () => {
    const { owner, member, text, everyone } = await setup();
    await owner.put(`/channels/${text.id}/overwrites/${everyone.id}`, { targetType: 'role', allow: '0', deny: P.ATTACH_FILES.toString() });
    const r = await put(member, `/channels/${text.id}/attachments?filename=a.txt`, Buffer.from('a'));
    expect(r.statusCode).toBe(403);
    expect((await member.post(`/channels/${text.id}/messages`, { content: '   ' })).status).toBe(400);
  });

  it('limite de tamanho: 413 com código próprio', async () => {
    const { member, text } = await setup();
    const r = await put(member, `/channels/${text.id}/attachments?filename=grande.bin`, Buffer.alloc(65 * 1024, 1));
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('FILE_TOO_LARGE');
  });

  it('excluir a mensagem apaga o arquivo (registro e conteúdo)', async () => {
    const { owner, member, text } = await setup();
    const att = (await put(member, `/channels/${text.id}/attachments?filename=a.txt`, Buffer.from('a'))).json<Attachment>();
    const m = (await member.post(`/channels/${text.id}/messages`, { content: 'x', attachmentIds: [att.id] })).body as Message;
    expect(await app.files.store.get(att.id)).not.toBeNull();
    expect((await member.del(`/channels/${text.id}/messages/${m.id}`)).status).toBe(204);
    expect((await getFile(owner, att.id)).statusCode).toBe(404);
    expect(await app.files.store.get(att.id)).toBeNull();
  });

  it('imagens: metadados removidos no que é guardado e servido; dimensões informadas', async () => {
    const { owner, member, text } = await setup();
    const att = (await put(member, `/channels/${text.id}/attachments?filename=foto.jpg`, jpeg(800, 600, { secret: 'GPS -23.5 Galaxy' }))).json<Attachment>();
    expect(att).toMatchObject({ contentType: 'image/jpeg', width: 800, height: 600 });
    await member.post(`/channels/${text.id}/messages`, { content: '', attachmentIds: [att.id] });
    const dl = await getFile(owner, att.id);
    expect(dl.headers['content-disposition']).toMatch(/^inline/);
    expect(dl.rawPayload.toString('latin1')).not.toContain('GPS');
    expect(dl.rawPayload.toString('latin1')).not.toContain('Galaxy');
  });

  it('remover anexo pendente; limpeza apaga pendentes antigos e conteúdo sem registro', async () => {
    const { member, text } = await setup();
    const a = (await put(member, `/channels/${text.id}/attachments?filename=a.txt`, Buffer.from('a'))).json<Attachment>();
    expect((await member.del(`/attachments/${a.id}`)).status).toBe(204);
    expect(await app.files.store.get(a.id)).toBeNull();

    const old = (await put(member, `/channels/${text.id}/attachments?filename=b.txt`, Buffer.from('b'))).json<Attachment>();
    await app.files.store.put('00000000-0000-4000-8000-000000000000', Buffer.from('órfão'));
    const r = await app.files.sweep(Date.now() + 2 * 60 * 60 * 1000);
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(r.orphans).toBeGreaterThanOrEqual(1);
    expect(await app.files.store.get(old.id)).toBeNull();
    expect(await app.files.store.get('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('em DM, os dois podem anexar e ver; um terceiro não', async () => {
    const a = await user(app);
    const b = await user(app);
    const c = await user(app);
    await befriend(a, b);
    const dm = (await a.post('/users/@me/channels', { recipientId: b.id })).body;
    const att = (await put(a, `/channels/${dm.id}/attachments?filename=a.txt`, Buffer.from('oi'))).json<Attachment>();
    await a.post(`/channels/${dm.id}/messages`, { content: '', attachmentIds: [att.id] });
    expect((await getFile(b, att.id)).statusCode).toBe(200);
    expect((await getFile(c, att.id)).statusCode).toBe(404);
  });
});

describe('avatar e banner', () => {
  it('só imagem; aparece no perfil público; trocar invalida o anterior; remover limpa', async () => {
    const { owner, member } = await setup();
    const bad = await put(member, '/users/@me/avatar?filename=a.txt', Buffer.from('não é imagem'), 'PUT');
    expect(bad.statusCode).toBe(415);
    expect(bad.json().error.code).toBe('UNSUPPORTED_FILE');

    const r1 = await put(member, '/users/@me/avatar?filename=eu.png', png(16, 16, 'segredo'), 'PUT');
    expect(r1.statusCode).toBe(200);
    const first = r1.json().user.avatarId as string;
    expect(first).toBeTruthy();
    const prof = (await owner.get(`/users/${member.id}`)).body;
    expect(prof.user.avatarId).toBe(first);
    const dl = await getFile(owner, first);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.toString('latin1')).not.toContain('segredo');

    const second = (await put(member, '/users/@me/avatar?filename=eu2.png', png(8, 8), 'PUT')).json().user.avatarId as string;
    expect(second).not.toBe(first);
    expect((await getFile(owner, first)).statusCode).toBe(404);
    expect(await app.files.store.get(first)).toBeNull();

    const banner = await put(member, '/users/@me/banner?filename=b.png', png(30, 10), 'PUT');
    expect(banner.json().user.bannerId).toBeTruthy();

    const removed = await member.del('/users/@me/avatar');
    expect(removed.body.user.avatarId).toBeNull();
    expect((await getFile(owner, second)).statusCode).toBe(404);
  });

  it('respeita o limite de tamanho de imagem de perfil', async () => {
    const { member } = await setup();
    const r = await put(member, '/users/@me/avatar?filename=g.png', Buffer.concat([png(4, 4), Buffer.alloc(40 * 1024)]), 'PUT');
    expect(r.statusCode).toBe(413);
  });
});
