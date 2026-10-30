import type { Message, MessageReaction } from '@nexo/protocol';
import type { Queryable } from '../db';
import { loadPublicUsers } from '../users/public';
import { toAttachment, type FileRow } from '../files/service';

export interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  reply_to_id: string | null;
  mentions: string[];
  nonce: string | null;
  created_at: Date;
  edited_at: Date | null;
}

export interface ReactionAgg {
  message_id: string;
  emoji: string;
  user_ids: string[];
}

export async function loadReactions(q: Queryable, messageIds: string[]): Promise<ReactionAgg[]> {
  if (messageIds.length === 0) return [];
  const { rows } = await q.query<ReactionAgg>(
    `SELECT message_id, emoji, array_agg(user_id ORDER BY created_at) AS user_ids
       FROM reactions WHERE message_id = ANY($1::uuid[])
      GROUP BY message_id, emoji
      ORDER BY min(created_at)`,
    [messageIds],
  );
  return rows;
}

/** Monta mensagens completas (autor, resposta citada, reações) em poucas consultas, sem N+1. */
export async function hydrateMessages(q: Queryable, rows: MessageRow[], viewerId: string): Promise<Message[]> {
  if (rows.length === 0) return [];
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter((x): x is string => !!x))];
  const { rows: replies } = replyIds.length
    ? await q.query<{ id: string; author_id: string; content: string }>(
        'SELECT id, author_id, content FROM messages WHERE id = ANY($1::uuid[])',
        [replyIds],
      )
    : { rows: [] };
  const users = await loadPublicUsers(q, [...rows.map((r) => r.author_id), ...replies.map((r) => r.author_id)]);
  const reactions = await loadReactions(
    q,
    rows.map((r) => r.id),
  );
  const replyMap = new Map(replies.map((r) => [r.id, r]));
  const { rows: fileRows } = await q.query<FileRow>('SELECT * FROM files WHERE message_id = ANY($1::uuid[]) ORDER BY created_at, id', [
    rows.map((r) => r.id),
  ]);

  return rows
    .filter((r) => users.has(r.author_id))
    .map((r) => {
      const reply = r.reply_to_id ? replyMap.get(r.reply_to_id) : undefined;
      const rx: MessageReaction[] = reactions
        .filter((x) => x.message_id === r.id)
        .map((x) => ({ emoji: x.emoji, count: x.user_ids.length, me: x.user_ids.includes(viewerId) }));
      return {
        id: r.id,
        channelId: r.channel_id,
        author: users.get(r.author_id)!,
        content: r.content,
        attachments: fileRows.filter((f) => f.message_id === r.id).map(toAttachment),
        replyTo: reply ? { id: reply.id, author: users.get(reply.author_id) ?? null, content: reply.content.slice(0, 200) } : null,
        mentions: r.mentions ?? [],
        reactions: rx,
        createdAt: new Date(r.created_at).toISOString(),
        editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
        nonce: r.nonce,
      };
    });
}
