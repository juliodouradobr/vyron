import { useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { Banner, Button } from './ui';
import { describeError } from '../services/api';
import { formatBytes, useFileUrl } from '../lib/files';
import { api, useSession } from '../stores/session';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

/** Faixa de banner do perfil: a imagem enviada, ou a cor padrão do tema. */
export function ProfileBanner({ bannerId, className }: { bannerId: string | null | undefined; className: string }) {
  const { url } = useFileUrl(bannerId);
  return <div className={className} style={url ? { backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined} aria-hidden />;
}

/** Trocar/remover avatar e banner (Configurações → Minha conta). */
export function ProfileImageControls() {
  const user = useSession((s) => s.user)!;
  const input = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<'avatar' | 'banner'>('avatar');
  const [busy, setBusy] = useState<null | { kind: 'avatar' | 'banner'; progress: number }>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = (kind: 'avatar' | 'banner') => {
    setTarget(kind);
    setError(null);
    input.current?.click();
  };

  const upload = async (file: File) => {
    if (file.size > MAX_IMAGE_BYTES) return setError(`A imagem passa de ${formatBytes(MAX_IMAGE_BYTES)}.`);
    setBusy({ kind: target, progress: 0 });
    try {
      const { user: next } = await api.setProfileImage(target, file, file.name, (p) => setBusy({ kind: target, progress: p }));
      useSession.getState().setUser(next);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (kind: 'avatar' | 'banner') => {
    setError(null);
    try {
      const { user: next } = await api.removeProfileImage(kind);
      useSession.getState().setUser(next);
    } catch (e) {
      setError(describeError(e));
    }
  };

  const row = (kind: 'avatar' | 'banner', label: string, has: boolean) => (
    <div className="image-controls__row">
      <span className="field__label">{label}</span>
      <Button size="sm" variant="secondary" onClick={() => pick(kind)} loading={busy?.kind === kind}>
        <ImagePlus size={14} aria-hidden /> {has ? 'Trocar' : 'Enviar imagem'}
      </Button>
      {has && (
        <Button size="sm" variant="secondary" onClick={() => void remove(kind)} disabled={!!busy}>
          <Trash2 size={14} aria-hidden /> Remover
        </Button>
      )}
      {busy?.kind === kind && <span className="muted mono">{Math.round(busy.progress * 100)}%</span>}
    </div>
  );

  return (
    <div className="image-controls">
      {row('avatar', 'Avatar', !!user.avatarId)}
      {row('banner', 'Banner', !!user.bannerId)}
      <p className="field__hint">
        PNG, JPEG, GIF ou WebP, até {formatBytes(MAX_IMAGE_BYTES)}. Localização (GPS), modelo do aparelho e outros metadados são
        removidos antes de guardar. Quem pode ver seu perfil pode ver estas imagens.
      </p>
      {error && <Banner tone="error">{error}</Banner>}
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void upload(f);
        }}
      />
    </div>
  );
}
