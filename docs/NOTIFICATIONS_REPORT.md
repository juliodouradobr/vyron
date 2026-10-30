# Notificações (VYRON 12)

## O que foi implementado

### Regras (cliente, `src/lib/notify/rules.ts` — funções puras, testadas)
Em ordem:
1. Mensagem sua → nunca avisa.
2. Status **"Não perturbe"** → nenhum aviso e nenhum som (o toque de chamada também fica mudo; o
   cartão da chamada continua aparecendo).
3. App em foco **e** olhando aquele canal → nada.
4. Canal ou servidor **silenciado** → nada (a menção continua contada nos indicadores).
5. Preferências: DMs, menções, pedidos de amizade; servidores seguem o **padrão** ("Só menções",
   "Todas" ou "Nada") ou o ajuste daquele servidor.
- Aviso do sistema só com o app **fora de foco**; com o app aberto em outra conversa, no máximo um som.
- "Mostrar conteúdo das mensagens" desligado → o aviso diz só "Nova mensagem" (útil ao transmitir a
  tela). Ligado, menções aparecem com o nome da pessoa e anexos como "📎 N anexos".

### Preferências (sincronizadas com a conta)
`notifyDesktop`, `notifySounds`, `notifyDms`, `notifyMentions`, `notifyFriendRequests`,
`notifyServerDefault`, `serverNotify` (por servidor), `mutedServers` e `mutedChannels` (até uma data ou
"até eu reativar"; até 200 de cada, validado no servidor; os vencidos são limpos ao salvar).

### Interface
- **Sino no topo da conversa**: silenciar o canal/DM por 15 min, 1 h, 8 h, 24 h ou até reativar; em
  servidores, escolher o que avisar e silenciar o servidor inteiro. Mostra "Silenciado até 22:26".
- **Caixa de entrada** (sino na barra de servidores, com o número de menções não lidas): menções
  recentes com autor, canal, servidor e horário; clicar abre a conversa; "Marcar tudo como lido";
  carregar mais antigas; atalho para pedidos de amizade pendentes.
- **Indicadores**: número de menções não lidas no canal e no ícone do servidor; canais/servidores
  silenciados aparecem esmaecidos e sem destaque de "não lido"; título da janela **"(N) VYRON"**
  (menções + conversas privadas não lidas).
- **Configurações → Notificações**: avisos do sistema, sons, categorias, padrão dos servidores,
  conteúdo nos avisos, bandeja; estado da permissão do navegador com o botão "Permitir avisos" (o app
  **nunca pede a permissão sozinho**) e "Testar aviso".

### Servidor
- `GET /users/@me/mentions`: mensagens que mencionam a pessoa, mais recentes
  primeiro, paginadas — **só de canais que ela pode ver agora** (cada canal passa pela mesma checagem
  de permissão do resto da API; perder acesso tira as menções dali). Índice GIN em `messages.mentions`
  (migração `006_mentions_index.sql`).

### App para Windows
- Comando nativo `notify` (plugin oficial de notificações do Tauri), só com título e corpo limitados;
  o WebView não ganha acesso ao plugin em si. **Compila** (instalador gerado pelo GitHub Actions em 30/10/2026); ainda não testado em uso.
  Limitação conhecida: clicar no aviso nativo ainda não abre a conversa.

## Testes
- Automatizados: **244 passando** (protocolo 33, desktop 88, servidor 123); typecheck limpo; build OK.
  - Regras (9): padrão "só menções", DM, própria mensagem, Não perturbe sem som, foco/canal aberto,
    silenciar com prazo (inclusive vencido), nível por servidor, categorias e sons desligados, corpo
    do aviso com/sem conteúdo, contagem de menções não lidas.
  - Servidor (2): caixa de menções com paginação, sem mencionar a si mesmo, sumindo ao perder acesso
    ao canal, nada para quem é de fora; padrões e validação dos mapas de silenciar (formato e limite).
- **No app, com duas contas**: uma mencionou a outra em #geral → do outro lado chegou o aviso
  "Jogador de Teste em #geral (Clã de Teste)" com "Ei @Amiga de Teste, bora jogar hoje às 21h?", o
  título foi para "(2) VYRON", o sino mostrou 1 e a caixa de entrada listou a menção. Silenciar
  #geral por 1 h pelo sino → nova menção **não** gerou aviso, mas foi contada (título "(3)"). Reativado
  depois. O navegador de desenvolvimento não concede permissão de avisos, então **só** a exibição do
  aviso foi registrada em vez de mostrada; mensagem, regras, contadores e caixa foram os reais.

### Problemas encontrados e corrigidos
- Um ajuste de texto inserido por script perdeu o nome do servidor (`$name` engolido pelo PowerShell)
  no rótulo de servidor silenciado — corrigido.
- "1 menções não lidas" → "1 menção não lida".
- A caixa de entrada mostrava "@…" no lugar do nome mencionado — agora mostra o nome.
- Uma versão intermediária salva durante a edição quebrou a página até recarregar (só no ambiente de
  desenvolvimento com recarga a quente); a versão final foi conferida depois de recarregar.

## Limites
- Aviso nativo do Windows compila, mas não foi testado em uso; o clique nele não leva à conversa.
- Sem "@everyone/@here" (a permissão existe, o recurso ainda não).
- A contagem de menções no início vem das 25 mais recentes; menções mais antigas não lidas não entram
  no número (aparecem ao rolar a caixa de entrada).
- Marcar como lido continua exigindo a janela em foco (comportamento intencional).
- Sem notificações por e-mail ou push no celular (aplicativos móveis ficam para depois).
