import type { DispatchEvent } from '@nexo/protocol';
import type { Db } from '../db';
import { channelViewers, serverMemberIds, type ChannelRow } from '../permissions/service';
import type { Hub, PublicPresence } from './hub';

/**
 * Entrega eventos em tempo real somente a quem tem permissão de vê-los.
 * Toda autorização é recalculada no momento do envio — nunca confia em assinaturas do cliente.
 */
export class Dispatcher {
  constructor(
    private readonly db: Db,
    private readonly hub: Hub,
    private readonly log: (err: unknown, msg: string) => void = () => {},
  ) {
    hub.onPresence((userId, presence) => void this.presence(userId, presence).catch((e) => this.log(e, 'falha ao publicar presença')));
  }

  toUsers(userIds: Iterable<string>, event: DispatchEvent): void {
    const msg = { op: 'dispatch', event } as const;
    for (const id of new Set(userIds)) this.hub.sendToUser(id, msg);
  }

  async toChannel(channel: ChannelRow, event: DispatchEvent, except?: string): Promise<void> {
    const viewers = await channelViewers(this.db, channel);
    this.toUsers(
      viewers.filter((v) => v !== except),
      event,
    );
  }

  private readonly serverListeners = new Set<(serverId: string) => Promise<void>>();

  /** Interessados em mudanças de permissão de um servidor (ex.: voz reavalia quem está em chamada). */
  onServerChanged(fn: (serverId: string) => Promise<void>): void {
    this.serverListeners.add(fn);
  }

  async notifyServerChanged(serverId: string): Promise<void> {
    for (const fn of this.serverListeners) await fn(serverId).catch((e) => this.log(e, 'falha ao reagir a mudança de servidor'));
  }

  /** Avisa todos os membros para recarregarem o servidor (canais/cargos/permissões mudaram). */
  async serverSync(serverId: string): Promise<void> {
    this.toUsers(await serverMemberIds(this.db, serverId), { type: 'SERVER_SYNC', serverId });
    await this.notifyServerChanged(serverId);
  }

  async membersChanged(serverId: string): Promise<void> {
    this.toUsers(await serverMemberIds(this.db, serverId), { type: 'MEMBERS_CHANGED', serverId });
    await this.notifyServerChanged(serverId);
  }

  /** Quem pode ver a presença de um usuário: amigos e membros de servidores em comum, exceto bloqueios. */
  async presenceAudience(userId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT target_id AS id FROM relationships WHERE user_id = $1 AND type = 'friend'
       UNION
       SELECT y.user_id FROM server_members x JOIN server_members y ON x.server_id = y.server_id
        WHERE x.user_id = $1 AND y.user_id <> $1
       EXCEPT
       SELECT target_id FROM relationships WHERE user_id = $1 AND type = 'blocked'
       EXCEPT
       SELECT user_id FROM relationships WHERE target_id = $1 AND type = 'blocked'`,
      [userId],
    );
    return rows.map((r) => r.id);
  }

  private async presence(userId: string, status: PublicPresence): Promise<void> {
    this.toUsers(await this.presenceAudience(userId), { type: 'PRESENCE_UPDATE', userId, status });
  }
}
