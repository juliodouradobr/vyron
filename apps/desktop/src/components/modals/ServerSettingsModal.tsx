import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ALL_PERMISSIONS,
  Permission as P,
  canGrant,
  formatTag,
  parsePermissions,
  type AuditEntry,
  type Invite,
  type Role,
  type ServerDetail,
} from '@nexo/protocol';
import { ArrowDown, ArrowUp, Crown, Plus, Trash2, UserX } from 'lucide-react';
import { Avatar, Banner, Button, Spinner, TextField, Toggle } from '../ui';
import { ConfirmDialog } from '../ConfirmDialog';
import { AUDIT_LABELS, PERMISSION_GROUPS, colorHex } from '../../lib/permissions';
import { formatExpiry, formatTimestamp } from '../../lib/format';
import { describeError } from '../../services/api';
import { api, useSession } from '../../stores/session';
import { can, useServers } from '../../stores/servers';
import { useUi } from '../../stores/ui';
import { SettingsShell } from './SettingsShell';

type Section = 'overview' | 'roles' | 'members' | 'invites' | 'audit';

/** Posição do cargo mais alto do usuário atual (dono = infinito) — limite do que ele pode editar. */
function myTop(detail: ServerDetail, selfId: string): number {
  if (detail.server.ownerId === selfId) return Number.POSITIVE_INFINITY;
  return Math.max(0, ...detail.roles.filter((r) => detail.myRoleIds.includes(r.id)).map((r) => r.position));
}

export function ServerSettingsModal({ serverId }: { serverId: string }) {
  const close = useUi((s) => s.closeModal);
  const detail = useServers((s) => s.details[serverId]);
  const selfId = useSession((s) => s.user?.id ?? '');
  const [section, setSection] = useState<Section>('overview');
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!detail) return null;

  const perms = detail.myPermissions;
  const isOwner = detail.server.ownerId === selfId;
  const sections = [
    { id: 'overview' as const, label: 'Visão geral', hidden: !can(perms, P.MANAGE_SERVER) },
    { id: 'roles' as const, label: 'Cargos', hidden: !can(perms, P.MANAGE_ROLES) },
    { id: 'members' as const, label: 'Membros', hidden: !can(perms, P.MANAGE_ROLES) && !can(perms, P.KICK_MEMBERS) },
    { id: 'invites' as const, label: 'Convites', hidden: !can(perms, P.MANAGE_INVITES) },
    { id: 'audit' as const, label: 'Registro de auditoria', hidden: !can(perms, P.VIEW_AUDIT_LOG) },
  ];
  const visible = sections.filter((s) => !s.hidden);
  const current = visible.some((s) => s.id === section) ? section : visible[0]?.id ?? 'overview';

  return (
    <SettingsShell<Section>
      title={detail.server.name}
      sections={sections}
      current={current}
      onSelect={setSection}
      onClose={close}
      footer={
        isOwner && (
          <button className="settings__nav-item settings__nav-item--danger" onClick={() => setConfirmDelete(true)}>
            <span>Excluir servidor</span>
            <Trash2 size={16} />
          </button>
        )
      }
    >
      {current === 'overview' && <Overview detail={detail} />}
      {current === 'roles' && <Roles detail={detail} selfId={selfId} />}
      {current === 'members' && <Members detail={detail} selfId={selfId} />}
      {current === 'invites' && <Invites serverId={serverId} />}
      {current === 'audit' && <Audit serverId={serverId} />}
      {confirmDelete && (
        <ConfirmDialog
          title={`Excluir ${detail.server.name}?`}
          confirmLabel="Excluir servidor"
          danger
          typeToConfirm={detail.server.name}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await api.deleteServer(serverId).catch((e) => {
              throw new Error(describeError(e));
            });
            useServers.getState().remove(serverId);
            close();
          }}
        >
          Todos os canais, mensagens, cargos e convites serão apagados para sempre. Isso não pode ser desfeito.
        </ConfirmDialog>
      )}
    </SettingsShell>
  );
}

/* ---------------- Visão geral ---------------- */

function Overview({ detail }: { detail: ServerDetail }) {
  const [name, setName] = useState(detail.server.name);
  const [description, setDescription] = useState(detail.server.description);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = name !== detail.server.name || description !== detail.server.description;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      useServers.getState().setDetail(await api.updateServer(detail.server.id, { name, description }));
      setMsg({ tone: 'success', text: 'Servidor atualizado.' });
    } catch (err) {
      setMsg({ tone: 'error', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={save}>
      <TextField label="Nome do servidor" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      <div className="field">
        <label className="field__label" htmlFor="srv-desc">Descrição</label>
        <textarea id="srv-desc" className="field__input field__textarea" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <p className="field__hint">{detail.memberCount} membro(s)</p>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      <div className="row-end">
        <Button type="submit" disabled={!dirty || name.trim().length < 2} loading={busy}>Salvar</Button>
      </div>
    </form>
  );
}

/* ---------------- Cargos ---------------- */

function Roles({ detail, selfId }: { detail: ServerDetail; selfId: string }) {
  const sorted = [...detail.roles].sort((a, b) => b.position - a.position);
  const [selected, setSelected] = useState<string>(sorted[0]!.id);
  const [error, setError] = useState<string | null>(null);
  const role = sorted.find((r) => r.id === selected) ?? sorted[0]!;
  const top = myTop(detail, selfId);
  const myPerms = parsePermissions(detail.myPermissions);

  const create = async () => {
    setError(null);
    try {
      const r = await api.createRole(detail.server.id, { name: 'novo cargo' });
      await useServers.getState().loadDetail(detail.server.id);
      setSelected(r.id);
    } catch (e) {
      setError(describeError(e));
    }
  };

  const move = async (r: Role, delta: 1 | -1) => {
    setError(null);
    try {
      await api.updateRole(detail.server.id, r.id, { position: r.position + delta });
      await useServers.getState().loadDetail(detail.server.id);
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="roles">
      <aside className="roles__list">
        <Button size="sm" onClick={create} block>
          <Plus size={14} aria-hidden /> Criar cargo
        </Button>
        <p className="field__hint">Cargos mais acima têm prioridade. Você só edita cargos abaixo do seu.</p>
        <ul>
          {sorted.map((r) => {
            const editable = !r.isDefault && r.position < top;
            return (
              <li key={r.id} className="roles__item">
                <button className={`perm-target ${r.id === role.id ? 'perm-target--on' : ''}`} onClick={() => setSelected(r.id)}>
                  <span className="role-dot" style={{ background: colorHex(r.color) ?? 'var(--text-muted)' }} aria-hidden />
                  {r.name}
                </button>
                {editable && (
                  <span className="roles__move">
                    <button className="icon-btn icon-btn--xs" aria-label={`Subir ${r.name}`} disabled={r.position + 1 >= top || r.position === sorted[0]!.position} onClick={() => void move(r, 1)}>
                      <ArrowUp size={12} />
                    </button>
                    <button className="icon-btn icon-btn--xs" aria-label={`Descer ${r.name}`} disabled={r.position <= 1} onClick={() => void move(r, -1)}>
                      <ArrowDown size={12} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {error && <Banner tone="error">{error}</Banner>}
      </aside>
      <RoleEditor key={role.id + role.permissions + role.name + role.color} detail={detail} role={role} editable={role.isDefault ? top > 0 || detail.server.ownerId === selfId : role.position < top} myPerms={myPerms} isOwner={detail.server.ownerId === selfId} onDeleted={() => setSelected(sorted.find((r) => r.isDefault)!.id)} />
    </div>
  );
}

function RoleEditor({ detail, role, editable, myPerms, isOwner, onDeleted }: { detail: ServerDetail; role: Role; editable: boolean; myPerms: bigint; isOwner: boolean; onDeleted: () => void }) {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<number | null>(role.color);
  const [perms, setPerms] = useState(parsePermissions(role.permissions));
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const original = parsePermissions(role.permissions);
  const dirty = name !== role.name || color !== role.color || perms !== original;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.updateRole(detail.server.id, role.id, {
        ...(name !== role.name && !role.isDefault ? { name } : {}),
        ...(color !== role.color ? { color } : {}),
        ...(perms !== original ? { permissions: perms.toString() } : {}),
      });
      await useServers.getState().loadDetail(detail.server.id);
    } catch (e) {
      setMsg({ tone: 'error', text: describeError(e) });
      setBusy(false);
    }
  };

  return (
    <section className="role-editor" aria-label={`Editar ${role.name}`}>
      {!editable && <Banner tone="info">Este cargo está no mesmo nível ou acima do seu: só é possível visualizá-lo.</Banner>}
      <div className="grid-2">
        <TextField label="Nome do cargo" value={name} onChange={(e) => setName(e.target.value)} disabled={!editable || role.isDefault} maxLength={100} />
        <div className="field">
          <span className="field__label">Cor</span>
          <div className="row">
            <input type="color" aria-label="Cor do cargo" value={colorHex(color) ?? '#99aab5'} disabled={!editable} onChange={(e) => setColor(parseInt(e.target.value.slice(1), 16))} />
            <Button size="sm" variant="ghost" disabled={!editable || color == null} onClick={() => setColor(null)}>Sem cor</Button>
          </div>
        </div>
      </div>
      {PERMISSION_GROUPS.map((g) => (
        <div key={g.title} className="perm-group">
          <h3 className="field__label">{g.title}</h3>
          {g.items.map((info) => {
            // Só concede o que você tem; remover algo do cargo é sempre possível para quem pode editá-lo.
            const grantable = isOwner || canGrant(myPerms, info.bit) || (perms & info.bit) !== 0n;
            return (
              <Toggle
                key={info.bit.toString()}
                label={info.label}
                description={info.description + (info.pending ? ` (efeito chega com ${info.pending})` : '')}
                checked={(perms & info.bit) !== 0n}
                disabled={!editable || !grantable}
                onChange={(on) => setPerms(on ? perms | info.bit : perms & ~info.bit & ALL_PERMISSIONS)}
              />
            );
          })}
        </div>
      ))}
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      {editable && (
        <div className="row-end sticky-actions">
          {!role.isDefault && (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              <Trash2 size={14} aria-hidden /> Excluir cargo
            </Button>
          )}
          <Button variant="ghost" disabled={!dirty} onClick={() => { setName(role.name); setColor(role.color); setPerms(original); }}>Descartar</Button>
          <Button onClick={save} disabled={!dirty} loading={busy}>Salvar alterações</Button>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Excluir o cargo ${role.name}?`}
          confirmLabel="Excluir"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            await api.deleteRole(detail.server.id, role.id).catch((e) => {
              throw new Error(describeError(e));
            });
            await useServers.getState().loadDetail(detail.server.id);
            onDeleted();
          }}
        >
          Quem tem este cargo perde as permissões dele imediatamente.
        </ConfirmDialog>
      )}
    </section>
  );
}

/* ---------------- Membros ---------------- */

function Members({ detail, selfId }: { detail: ServerDetail; selfId: string }) {
  const serverId = detail.server.id;
  const members = useServers((s) => s.members[serverId]);
  const [editing, setEditing] = useState<string | null>(null);
  const [kicking, setKicking] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const top = myTop(detail, selfId);
  const canRoles = can(detail.myPermissions, P.MANAGE_ROLES);
  const canKick = can(detail.myPermissions, P.KICK_MEMBERS);
  const rolesById = new Map(detail.roles.map((r) => [r.id, r]));
  const assignable = detail.roles.filter((r) => !r.isDefault && r.position < top).sort((a, b) => b.position - a.position);

  useEffect(() => {
    void useServers.getState().loadMembers(serverId);
  }, [serverId]);

  const memberTop = (roleIds: string[], userId: string) =>
    userId === detail.server.ownerId ? Number.POSITIVE_INFINITY : Math.max(0, ...roleIds.map((id) => rolesById.get(id)?.position ?? 0));

  const toggleRole = async (userId: string, roleIds: string[], roleId: string) => {
    setError(null);
    const next = roleIds.includes(roleId) ? roleIds.filter((r) => r !== roleId) : [...roleIds, roleId];
    try {
      await api.setMemberRoles(serverId, userId, next);
      await useServers.getState().loadMembers(serverId);
    } catch (e) {
      setError(describeError(e));
    }
  };

  if (!members) return <Spinner />;
  return (
    <div className="stack">
      {error && <Banner tone="error">{error}</Banner>}
      <ul className="member-admin">
        {members.map((m) => {
          const theirTop = memberTop(m.roleIds, m.user.id);
          const manageable = m.user.id === selfId || theirTop < top;
          return (
            <li key={m.user.id} className="member-admin__row">
              <Avatar name={m.user.displayName} seed={m.user.id} imageId={m.user.avatarId} size={32} />
              <div className="member-admin__info">
                <strong>
                  {m.user.displayName}
                  {m.user.id === detail.server.ownerId && <Crown size={12} className="member__crown" aria-label="Proprietário" />}
                </strong>
                <span className="muted">{formatTag(m.user)}</span>
                <div className="chips">
                  {m.roleIds
                    .map((id) => rolesById.get(id))
                    .filter((r): r is Role => !!r)
                    .sort((a, b) => b.position - a.position)
                    .map((r) => (
                      <span key={r.id} className="chip">
                        <span className="role-dot" style={{ background: colorHex(r.color) ?? 'var(--text-muted)' }} aria-hidden />
                        {r.name}
                      </span>
                    ))}
                </div>
                {editing === m.user.id && (
                  <fieldset className="role-checks">
                    <legend className="sr-only">Cargos de {m.user.displayName}</legend>
                    {assignable.length === 0 && <p className="muted">Nenhum cargo abaixo do seu para atribuir.</p>}
                    {assignable.map((r) => (
                      <label key={r.id} className="check">
                        <input type="checkbox" checked={m.roleIds.includes(r.id)} onChange={() => void toggleRole(m.user.id, m.roleIds, r.id)} />
                        <span className="role-dot" style={{ background: colorHex(r.color) ?? 'var(--text-muted)' }} aria-hidden />
                        {r.name}
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
              <div className="row">
                {canRoles && manageable && (
                  <Button size="sm" variant="secondary" onClick={() => setEditing(editing === m.user.id ? null : m.user.id)}>
                    {editing === m.user.id ? 'Concluir' : 'Cargos'}
                  </Button>
                )}
                {canKick && m.user.id !== selfId && theirTop < top && (
                  <Button size="sm" variant="ghost" aria-label={`Expulsar ${m.user.displayName}`} onClick={() => setKicking({ id: m.user.id, name: m.user.displayName })}>
                    <UserX size={14} aria-hidden /> Expulsar
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {kicking && (
        <ConfirmDialog
          title={`Expulsar ${kicking.name}?`}
          confirmLabel="Expulsar"
          danger
          onCancel={() => setKicking(null)}
          onConfirm={async () => {
            await api.kick(serverId, kicking.id).catch((e) => {
              throw new Error(describeError(e));
            });
            await useServers.getState().loadMembers(serverId);
            setKicking(null);
          }}
        >
          A pessoa sai do servidor agora e só volta com um novo convite.
        </ConfirmDialog>
      )}
    </div>
  );
}

/* ---------------- Convites ---------------- */

function Invites({ serverId }: { serverId: string }) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.invites(serverId).then(setInvites, (e) => setError(describeError(e)));
  }, [serverId]);
  useEffect(load, [load]);

  const revoke = async (code: string) => {
    try {
      await api.revokeInvite(code);
      load();
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="stack">
      <p className="muted">Convites ativos. Revogar um convite impede novas entradas por ele imediatamente.</p>
      {error && <Banner tone="error">{error}</Banner>}
      {!invites ? (
        <Spinner />
      ) : invites.length === 0 ? (
        <p className="muted">Nenhum convite ativo.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Código</th><th>Criado por</th><th>Usos</th><th>Validade</th><th /></tr>
          </thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.code}>
                <td className="mono">{i.code}</td>
                <td>{i.inviter?.displayName ?? '—'}</td>
                <td>{i.uses}{i.maxUses ? ` / ${i.maxUses}` : ''}</td>
                <td>{formatExpiry(i.expiresAt)}</td>
                <td><Button size="sm" variant="ghost" onClick={() => void revoke(i.code)}>Revogar</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ---------------- Auditoria ---------------- */

function Audit({ serverId }: { serverId: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.auditLog(serverId).then(setEntries, (e) => setError(describeError(e)));
  }, [serverId]);
  if (error) return <Banner tone="error">{error}</Banner>;
  if (!entries) return <Spinner />;
  return (
    <ul className="audit">
      {entries.map((e) => (
        <li key={e.id} className="audit__row">
          <strong>{e.actor?.displayName ?? 'Alguém'}</strong> {AUDIT_LABELS[e.action] ?? e.action}
          {typeof e.details.name === 'string' && <> — <em>{e.details.name}</em></>}
          <span className="muted"> · {formatTimestamp(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
