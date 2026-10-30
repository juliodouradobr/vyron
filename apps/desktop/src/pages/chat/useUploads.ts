import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENTS_PER_MESSAGE, type Attachment } from '@nexo/protocol';
import { describeError } from '../../services/api';
import { formatBytes } from '../../lib/files';
import { api } from '../../stores/session';

/** Mesmo limite do servidor (o servidor confere de novo; aqui é só para avisar antes de enviar). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface Upload {
  key: string;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
  error?: string;
  /** Prévia local de imagens (antes de chegar ao servidor). */
  preview?: string;
  abort?: AbortController;
}

/**
 * Anexos do compositor: cada arquivo sobe assim que é escolhido (com progresso) e fica pendente no
 * servidor até a mensagem ser enviada. Trocar de canal cancela/descarta os que não foram usados.
 */
export function useUploads(channelId: string) {
  const [items, setItems] = useState<Upload[]>([]);
  const ref = useRef(items);
  ref.current = items;

  const patch = (key: string, p: Partial<Upload>) => setItems((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));

  const discardAll = useCallback((list: Upload[]) => {
    for (const u of list) {
      u.abort?.abort();
      if (u.preview) URL.revokeObjectURL(u.preview);
      if (u.attachment) void api.deleteAttachment(u.attachment.id).catch(() => {});
    }
  }, []);

  // Trocar de canal: anexos de um canal não servem em outro.
  useEffect(() => {
    return () => {
      discardAll(ref.current);
      setItems([]);
    };
  }, [channelId, discardAll]);

  const add = (files: FileList | File[]) => {
    const room = MAX_ATTACHMENTS_PER_MESSAGE - ref.current.length;
    const list = [...files].slice(0, Math.max(0, room));
    const fresh: Upload[] = list.map((f) => {
      const key = crypto.randomUUID();
      const tooBig = f.size > MAX_ATTACHMENT_BYTES;
      const empty = f.size === 0;
      return {
        key,
        name: f.name || 'arquivo',
        size: f.size,
        progress: 0,
        status: tooBig || empty ? 'error' : 'uploading',
        error: tooBig ? `Maior que ${formatBytes(MAX_ATTACHMENT_BYTES)}.` : empty ? 'Arquivo vazio.' : undefined,
        preview: f.type.startsWith('image/') && !tooBig ? URL.createObjectURL(f) : undefined,
        abort: new AbortController(),
      };
    });
    setItems((cur) => [...cur, ...fresh]);
    fresh.forEach((u, i) => {
      if (u.status !== 'uploading') return;
      const file = list[i]!;
      api
        .uploadAttachment(channelId, file, u.name, (p) => patch(u.key, { progress: p }), u.abort!.signal)
        .then((attachment) => patch(u.key, { status: 'done', attachment, progress: 1, abort: undefined }))
        .catch((err) => patch(u.key, { status: 'error', error: describeError(err), abort: undefined }));
    });
    return files.length - list.length; // quantos ficaram de fora pelo limite
  };

  const remove = (key: string) => {
    const u = ref.current.find((x) => x.key === key);
    if (u) discardAll([u]);
    setItems((cur) => cur.filter((x) => x.key !== key));
  };

  /** Entrega os anexos prontos para a mensagem e limpa a lista (sem apagar no servidor). */
  const take = (): Attachment[] => {
    const done = ref.current.filter((u) => u.status === 'done' && u.attachment).map((u) => u.attachment!);
    for (const u of ref.current) if (u.preview) URL.revokeObjectURL(u.preview);
    setItems([]);
    return done;
  };

  return {
    items,
    add,
    remove,
    take,
    uploading: items.some((u) => u.status === 'uploading'),
    ready: items.filter((u) => u.status === 'done').length,
  };
}
