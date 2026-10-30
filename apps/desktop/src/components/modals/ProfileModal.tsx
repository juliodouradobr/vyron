import { useEffect, useState } from 'react';
import { formatTag } from '@nexo/protocol';
import { Ban, Flag, MessageSquare, ShieldOff, UserMinus, UserPlus } from 'lucide-react';
import { Avatar, Banner, Button, Modal, Spinner } from '../ui';
import { ReportDialog } from '../ReportDialog';
import { ProfileBanner } from '../ProfileImages';
import { describeError, type UserProfile } from '../../services/api';
import { api, useSession } from '../../stores/session';
import { presenceOf, useSocial } from '../../stores/social';
import { useUi } from '../../stores/ui';

const PRESENCE = { online: 'Disponível', idle: 'Ausente', dnd: 'Não perturbe', invisible: 'Offline', offline: 'Offline' } as const;

export function ProfileModal({ userId }: { userId: string }) {
  const close = useUi((s) => s.closeModal);
  const self = useSession((s) => s.user);
  const rel = useSocial((s) => s.relationships[userId]?.type ?? null);
  const presence = useSocial((s) => presenceOf(s.presences, userId));
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const isSelf = self?.id === userId;

  useEffect(() => {
    api.profile(userId).then(setProfile, (e) => setError(describeError(e)));
  }, [userId]);

  const run = (fn: () => Promise<unknown>) => () => {
    setError(null);
    fn().catch((e) => setError(describeError(e)));
  };

  if (reporting && profile) return <ReportDialog userId={userId} who={profile.user.displayName} onClose={() => setReporting(false)} />;

  return (
    <Modal title="Perfil" onClose={close} size="sm">
      {!profile ? (
        error ? <Banner tone="error">{error}</Banner> : <Spinner />
      ) : (
        <div className="profile">
          <ProfileBanner bannerId={profile.user.bannerId} className="profile__banner" />
          <div className="profile__head">
            <Avatar name={profile.user.displayName} seed={profile.user.id} imageId={profile.user.avatarId} size={80} status={isSelf ? self!.status : presence} />
            <div>
              <h3 className="profile__name">{profile.user.displayName}</h3>
              <p className="muted">{formatTag(profile.user)} ·{isSelf ? 'Você' : PRESENCE[presence]}</p>
            </div>
          </div>
          {profile.user.bio && (
            <section>
              <h4 className="field__label">Sobre mim</h4>
              <p className="profile__bio">{profile.user.bio}</p>
            </section>
          )}
          <section>
            <h4 className="field__label">Membro do VYRON desde</h4>
            <p>{new Date(profile.user.createdAt).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
          </section>
          {!isSelf && profile.mutualServers.length > 0 && (
            <section>
              <h4 className="field__label">Servidores em comum — {profile.mutualServers.length}</h4>
              <p>{profile.mutualServers.map((s) => s.name).join(', ')}</p>
            </section>
          )}
          {error && <Banner tone="error">{error}</Banner>}
          {!isSelf && (
            <div className="profile__actions">
              {rel !== 'blocked' && (
                <Button onClick={run(async () => { await useSocial.getState().openDm(userId); close(); })}>
                  <MessageSquare size={16} aria-hidden /> Enviar mensagem
                </Button>
              )}
              {rel === null && (
                <Button variant="secondary" onClick={run(() => api.sendFriendRequest(formatTag(profile.user)))}>
                  <UserPlus size={16} aria-hidden /> Adicionar amigo
                </Button>
              )}
              {rel === 'incoming' && (
                <Button variant="secondary" onClick={run(() => api.acceptFriend(userId))}>
                  <UserPlus size={16} aria-hidden /> Aceitar pedido
                </Button>
              )}
              {rel === 'outgoing' && <Button variant="secondary" disabled>Pedido enviado</Button>}
              {rel === 'friend' && (
                <Button variant="secondary" onClick={run(() => api.removeRelationship(userId))}>
                  <UserMinus size={16} aria-hidden /> Desfazer amizade
                </Button>
              )}
              {rel === 'blocked' ? (
                <Button variant="secondary" onClick={run(() => api.removeRelationship(userId))}>
                  <ShieldOff size={16} aria-hidden /> Desbloquear
                </Button>
              ) : (
                <Button variant="ghost" onClick={run(() => api.block(userId))}>
                  <Ban size={16} aria-hidden /> Bloquear
                </Button>
              )}
              <Button variant="ghost" onClick={() => setReporting(true)}>
                <Flag size={16} aria-hidden /> Denunciar
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
