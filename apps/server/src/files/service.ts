import { randomUUID } from 'node:crypto';
import { ErrorCode, type Attachment } from '@nexo/protocol';
import type { Config } from '../config';
import type { Db, Queryable } from '../db';
import { AppError } from '../http/errors';
import { imageSize, safeFilename, sniff, stripMetadata } from './sniff';
import type { FileStore } from './store';

export type FileKind = 'attachment' | 'avatar' | 'banner';

export interface FileRow {
  id: string;
  owner_id: string;
  kind: FileKind;
  channel_id: string | null;
  message_id: string | null;
  filename: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: Date;
}

export const toAttachment = (r: FileRow): Attachment => ({
  id: r.id,
  filename: r.filename,
  contentType: r.content_type,
  size: r.size,
  width: r.width,
  height: r.height,
});

const tooLarge = (max: number) => new AppError(413, ErrorCode.FILE_TOO_LARGE, `O arquivo passa do limite de ${Math.round(max / 1024 / 1024)} MB.`);

/**
 * Recebe arquivos já com tamanho limitado pelo Fastify, descobre o tipo pelo conteúdo, limpa
 * metadados de imagens e guarda. Imagem malformada é recusada (não guardamos algo que não sabemos ler).
 */
export class FileService {
  constructor(
    private readonly db: Db,
    readonly store: FileStore,
    private readonly config: Config,
    private readonly log: (err: unknown, msg: string) => void = () => {},
  ) {}

  /** Prepara o conteúdo: tipo real, metadados removidos, dimensões. */
  prepare(data: Buffer, opts: { imageOnly: boolean; max: number }) {
    if (data.length === 0) throw new AppError(400, ErrorCode.VALIDATION, 'O arquivo está vazio.');
    if (data.length > opts.max) throw tooLarge(opts.max);
    const t = sniff(data);
    if (opts.imageOnly && !t.image) throw new AppError(415, ErrorCode.UNSUPPORTED_FILE, 'Use uma imagem PNG, JPEG, GIF ou WebP.');
    let body = data;
    let size: { width: number; height: number } | null = null;
    if (t.image) {
      const clean = stripMetadata(data, t.mime);
      size = imageSize(data, t.mime);
      if (!clean || !size || size.width < 1 || size.height < 1 || size.width > 20_000 || size.height > 20_000) {
        throw new AppError(415, ErrorCode.UNSUPPORTED_FILE, 'Não foi possível ler essa imagem.');
      }
      body = clean;
    }
    return { body, mime: t.mime, size };
  }

  async save(
    q: Queryable,
    input: { owner: string; kind: FileKind; channelId: string | null; filename: string; data: Buffer; imageOnly: boolean; max: number },
  ): Promise<FileRow> {
    const p = this.prepare(input.data, { imageOnly: input.imageOnly, max: input.max });
    const id = randomUUID();
    await this.store.put(id, p.body);
    try {
      const { rows } = await q.query<FileRow>(
        `INSERT INTO files (id, owner_id, kind, channel_id, filename, content_type, size, width, height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [id, input.owner, input.kind, input.channelId, safeFilename(input.filename), p.mime, p.body.length, p.size?.width ?? null, p.size?.height ?? null],
      );
      return rows[0]!;
    } catch (err) {
      await this.store.delete(id);
      throw err;
    }
  }

  async remove(ids: string[]): Promise<void> {
    for (const id of ids) await this.store.delete(id).catch((e) => this.log(e, 'falha ao apagar arquivo'));
  }

  /**
   * Limpeza: anexos enviados e nunca usados expiram; conteúdo sem registro no banco (sobras de
   * mensagens/avatares apagados) é removido do armazenamento.
   */
  async sweep(now = Date.now()): Promise<{ expired: number; orphans: number }> {
    const cutoff = new Date(now - this.config.files.pendingTtlMs);
    const { rows } = await this.db.query<{ id: string }>(
      `DELETE FROM files WHERE kind = 'attachment' AND message_id IS NULL AND created_at < $1 RETURNING id`,
      [cutoff],
    );
    await this.remove(rows.map((r) => r.id));
    const stored = await this.store.list();
    let orphans = 0;
    if (stored.length) {
      const { rows: known } = await this.db.query<{ id: string }>('SELECT id FROM files WHERE id = ANY($1::uuid[])', [stored]);
      const keep = new Set(known.map((r) => r.id));
      const gone = stored.filter((id) => !keep.has(id));
      orphans = gone.length;
      await this.remove(gone);
    }
    return { expired: rows.length, orphans };
  }

  async attachmentsOf(q: Queryable, messageIds: string[]): Promise<Map<string, Attachment[]>> {
    const out = new Map<string, Attachment[]>();
    if (messageIds.length === 0) return out;
    const { rows } = await q.query<FileRow>(
      `SELECT * FROM files WHERE message_id = ANY($1::uuid[]) ORDER BY created_at, id`,
      [messageIds],
    );
    for (const r of rows) {
      const list = out.get(r.message_id!) ?? [];
      list.push(toAttachment(r));
      out.set(r.message_id!, list);
    }
    return out;
  }
}
