import { useEffect, useState } from 'react';
import { api, useSession } from '../stores/session';

/**
 * Arquivos do servidor exigem login a cada pedido, então não dá para usar <img src="url"> direto:
 * baixamos com o token e exibimos por um endereço local (blob:). Cache em memória com limite,
 * liberando os mais antigos (cada um ocupa memória enquanto existir).
 */
const MAX_ENTRIES = 200;
const cache = new Map<string, Promise<string>>();

export function fileUrl(id: string): Promise<string> {
  const hit = cache.get(id);
  if (hit) {
    // Reinsere para marcar como usado recentemente.
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const p = api.fileBlob(id).then((b) => URL.createObjectURL(b));
  p.catch(() => cache.delete(id)); // falhou: deixa tentar de novo depois
  cache.set(id, p);
  while (cache.size > MAX_ENTRIES) {
    const [oldId, oldP] = cache.entries().next().value as [string, Promise<string>];
    cache.delete(oldId);
    void oldP.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  }
  return p;
}

/** Esvazia o cache (ex.: ao sair da conta), liberando a memória. */
export function clearFileCache(): void {
  for (const p of cache.values()) void p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  cache.clear();
}

// Saiu da conta (ou trocou de conta): nada do que foi baixado continua em memória.
useSession.subscribe((s, prev) => {
  if (prev.user && s.user?.id !== prev.user.id) clearFileCache();
});

/** Endereço local de um arquivo do servidor (ou null enquanto carrega / se falhar). */
export function useFileUrl(id: string | null | undefined): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ id: string | null; url: string | null; failed: boolean }>({ id: null, url: null, failed: false });
  useEffect(() => {
    if (!id) return;
    let alive = true;
    fileUrl(id).then(
      (url) => alive && setState({ id, url, failed: false }),
      () => alive && setState({ id, url: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [id]);
  return state.id === id ? { url: state.url, failed: state.failed } : { url: null, failed: false };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
