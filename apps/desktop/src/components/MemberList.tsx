import type { Member, Role } from '@nexo/protocol';
import { Crown } from 'lucide-react';
import { Avatar, Spinner } from './ui';
import { colorHex } from '../lib/permissions';
import { useServers } from '../stores/servers';
import { presenceOf, useSocial } from '../stores/social';
import { useSession } from '../stores/session';
import { openProfile } from '../stores/ui';

/** Membros agrupados em online/offline; o nome usa a cor do cargo colorido mais alto. */
export function MemberList({ serverId }: { serverId: string }) {
  const members = useServers((s) => s.members[serverId]);
  const detail = useServers((s) => s.details[serverId]);
  const presences = useSocial((s) => s.presences);
  const self = useSession((s) => s.user);

  if (!members || !detail) {
    return (
      <aside className="side-panel members" aria-label="Membros" aria-busy>
        <Spinner />
      </aside>
    );
  }

  const roles = new Map<string, Role>(detail.roles.map((r) => [r.id, r]));
  // O próprio usuário não recebe presença de si mesmo pelo gateway: usa o status local.
  const presence = (id: string) => (id === self?.id ? (self.status === 'invisible' ? 'offline' : self.status) : presenceOf(presences, id));
  const byName = (a: Member, b: Member) => a.user.displayName.localeCompare(b.user.displayName, 'pt-BR');
  const online = members.filter((m) => presence(m.user.id) !== 'offline').sort(byName);
  const offline = members.filter((m) => presence(m.user.id) === 'offline').sort(byName);

  const row = (m: Member, isOffline: boolean) => {
    const top = m.roleIds
      .map((id) => roles.get(id))
      .filter((r): r is Role => !!r && r.color != null)
      .sort((a, b) => b.position - a.position)[0];
    const color = colorHex(top?.color ?? null);
    return (
      <li key={m.user.id}>
        <button className={`member ${isOffline ? 'member--offline' : ''}`} onClick={() => openProfile(m.user.id)}>
          <Avatar name={m.user.displayName} seed={m.user.id} imageId={m.user.avatarId} size={32} status={presence(m.user.id)} />
          <span className="member__name" style={color ? { color } : undefined}>
            {m.nickname ?? m.user.displayName}
          </span>
          {detail.server.ownerId === m.user.id && <Crown size={14} className="member__crown" aria-label="Proprietário" />}
        </button>
      </li>
    );
  };

  return (
    <aside className="side-panel members" aria-label="Membros">
      <div className="side-panel__scroll">
        {online.length > 0 && (
          <section>
            <h3 className="members__group">Online — {online.length}</h3>
            <ul>{online.map((m) => row(m, false))}</ul>
          </section>
        )}
        {offline.length > 0 && (
          <section>
            <h3 className="members__group">Offline — {offline.length}</h3>
            <ul>{offline.map((m) => row(m, true))}</ul>
          </section>
        )}
      </div>
    </aside>
  );
}
