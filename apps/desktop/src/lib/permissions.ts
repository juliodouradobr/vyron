import { Permission as P } from '@nexo/protocol';

export interface PermissionInfo {
  bit: bigint;
  label: string;
  description: string;
  /** Recurso ainda não implementado: a permissão existe, mas não tem efeito visível. */
  pending?: string;
}

export const PERMISSION_GROUPS: Array<{ title: string; items: PermissionInfo[] }> = [
  {
    title: 'Gerais',
    items: [
      { bit: P.ADMINISTRATOR, label: 'Administrador', description: 'Concede todas as permissões e ignora ajustes de canal. Conceda com muito cuidado.' },
      { bit: P.MANAGE_SERVER, label: 'Gerenciar servidor', description: 'Alterar nome e descrição do servidor.' },
      { bit: P.MANAGE_ROLES, label: 'Gerenciar cargos', description: 'Criar e editar cargos abaixo do próprio e ajustar permissões de canais.' },
      { bit: P.MANAGE_CHANNELS, label: 'Gerenciar canais', description: 'Criar, renomear, mover e excluir canais.' },
      { bit: P.VIEW_AUDIT_LOG, label: 'Ver registro de auditoria', description: 'Ver quem fez cada alteração administrativa.' },
      { bit: P.MANAGE_EVENTS, label: 'Gerenciar eventos', description: 'Criar e editar eventos do servidor.', pending: 'eventos' },
    ],
  },
  {
    title: 'Membros',
    items: [
      { bit: P.CREATE_INVITES, label: 'Criar convites', description: 'Convidar novas pessoas para o servidor.' },
      { bit: P.MANAGE_INVITES, label: 'Gerenciar convites', description: 'Ver e revogar convites criados por qualquer pessoa.' },
      { bit: P.KICK_MEMBERS, label: 'Expulsar membros', description: 'Remover membros com cargos abaixo do seu.' },
      { bit: P.BAN_MEMBERS, label: 'Banir membros', description: 'Impedir que alguém volte ao servidor.', pending: 'banimentos' },
    ],
  },
  {
    title: 'Texto',
    items: [
      { bit: P.VIEW_CHANNEL, label: 'Ver canais', description: 'Ver canais e ler o histórico de mensagens.' },
      { bit: P.SEND_MESSAGES, label: 'Enviar mensagens', description: 'Escrever em canais de texto.' },
      { bit: P.ADD_REACTIONS, label: 'Adicionar reações', description: 'Reagir com um emoji novo (reagir com um já existente é sempre permitido).' },
      { bit: P.MANAGE_MESSAGES, label: 'Gerenciar mensagens', description: 'Excluir mensagens de outras pessoas e publicar em canais de anúncios.' },
      { bit: P.ATTACH_FILES, label: 'Anexar arquivos', description: 'Enviar imagens e arquivos (até 10 MB cada).' },
      { bit: P.MENTION_EVERYONE, label: 'Mencionar todos', description: 'Notificar todos os membros de uma vez.', pending: 'menção a todos' },
    ],
  },
  {
    title: 'Voz e transmissão',
    items: [
      { bit: P.CONNECT_VOICE, label: 'Conectar', description: 'Entrar em canais de voz.' },
      { bit: P.SPEAK, label: 'Falar', description: 'Transmitir áudio em canais de voz.' },
      { bit: P.VIDEO, label: 'Câmera', description: 'Ligar a câmera em canais de voz.' },
      { bit: P.STREAM, label: 'Compartilhar tela', description: 'Transmitir tela, janela ou jogo.' },
      { bit: P.MUTE_MEMBERS, label: 'Silenciar membros', description: 'Silenciar outras pessoas em canais de voz.', pending: 'moderação de voz' },
      { bit: P.MOVE_MEMBERS, label: 'Mover membros', description: 'Mover pessoas entre canais de voz.', pending: 'moderação de voz' },
    ],
  },
];

/** Permissões que fazem sentido ajustar por canal (as de servidor ficam de fora). */
export const CHANNEL_PERMISSIONS: bigint[] = [
  P.VIEW_CHANNEL,
  P.SEND_MESSAGES,
  P.ADD_REACTIONS,
  P.MANAGE_MESSAGES,
  P.MANAGE_CHANNELS,
  P.MANAGE_ROLES,
  P.CREATE_INVITES,
  P.CONNECT_VOICE,
  P.SPEAK,
  P.VIDEO,
  P.STREAM,
];

export const permissionInfo = (bit: bigint) => PERMISSION_GROUPS.flatMap((g) => g.items).find((i) => i.bit === bit)!;

export const AUDIT_LABELS: Record<string, string> = {
  'server.create': 'criou o servidor',
  'server.update': 'alterou o servidor',
  'channel.create': 'criou um canal',
  'channel.update': 'alterou um canal',
  'channel.delete': 'excluiu um canal',
  'overwrite.update': 'ajustou permissões de um canal',
  'overwrite.delete': 'removeu um ajuste de permissões',
  'role.create': 'criou um cargo',
  'role.update': 'alterou um cargo',
  'role.delete': 'excluiu um cargo',
  'member.roles': 'alterou os cargos de um membro',
  'member.kick': 'expulsou um membro',
  'member.join': 'entrou no servidor',
  'member.leave': 'saiu do servidor',
  'invite.create': 'criou um convite',
  'invite.revoke': 'revogou um convite',
  'message.delete': 'excluiu uma mensagem de outra pessoa',
};

export const colorHex = (c: number | null) => (c == null ? null : `#${c.toString(16).padStart(6, '0')}`);
