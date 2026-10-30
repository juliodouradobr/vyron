import { Permission as P } from '@nexo/protocol';

/** Espelha as permissões fixas de DM do servidor (o servidor continua sendo quem decide). */
export const DM_CLIENT_PERMISSIONS = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS;

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '👀'];

/** Mensagens do mesmo autor com menos que isso de intervalo ficam agrupadas. */
export const GROUP_WINDOW_MS = 7 * 60 * 1000;
