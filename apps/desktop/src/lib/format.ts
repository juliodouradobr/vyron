import { formatTag } from '@nexo/protocol';

/** "Hoje às 14:05", "Ontem às 09:12" ou "12/10/2026 14:05". */
export function formatTimestamp(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86_400_000;
  if (diff === 0) return `Hoje às ${time}`;
  if (diff === 1) return `Ontem às ${time}`;
  return `${d.toLocaleDateString('pt-BR')} ${time}`;
}

export const formatTime = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export const formatDay = (iso: string) =>
  new Date(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });

export const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

export function formatExpiry(iso: string | null): string {
  if (!iso) return 'Nunca expira';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'Expirado';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return `Expira em ${Math.round(h / 24)} dia(s)`;
  if (h >= 1) return `Expira em ${h} h`;
  return `Expira em ${Math.max(1, Math.round(ms / 60_000))} min`;
}

export type Segment = { kind: 'text'; text: string } | { kind: 'mention'; userId: string } | { kind: 'link'; href: string; text: string };

const TOKEN_RE = /<@([0-9a-f-]{36})>|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/gi;

/**
 * Quebra o conteúdo em texto, menções e links. Nada vira HTML: o React escapa todo o texto,
 * e só http(s) vira link — `javascript:`, `file:` e afins ficam como texto puro.
 */
export function parseContent(content: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of content.matchAll(TOKEN_RE)) {
    if (m.index! > last) out.push({ kind: 'text', text: content.slice(last, m.index) });
    if (m[1]) out.push({ kind: 'mention', userId: m[1] });
    else out.push({ kind: 'link', href: m[2]!, text: m[2]! });
    last = m.index! + m[0].length;
  }
  if (last < content.length) out.push({ kind: 'text', text: content.slice(last) });
  return out;
}

type Tagged = { id: string; username: string; discriminator: string };

/**
 * Converte "@Nome#00000" digitado no compositor em "<@id>" para usuários conhecidos.
 * Exige o identificador completo: com nomes repetidos, só o nome não diz de quem se trata.
 */
export function encodeMentions(text: string, users: Tagged[]): string {
  const byTag = new Map(users.map((u) => [formatTag(u).toLowerCase(), u.id]));
  return text.replace(/(^|\s)@([\p{L}\p{N}_.-]{2,32}#\d{5})/gu, (all, pre: string, tag: string) => {
    const id = byTag.get(tag.normalize('NFC').toLowerCase());
    return id ? `${pre}<@${id}>` : all;
  });
}

/** O inverso, para editar uma mensagem: "<@id>" volta a ser "@Nome#00000". */
export function decodeMentions(text: string, users: Tagged[]): string {
  const byId = new Map(users.map((u) => [u.id, formatTag(u)]));
  return text.replace(/<@([0-9a-f-]{36})>/g, (all, id: string) => (byId.has(id) ? `@${byId.get(id)}` : all));
}
