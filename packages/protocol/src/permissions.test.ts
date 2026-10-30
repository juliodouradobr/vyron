import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  Permission as P,
  canGrant,
  computePermissions,
  hasPermission,
  parsePermissions,
} from './permissions';

const none = { allow: 0n, deny: 0n };

describe('computePermissions', () => {
  it('proprietário tem tudo, mesmo com deny no canal', () => {
    const p = computePermissions({
      isOwner: true,
      everyone: 0n,
      memberRoles: [],
      channel: { roles: [], member: { allow: 0n, deny: ALL_PERMISSIONS } },
    });
    expect(p).toBe(ALL_PERMISSIONS);
  });

  it('ADMINISTRATOR ignora overwrites de canal', () => {
    const p = computePermissions({
      isOwner: false,
      everyone: DEFAULT_EVERYONE_PERMISSIONS,
      memberRoles: [P.ADMINISTRATOR],
      channel: { everyone: { allow: 0n, deny: P.VIEW_CHANNEL }, roles: [] },
    });
    expect(p).toBe(ALL_PERMISSIONS);
  });

  it('deny de @everyone no canal remove a permissão base', () => {
    const p = computePermissions({
      isOwner: false,
      everyone: DEFAULT_EVERYONE_PERMISSIONS,
      memberRoles: [],
      channel: { everyone: { allow: 0n, deny: P.SEND_MESSAGES }, roles: [] },
    });
    expect(hasPermission(p, P.SEND_MESSAGES)).toBe(false);
    expect(hasPermission(p, P.VIEW_CHANNEL)).toBe(true);
  });

  it('allow de cargo vence deny de @everyone', () => {
    const p = computePermissions({
      isOwner: false,
      everyone: DEFAULT_EVERYONE_PERMISSIONS,
      memberRoles: [0n],
      channel: {
        everyone: { allow: 0n, deny: P.SEND_MESSAGES },
        roles: [{ allow: P.SEND_MESSAGES, deny: 0n }],
      },
    });
    expect(hasPermission(p, P.SEND_MESSAGES)).toBe(true);
  });

  it('entre cargos, allow vence deny (união)', () => {
    const p = computePermissions({
      isOwner: false,
      everyone: DEFAULT_EVERYONE_PERMISSIONS,
      memberRoles: [0n, 0n],
      channel: {
        roles: [
          { allow: 0n, deny: P.SPEAK },
          { allow: P.SPEAK, deny: 0n },
        ],
      },
    });
    expect(hasPermission(p, P.SPEAK)).toBe(true);
  });

  it('overwrite do membro é o mais específico', () => {
    const p = computePermissions({
      isOwner: false,
      everyone: DEFAULT_EVERYONE_PERMISSIONS,
      memberRoles: [],
      channel: {
        roles: [{ allow: P.STREAM, deny: 0n }],
        member: { allow: 0n, deny: P.STREAM },
      },
    });
    expect(hasPermission(p, P.STREAM)).toBe(false);
  });

  it('sem VIEW_CHANNEL não sobra nenhuma permissão no canal', () => {
    const p = computePermissions({
      isOwner: false,
      everyone: DEFAULT_EVERYONE_PERMISSIONS,
      memberRoles: [],
      channel: { everyone: { allow: 0n, deny: P.VIEW_CHANNEL }, roles: [none] },
    });
    expect(p).toBe(0n);
  });
});

describe('canGrant', () => {
  it('não permite conceder permissão que o ator não possui', () => {
    expect(canGrant(P.MANAGE_ROLES | P.SEND_MESSAGES, P.SEND_MESSAGES)).toBe(true);
    expect(canGrant(P.MANAGE_ROLES, P.ADMINISTRATOR)).toBe(false);
    expect(canGrant(P.MANAGE_ROLES, P.KICK_MEMBERS | P.MANAGE_ROLES)).toBe(false);
  });
  it('administrador pode conceder qualquer permissão', () => {
    expect(canGrant(P.ADMINISTRATOR, ALL_PERMISSIONS)).toBe(true);
  });
});

describe('parsePermissions', () => {
  it('descarta bits desconhecidos e rejeita entrada não numérica', () => {
    expect(parsePermissions((1n << 60n | P.SPEAK).toString())).toBe(P.SPEAK);
    expect(() => parsePermissions('-1')).toThrow();
    expect(() => parsePermissions('0x10')).toThrow();
  });
});
