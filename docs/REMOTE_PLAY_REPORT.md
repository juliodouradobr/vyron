# Jogar Juntos / Remote Play (VYRON 9.4–9.5)

## Regras de segurança (como foram aplicadas)
- **Assistir não dá controle.** Só o dono da transmissão concede, só para quem já está assistindo, e só
  depois de um pedido explícito (ou oferta explícita dele). O servidor recusa qualquer outra combinação.
- **Permissão por tipo de entrada**: teclado e/ou mouse, marcados um a um. Controle (gamepad) aparece
  desabilitado com o motivo: injetar um controle virtual exige um driver de terceiros que não foi
  integrado.
- **Prazo obrigatório**: 10, 30, 60 ou 120 minutos (servidor aceita 1–120). Expira sozinho.
- **Revogação imediata**: botão "Revogar agora" na sala, "Revogar" fixo no painel de voz e atalho
  **Ctrl+Shift+F12** (no app para Windows, global — funciona com o jogo em primeiro plano).
- **Um controlador por vez.** O controle cai automaticamente se: o anfitrião revogar, o convidado
  devolver, o convidado parar de assistir ou sair da sala, o anfitrião parar a transmissão ou sair,
  o prazo acabar, ou o anfitrião perder a permissão de transmitir.
- **Nada escondido**: todos na sala veem quem controla; o anfitrião vê sempre o aviso e o contador
  de comandos aceitos/bloqueados; o convidado vê uma borda e o selo "CONTROLANDO".
- **Sem contornar o sistema**: entrada via `SendInput` (API oficial), sem elevação; programas rodando
  como administrador não recebem (UIPI) e jogos com anti-cheat podem ignorar — isso é respeitado e
  dito ao anfitrião antes de permitir.

## Arquitetura
1. **Servidor** (autoridade): `play_request` → `PLAY_REQUEST` só para o anfitrião (limite de 1 pedido a
   cada 15 s); `play_grant` / `play_decline` / `play_revoke` / `play_release`; estado
   `stream.control = { guestId, keyboard, mouse, gamepad, grantedAt, expiresAt }` anunciado à sala;
   temporizador de expiração no servidor.
2. **Transporte das entradas**: DataChannel WebRTC negociado (id fixo) na conexão P2P já existente —
   ponta a ponta, criptografado pelo DTLS, sem passar pelo servidor. Ordenado e confiável (soltar
   tecla nunca se perde).
3. **Guarda no anfitrião** (`voice/play/input.ts`), antes de qualquer efeito:
   formato estrito (≤128 bytes, só os campos conhecidos); só de quem o servidor diz que controla, só os
   tipos concedidos, dentro do prazo; bloqueio de Windows, Alt+Tab, Alt+F4, Alt+Esc, Ctrl+Esc,
   Ctrl+Shift+Esc, Ctrl+Alt+Del; limite de taxa (400/s, rajada 200) que nunca barra "soltar";
   acompanha teclas/botões pressionados para soltar tudo ao final.
4. **Aplicação**:
   - **App para Windows** (`src-tauri/src/remote_input.rs`): o anfitrião escolhe a **janela do jogo**
     numa lista; o núcleo só injeta enquanto essa janela estiver em primeiro plano (senão ignora e solta
     o que estava pressionado), confere de novo os tipos e as teclas bloqueadas, usa scan codes (jogos
     costumam lê-los) e mapeia o mouse para a área cliente da janela. Sair do app desarma.
     Capacidades: só os 4 comandos novos; o atalho global é registrado no Rust, sem dar permissão de
     atalhos ao WebView.
   - **Navegador**: uma página não pode (nem deve) controlar o computador. As entradas aprovadas são só
     **exibidas** ao anfitrião num monitor de entradas, e a interface diz isso claramente antes de
     permitir e durante a sessão.
5. **Convidado** (`voice/play/capture.ts`): captura só com "Controlar" ligado, só sobre a imagem (as
   faixas pretas não contam), com o elemento em foco; perder o foco solta tudo do outro lado.
   Posição do mouse normalizada sobre a imagem; repetição de tecla é gerada do lado do anfitrião.

## Testes
- Automatizados: **212 passando** (protocolo 30, desktop 78, servidor 104); typecheck limpo; build OK.
  - Servidor (8 novos): assistir não dá controle; pedido só chega ao anfitrião; conceder anuncia tipos
    e prazo; só o dono concede e só para quem assiste; revogar, devolver, parar de assistir, parar a
    transmissão e sair da sala tiram o controle; expiração automática; ao menos um tipo; prazo fora de
    1–120 fecha a conexão; limite de pedidos; recusa avisa só quem pediu.
  - Cliente (8 novos): formato estrito, autorização/prazo, tipos concedidos, teclas e combinações
    bloqueadas, limite de taxa sem teclas presas, soltar tudo, conversão de ponto com faixas pretas.
- **App completo com duas contas** (navegador, duas abas, sala "Geral"; só a captura de tela foi
  substituída por um canvas): a convidada assistiu (sem controle) → "Pedir para jogar" → o anfitrião
  recebeu o pedido → diálogo (teclado + mouse, 30 min) → "Permitir controle" → indicador fixo no painel
  → a convidada clicou "Controlar" → **13 comandos aceitos** (W, mouse em 25%/50% da imagem, clique),
  **2 bloqueados** (Alt+Tab e tecla Windows) → "Revogar" no painel → a captura da convidada parou
  sozinha e comandos forçados depois disso foram descartados → nova concessão → **Ctrl+Shift+F12**
  revogou na hora.

### Problemas encontrados e corrigidos
- Caixas de aviso com trecho em negrito viravam colunas (o `Banner` era flex com filhos soltos).
  Corrigido no componente: vale para todos os avisos do app.
- Em larguras estreitas, o texto da barra da transmissão virava uma coluna; agora quebra a linha.
- Um teste do servidor olhava um evento antigo do histórico; corrigido (o código estava certo).

## O que NÃO foi testado
- **A injeção real no Windows**: o núcleo nativo (Rust) foi escrito mas **não compilado** — não há
  Rust/Cargo neste ambiente. Pode haver erros de compilação a corrigir (especialmente nas assinaturas
  da crate `windows` 0.58). Nada do controle real foi verificado; precisa de teste em dois PCs.
- Mouse relativo (jogos de tiro com a câmera presa ao mouse): esta versão envia posição absoluta, que
  serve para jogos de estratégia/menus/plataforma, mas não para "mouse look". Exige pointer lock e
  movimento relativo — próximo passo.
- Gamepad: não implementado (ver acima).
- Latência das entradas entre duas máquinas reais.
