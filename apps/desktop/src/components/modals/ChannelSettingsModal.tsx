import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Permission as P, canGrant, parsePermissions, type ChannelOverwriteDto } from '@nexo/protocol';
import { Plus, Trash2 } from 'lucide-react';
import { Banner, Button, TextField } from '../ui';
import { ConfirmDialog } from '../ConfirmDialog';
import { CHANNEL_PERMISSIONS, colorHex, permissionInfo } from '../../lib/permissions';
import { describeError } from '../../services/api';
import { api } from '../../stores/session';
import { can, useServers } from '../../stores/servers';
import { useUi } from '../../stores/ui';
import { SettingsShell, TriState } from './SettingsShell';

type Section = 'overview' | 'permissions';

export function ChannelSettingsModal({ serverId, channelId }: { serverId: string; channelId: string }) {
  const close = useUi((s) => s.closeModal);
  const detail = useServers((s) => s.details[serverId]);
  const channel = detail?.channels.find((c) => c.id === channelId);
  const [section, setSection] = useState<Section>('overview');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    // Canal excluído ou ficou invisível enquanto o modal estava aberto.
    if (detail && !channel) close();
  }, [detail, channel, close]);
  if (!detail || !channel) return null;

  const canManage = can(channel.myPermissions, P.MANAGE_CHANNELS);
  const canPerms = can(channel.myPermissions, P.MANAGE_ROLES);

  return (
    <SettingsShell<Section>
      title={channel.type === 'category' ? channel.name : `#${channel.name}`}
      sections={[
        { id: 'overview', label: 'Visão geral', hidden: !canManage },
        { id: 'permissions', label: 'Permissões', hidden: !canPerms },
      ]}
      current={canManage ? section : 'permissions'}
      onSelect={setSection}
      onClose={close}
      footer={
        canManage && (
          <button className="settings__nav-item settings__nav-item--danger" onClick={() => setConfirmDelete(true)}>
            <span>Excluir {channel.type === 'category' ? 'categoria' : 'canal'}</span>
            <Trash2 size={16} />
          </button>
        )
      }
    >
      {(canManage ? section : 'permissions') === 'overview' ? <Overview channelId={channelId} name={channel.name} topic={channel.topic} isCategory={channel.type === 'category'} /> : <Permissions serverId={serverId} channelId={channelId} />}
      {confirmDelete && (
        <ConfirmDialog
          title={`Excluir ${channel.name}?`}
          confirmLabel="Excluir"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await api.deleteChannel(channelId).catch((e) => {
              throw new Error(describeError(e));
            });
            await useServers.getState().loadDetail(serverId);
            close();
          }}
        >
          {channel.type === 'category'
            ? 'Os canais dentro dela continuam existindo, sem categoria.'
            : 'Todas as mensagens deste canal serão apagadas para sempre. Isso não pode ser desfeito.'}
        </ConfirmDialog>
      )}
    </SettingsShell>
  );
}

function Overview({ channelId, name: initialName, topic: initialTopic, isCategory }: { channelId: string; name: string; topic: string; isCategory: boolean }) {
  const [name, setName] = useState(initialName);
  const [topic, setTopic] = useState(initialTopic);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = name !== initialName || topic !== initialTopic;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const ch = await api.updateChannel(channelId, { name: name !== initialName ? name : undefined, topic: topic !== initialTopic ? topic : undefined });
      setName(ch.name);
      setMsg({ tone: 'success', text: 'Alterações salvas.' });
    } catch (err) {
      setMsg({ tone: 'error', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={save}>
      <TextField label={isCategory ? 'Nome da categoria' : 'Nome do canal'} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      {!isCategory && (
        <div className="field">
          <label className="field__label" htmlFor="ch-topic">Tópico</label>
          <textarea id="ch-topic" className="field__input field__textarea" value={topic} maxLength={1024} onChange={(e) => setTopic(e.target.value)} placeholder="Do que se fala aqui?" />
        </div>
      )}
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      <div className="row-end">
        <Button type="submit" disabled={!dirty || !name.trim()} loading={busy}>Salvar</Button>
      </div>
    </form>
  );
}

function Permissions({ serverId, channelId }: { serverId: string; channelId: string }) {
  const detail = useServers((s) => s.details[serverId])!;
  const members = useServers((s) => s.members[serverId]);
  const channel = detail.channels.find((c) => c.id === channelId)!;
  const everyone = detail.roles.find((r) => r.isDefault)!;
  const [target, setTarget] = useState<string>(everyone.id);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!members) void useServers.getState().loadMembers(serverId);
  }, [members, serverId]);

  const myPerms = parsePermissions(channel.myPermissions);
  const overwrites = channel.overwrites;
  const current: ChannelOverwriteDto = overwrites.find((o) => o.targetId === target) ?? {
    targetType: detail.roles.some((r) => r.id === target) ? 'role' : 'member',
    targetId: target,
    allow: '0',
    deny: '0',
  };
  const [draft, setDraft] = useState({ allow: 0n, deny: 0n });
  useEffect(() => {
    setDraft({ allow: parsePermissions(current.allow), deny: parsePermissions(current.deny) });
    setSaved(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, current.allow, current.deny]);

  const targets = useMemo(() => {
    const listed = new Set([everyone.id, ...overwrites.map((o) => o.targetId)]);
    return [...listed].map((id) => {
      const role = detail.roles.find((r) => r.id === id);
      if (role) return { id, label: role.name, color: role.color, kind: 'role' as const };
      const m = members?.find((x) => x.user.id === id);
      return { id, label: m ? m.user.displayName : 'Membro', color: null, kind: 'member' as const };
    });
  }, [overwrites, detail.roles, members, everyone.id]);

  const addable = [
    ...detail.roles.filter((r) => !targets.some((t) => t.id === r.id)).map((r) => ({ id: r.id, label: `Cargo: ${r.name}` })),
    ...(members ?? []).filter((m) => !targets.some((t) => t.id === m.user.id)).map((m) => ({ id: m.user.id, label: `Membro: ${m.user.displayName}` })),
  ];

  const stateOf = (bit: bigint): -1 | 0 | 1 => (draft.deny & bit ? -1 : draft.allow & bit ? 1 : 0);
  const setBit = (bit: bigint, v: -1 | 0 | 1) => {
    setSaved(false);
    setDraft({ allow: v === 1 ? draft.allow | bit : draft.allow & ~bit, deny: v === -1 ? draft.deny | bit : draft.deny & ~bit });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.putOverwrite(channelId, target, { targetType: current.targetType, allow: draft.allow.toString(), deny: draft.deny.toString() });
      await useServers.getState().loadDetail(serverId);
      setSaved(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await api.deleteOverwrite(channelId, target);
      await useServers.getState().loadDetail(serverId);
      setTarget(everyone.id);
    } catch (e) {
      setError(describeError(e));
    }
  };

  const hasOverwrite = overwrites.some((o) => o.targetId === target);
  const dirty = draft.allow !== parsePermissions(current.allow) || draft.deny !== parsePermissions(current.deny);

  return (
    <div className="perm-editor">
      <aside className="perm-editor__targets">
        <div className="perm-editor__targets-head">
          <span className="field__label">Cargos e membros</span>
          <button className="icon-btn icon-btn--xs" aria-label="Adicionar cargo ou membro" onClick={() => setAdding((v) => !v)}>
            <Plus size={14} />
          </button>
        </div>
        {adding && (
          <select
            className="field__input"
            aria-label="Escolher cargo ou membro"
            value=""
            onChange={(e) => {
              if (e.target.value) setTarget(e.target.value);
              setAdding(false);
            }}
          >
            <option value="">Escolher…</option>
            {addable.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        )}
        <ul>
          {[...targets, ...(targets.some((t) => t.id === target) ? [] : [{ id: target, label: addable.find((a) => a.id === target)?.label ?? '…', color: null, kind: 'role' as const }])].map((t) => (
            <li key={t.id}>
              <button className={`perm-target ${t.id === target ? 'perm-target--on' : ''}`} onClick={() => setTarget(t.id)}>
                <span className="role-dot" style={{ background: colorHex(t.color) ?? 'var(--text-muted)' }} aria-hidden />
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="perm-editor__rows">
        <p className="muted">
          Ajustes de canal vencem as permissões do cargo. Ordem: @everyone → cargos (permitir vence negar) → membro específico.
        </p>
        {CHANNEL_PERMISSIONS.filter((bit) => channel.type !== 'voice' || ![P.SEND_MESSAGES, P.ADD_REACTIONS, P.MANAGE_MESSAGES].includes(bit)).map((bit) => {
          const info = permissionInfo(bit);
          const allowed = canGrant(myPerms, bit);
          return (
            <div key={bit.toString()} className="perm-row">
              <div>
                <strong>{info.label}</strong>
                <p className="muted">{info.description}{info.pending ? ` (efeito chega com ${info.pending})` : ''}</p>
              </div>
              <TriState label={info.label} value={stateOf(bit)} onChange={(v) => setBit(bit, v)} disabled={!allowed} />
            </div>
          );
        })}
        {error && <Banner tone="error">{error}</Banner>}
        {saved && !dirty && <Banner tone="success">Permissões salvas.</Banner>}
        <div className="row-end">
          {hasOverwrite && target !== everyone.id && (
            <Button variant="ghost" onClick={remove}>Remover ajuste</Button>
          )}
          <Button onClick={save} loading={busy} disabled={!dirty}>Salvar permissões</Button>
        </div>
      </div>
    </div>
  );
}
