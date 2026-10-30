import { describe, expect, it } from 'vitest';
import { decodeMentions, encodeMentions, parseContent } from './format';

const ID = '0192aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

describe('parseContent', () => {
  it('separa texto, menções e links http(s)', () => {
    expect(parseContent(`oi <@${ID}> veja https://exemplo.com/a?b=1.`)).toEqual([
      { kind: 'text', text: 'oi ' },
      { kind: 'mention', userId: ID },
      { kind: 'text', text: ' veja ' },
      { kind: 'link', href: 'https://exemplo.com/a?b=1', text: 'https://exemplo.com/a?b=1' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('não transforma esquemas perigosos em link', () => {
    for (const s of ['javascript:alert(1)', 'file:///C:/Windows', 'data:text/html,<b>x</b>']) {
      expect(parseContent(s).every((x) => x.kind === 'text')).toBe(true);
    }
  });
});

describe('menções', () => {
  const users = [{ id: ID, username: 'Jogador_1', discriminator: '04821' }];
  it('codifica @Nome#00000 conhecido (sem diferenciar maiúsculas) e ignora desconhecidos, nome sem número e e-mails', () => {
    expect(encodeMentions('@jogador_1#04821 e @Jogador_1#00002, @Jogador_1 mail a@Jogador_1#04821', users)).toBe(
      `<@${ID}> e @Jogador_1#00002, @Jogador_1 mail a@Jogador_1#04821`,
    );
  });
  it('aceita nomes com acento', () => {
    const u = [{ id: ID, username: 'Joséé', discriminator: '00007' }];
    expect(encodeMentions('oi @Joséé#00007!', u)).toBe(`oi <@${ID}>!`);
  });
  it('decodifica para edição', () => {
    expect(decodeMentions(`oi <@${ID}>`, users)).toBe('oi @Jogador_1#04821');
  });
});
