import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  displayNameSchema,
  formatTag,
  parseTag,
  recoverySchema,
  registerSchema,
  userIdentifierSchema,
  userSettingsSchema,
} from './schemas';

describe('registerSchema', () => {
  it('preserva maiúsculas e aceita acentos', () => {
    expect(registerSchema.parse({ username: '  Jogador_1 ', password: 'senha-forte-123' }).username).toBe('Jogador_1');
    expect(registerSchema.parse({ username: 'Ação-Rápida', password: 'senha-forte-123' }).username).toBe('Ação-Rápida');
  });
  it('normaliza para NFC (o mesmo "é" digitado de formas diferentes)', () => {
    expect(registerSchema.parse({ username: 'José', password: 'senha-forte-123' }).username).toBe('José');
  });
  it.each(['a', 'com espaço', 'nome#123', '@nome', 'x'.repeat(33)])('rejeita "%s"', (username) => {
    expect(registerSchema.safeParse({ username, password: 'senha-forte-123' }).success).toBe(false);
  });
  it('rejeita senha igual ao nome (sem diferenciar maiúsculas) e senha curta', () => {
    expect(registerSchema.safeParse({ username: 'Jogador123', password: 'jogador123' }).success).toBe(false);
    expect(registerSchema.safeParse({ username: 'jogador', password: '1234567' }).success).toBe(false);
  });
});

describe('identificador Name#00000', () => {
  it('formata e interpreta', () => {
    expect(formatTag({ username: 'Lia', discriminator: '00042' })).toBe('Lia#00042');
    expect(parseTag(' @Lia#00042 ')).toEqual({ name: 'Lia', discriminator: '00042' });
    expect(parseTag('Lia')).toEqual({ name: 'Lia', discriminator: null });
  });
  it.each(['Lia#00000', 'Lia#123', 'Lia#123456', '#00042', 'L#00042', 'Li a#00042', 'Lia##00042'])('rejeita "%s"', (v) => {
    expect(parseTag(v)).toBeNull();
    expect(userIdentifierSchema.safeParse(v).success).toBe(false);
  });
});

describe('displayNameSchema', () => {
  it('rejeita caracteres de controle de direção (spoofing)', () => {
    expect(displayNameSchema.safeParse('admin‮gpj').success).toBe(false);
    expect(displayNameSchema.safeParse('Nome Válido ✨').success).toBe(true);
  });
});

describe('recoverySchema', () => {
  it('aceita o código com hífen e minúsculas', () => {
    const r = recoverySchema.parse({ username: 'a1', recoveryCode: 'abcde-12345', newPassword: 'nova-senha-1' });
    expect(r.recoveryCode).toBe('ABCDE12345');
  });
});

describe('userSettingsSchema', () => {
  it('preenche padrões e descarta campos desconhecidos', () => {
    const s = userSettingsSchema.parse({ theme: 'light', hacked: true });
    expect(s).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' });
  });
  it('valida limites de escala', () => {
    expect(userSettingsSchema.safeParse({ uiScale: 5 }).success).toBe(false);
  });
});
