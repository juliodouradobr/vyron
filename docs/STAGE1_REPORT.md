# Relatório — Etapa 1 (Fundação)

Data: 2026-10-25 · Máquina: Windows 11, Node 24 · Banco: PGlite (Postgres 17 em WASM).

## O que foi implementado

**Backend** (`apps/server`)
- Cadastro, login, logout, recuperação por códigos de uso único, troca de senha, regeneração de códigos.
- Senhas com Argon2id (parâmetros OWASP). Tokens opacos de 256 bits guardados só como SHA-256.
- Sessões com expiração deslizante (30 dias), listagem, revogação individual e "encerrar todas as outras".
- Bloqueio temporário da conta após 5 falhas; rate limit global e mais rígido nas rotas de segredo.
- Perfil (nome de exibição, descrição, status) e preferências sincronizadas, validadas e com padrões.
- Gateway WebSocket: HELLO/IDENTIFY/READY, heartbeat com timeout, limite de conexões por usuário,
  limite de mensagens, validação de origem e de cada mensagem.
- Presença com múltiplas conexões, tolerância a reconexão rápida e status invisível publicado como offline.
- Revogar uma sessão derruba **imediatamente** a conexão em tempo real daquele dispositivo.
- Migrações SQL versionadas e transacionais; cabeçalhos de segurança; logs com redação de segredos.

**Protocolo** (`packages/protocol`)
- Esquemas zod compartilhados, códigos de erro, opcodes do gateway.
- Cálculo de permissões por bitfield com resolução documentada e `canGrant` contra escalonamento
  (já testado; usado pelas rotas na Etapa 2).

**Desktop** (`apps/desktop`)
- Design system com tokens (cores, espaço, tipografia, raios, sombras, movimento), tema escuro/claro/sistema,
  alto contraste, densidade, escala da interface, movimento reduzido.
- Telas de entrar / criar conta / recuperar acesso com estados de carregamento, credenciais inválidas,
  conta inexistente, nome em uso, bloqueio, falha de rede e sessão expirada/encerrada.
- Layout principal: barra de servidores, painel de conversas, área central, barra do usuário com
  status, mute/deafen, indicador de conexão e atalho de configurações. Gaveta em janelas estreitas.
- Configurações: Minha conta (perfil, senha, códigos, sessões ativas), Aparência, Acessibilidade,
  Notificações, Rede (diagnóstico) e Sobre. Categorias de etapas futuras aparecem desabilitadas.
- Cliente do gateway com backoff exponencial + jitter, detecção de conexão zumbi e reconexão ao voltar a rede.
- Restauração de sessão ao reiniciar; tela própria quando o servidor está inacessível.

**Shell nativo** (`apps/desktop/src-tauri`) — escrito, **não compilado** (sem Rust nesta máquina)
- Token no Gerenciador de Credenciais do Windows; bandeja com "Sair do Nexo"; fechar-para-bandeja configurável.
- Capabilities mínimas: só `core:default` e os 4 comandos próprios. CSP restritiva.

## Testes executados (resultados reais)

| Suíte | Resultado |
|---|---|
| `packages/protocol` — permissões e validação | 21/21 ✅ |
| `apps/server` — autenticação, sessões, perfil, preferências, rate limit, CORS | 21/21 ✅ |
| `apps/server` — gateway e presença (WebSocket real) | 12/12 ✅ |
| `apps/desktop` — cliente do gateway, cliente da API, voz, tela de login | 21/21 ✅ |
| `tsc` em todos os pacotes | sem erros ✅ |
| `vite build` de produção | ok — JS principal 241 KB (74 KB gzip) ✅ |

Destaques de segurança cobertos por teste: sessão de outro usuário não pode ser revogada; campos
como `username`/`id` enviados no PATCH são ignorados; tokens não aparecem no banco; código de
recuperação não pode ser reutilizado; origem não autorizada é recusada na API e no gateway;
mensagens fora do protocolo derrubam a conexão.

### Verificação manual no navegador (servidor + interface reais)

- Cadastro → diálogo de códigos de recuperação → tela inicial com gateway conectado. ✅
- Senha errada mostra o erro no campo. ✅
- Tema claro aplicado na hora e salvo no servidor. ✅
- Revogar a sessão do navegador a partir de outro "dispositivo" (via API) derrubou o navegador para o
  login em ~1 s com a mensagem correta e apagou o token local. ✅
- Recarregar a página manteve login, tema e microfone silenciado. ✅
- Derrubar o backend mostrou o banner de reconexão; ao religar, reconectou sozinho sem novo login. ✅

### Bugs encontrados e corrigidos durante a verificação

1. PGlite não criava o diretório pai de `.data/pglite` → servidor não subia na primeira execução.
2. CORS padrão não incluía `http://127.0.0.1:5173` (onde o Vite serve) → preflight 404. Teste adicionado.
3. Card de tema selecionado perdia o destaque sob o mouse (especificidade de `:hover`).
4. Barra de rolagem horizontal espúria no painel lateral.

## O que NÃO foi feito / não verificado

- Shell Tauri não compilado nem executado (falta Rust). Ícones do instalador não gerados.
- Nenhum teste entre dois computadores; nenhum teste com PostgreSQL real (só PGlite).
- Sem medições de CPU/memória — nenhum número de desempenho é afirmado.
- Mute/deafen ainda não controlam áudio (não há áudio até a Etapa 3); o estado já é real e persistido.
- Recuperação por e-mail não existe (decisão: códigos de recuperação).
