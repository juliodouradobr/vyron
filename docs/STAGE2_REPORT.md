# Relatório — Etapa 2 (Social)

Data: 2026-10-25 · Banco: PGlite (Postgres 17 em WASM) · Migração: `002_social.sql`.

## Implementado

**Amizades e privacidade**
- Pedido por nome de usuário, aceitar/recusar/cancelar, remover, pedidos cruzados viram amizade.
- Bloqueio unilateral: desfaz amizade, impede pedidos e DMs nos dois sentidos, oculta presença.
  A recusa por bloqueio ou privacidade usa a mesma mensagem — quem foi bloqueado não descobre.
- Privacidade: quem pode enviar pedidos (todos / servidores em comum / ninguém) e DMs de membros.
- Perfil público mínimo (sem e-mail, IP, status bruto ou dados de sessão) com servidores em comum.

**Mensagens diretas** — 1:1, permitidas entre amigos ou membros de servidor em comum (se o destinatário permitir).

**Servidores** — criação com `@everyone`, categorias e canais padrão; edição; exclusão (só dono, com
confirmação digitada); saída; expulsão; convites com validade, limite de usos e revogação
(limite garantido no banco mesmo com entradas simultâneas); registro de auditoria.

**Cargos e permissões**
- Bitfield com resolução documentada (`packages/protocol/src/permissions.ts`); overwrites por canal
  para cargo e membro; canais privados.
- Hierarquia: ninguém edita, atribui ou expulsa no próprio nível ou acima; ninguém concede
  permissão que não tem (`canGrant`), nem por cargo, nem por overwrite.
- Sem acesso ao canal, a API responde 404 (não revela que o canal/servidor existe).

**Chat** — tempo real, histórico paginado por cursor (UUIDv7), edição própria, exclusão própria ou
de moderador (auditada), respostas, menções `<@id>`, reações com emoji validado, busca (com `%`/`_`
literais), não lidas, indicador de digitação, denúncias com cópia do conteúdo, limite de 5 msgs/5 s,
e reenvio idempotente via `nonce` (falha de rede nunca duplica mensagem).

**Tempo real** — cada evento é autorizado no envio: mensagens só chegam a quem tem `VIEW_CHANNEL`;
mudanças de canal/cargo disparam `SERVER_SYNC` e o cliente recarrega só o que pode ver.

**Interface** — barra de servidores com não lidas e pedidos pendentes; amigos com abas; lista de DMs;
canais por categoria (recolhíveis); chat com agrupamento, divisores de dia e "novas mensagens",
envio otimista, autocompletar de menções, rascunho por canal; lista de membros com cores de cargo;
perfil; configurações de servidor (visão geral, cargos, membros, convites, auditoria) e de canal
(visão geral, permissões em três estados); privacidade nas configurações do usuário.

## Testes (resultados reais)

| Suíte | Resultado |
|---|---|
| protocolo | 21/21 ✅ |
| servidor — auth, gateway, social, servidores/permissões/mensagens/tempo real | 71/71 ✅ |
| desktop — gateway, API, voz, formatação/menções, store de mensagens, login | 32/32 ✅ |
| `tsc` + `vite build` | ok ✅ |

Tentativas de burla cobertas: não-membro lendo/escrevendo (404); membro comum administrando (403);
moderador criando cargo admin, autopromovendo-se, editando o @everyone além do que tem, movendo
cargo acima do seu, atribuindo cargo superior, expulsando o dono ou um par; IDs de outro servidor;
overwrite concedendo o que não tem; canal privado vazando por evento em tempo real.

### Verificação manual (navegador + segundo usuário via API)
Pedido de amizade chegou em tempo real com contador → aceito pela interface → servidor criado →
convite gerado → a amiga entrou com o código → mensagem dela apareceu ao vivo com menção destacada,
link seguro e divisor de "novas" → resposta com autocompletar de menção → criação de cargo.

### Bugs encontrados e corrigidos
1. `max(uuid)` não existe no Postgres → excluir a última mensagem dava 500 (pego por teste).
2. Limites por rota fixos no código impediam testes e configuração → agora em `config.rateLimit`.
3. Cliente do gateway sem prazo para o handshake: após reinícios do servidor podia ficar preso em
   "Reconectando…" para sempre → tempo-limite de 15 s com teste.
4. Dica invisível na borda direita alargava o documento; focar o compositor rolava a janela inteira.
5. A primeira sugestão de menção era o próprio usuário.

## Não implementado nesta etapa (honesto)
- Anexos de arquivo e pré-visualização de links (as permissões existem; o recurso não).
- Threads, DMs em grupo, banimentos, apelidos editáveis, transferência de posse.
- Virtualização da lista: o histórico em memória é limitado a 500 mensagens por canal,
  mas listas muito longas ainda são renderizadas inteiras.
- Categoria não propaga permissões aos canais filhos (cada canal tem seus próprios ajustes).
- O cálculo de destinatários de eventos percorre todos os membros do servidor — adequado para
  centenas de membros; servidores grandes exigirão cache de permissões.
