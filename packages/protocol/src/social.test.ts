import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS_PER_MESSAGE, editMessageSchema, sendMessageSchema } from './social';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('sendMessageSchema', () => {
  it('aceita texto, anexos ou os dois', () => {
    expect(sendMessageSchema.safeParse({ content: 'oi' }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ attachmentIds: [id(1)] }).success).toBe(true);
    expect(sendMessageSchema.parse({ attachmentIds: [id(1)] }).content).toBe('');
    expect(sendMessageSchema.safeParse({ content: 'veja', attachmentIds: [id(1), id(2)] }).success).toBe(true);
  });
  it('recusa mensagem vazia, ids inválidos e anexos demais', () => {
    expect(sendMessageSchema.safeParse({ content: '   ' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ content: '', attachmentIds: [] }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ attachmentIds: ['../../etc'] }).success).toBe(false);
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => id(i));
    expect(sendMessageSchema.safeParse({ content: 'x', attachmentIds: many }).success).toBe(false);
  });
  it('editar continua exigindo texto', () => {
    expect(editMessageSchema.safeParse({ content: '' }).success).toBe(false);
    expect(editMessageSchema.safeParse({ content: 'novo' }).success).toBe(true);
  });
});
