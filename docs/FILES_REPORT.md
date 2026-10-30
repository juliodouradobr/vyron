# Anexos, avatares e banners (VYRON 5.2 e 6.x)

## O que foi implementado

### Servidor
- **Armazenamento** atrás de uma interface (`src/files/store.ts`): disco em `FILES_DIR` (padrão
  `apps/server/.data/files`, fora do Git) ou memória nos testes. O nome no disco é sempre o UUID gerado
  pelo servidor, nunca o nome enviado — não há como escapar do diretório. Trocar por armazenamento de
  objetos (S3 compatível) é implementar a mesma interface.
- **Envio** por corpo binário (`application/octet-stream`), sem multipart: menos código analisando
  entrada e limite de tamanho aplicado pelo próprio Fastify.
  - Anexo: `POST /channels/:id/attachments?filename=…` — exige enviar mensagens **e** a permissão
    ATTACH_FILES no canal (em DM, respeita bloqueios). Até **10 MB**; até 30 envios/min e 30 anexos
    pendentes por pessoa.
  - Avatar/banner: `PUT /users/@me/avatar|banner` — só imagem, até **4 MB**. Trocar apaga o anterior;
    `DELETE` remove.
- **Tipo pelo conteúdo, nunca pelo nome** (`src/files/sniff.ts`): PNG, JPEG, GIF, WebP (imagens), MP4,
  WebM, MP3, OGG, WAV, FLAC (mídia), PDF, ZIP, texto UTF-8; o resto vira `application/octet-stream`.
  **SVG e HTML nunca são tratados como imagem ou página** — viram texto para download.
- **Metadados removidos de imagens** antes de guardar: JPEG (EXIF com GPS/aparelho, XMP, IPTC,
  comentários — preservando só a orientação, num EXIF mínimo, para a foto não aparecer deitada), PNG
  (blocos de texto, eXIf, data), WebP (EXIF/XMP, com os bits do cabeçalho ajustados). Imagem
  malformada é recusada. Dimensões são lidas e guardadas.
- **Download sempre com login e permissão** (`GET /files/:id`) — conhecer o id não basta:
  - anexo: só de mensagem em canal que a pessoa pode ver **agora** (perder acesso ao canal corta o
    acesso ao arquivo na hora); anexo ainda não enviado, só para quem enviou;
  - avatar/banner: só os atuais de alguma conta (o anterior deixa de ser servido ao trocar);
  - negado = 404, sem revelar se o arquivo existe.
  - Cabeçalhos: tipo detectado, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`,
    `attachment` para tudo que não é imagem/áudio/vídeo, nome original em UTF-8 (RFC 6266),
    `Cache-Control: private` (nunca em proxies).
- **Mensagens com anexos**: `attachmentIds` (até 10) no envio; o servidor só aceita anexos pendentes
  **da própria pessoa** e **do mesmo canal** — qualquer outro id invalida o envio inteiro. Mensagem
  pode ser só anexo. Excluir a mensagem apaga registros e conteúdo.
- **Limpeza** ao iniciar e a cada 10 min: anexos enviados e não usados em 1 h expiram; conteúdo sem
  registro no banco (sobras) é apagado.
- Migração `005_files.sql` (tabela `files`, `users.avatar_id`, `users.banner_id`).

### Cliente
- Compositor: botão de clipe, **colar** (Ctrl+V com imagem) e **arrastar e soltar**; cada arquivo sobe
  na hora com **barra de progresso**, prévia local de imagens, remover antes de enviar; o botão de
  enviar espera os anexos terminarem. Sem ATTACH_FILES, o botão nem aparece.
- Mensagem: imagens com espaço reservado pela proporção (a lista não "pula"), clique para ampliar e
  baixar; áudio/vídeo só baixam quando a pessoa clica em "Reproduzir"; demais arquivos como cartão com
  nome, tamanho e "Baixar" (salva com o nome original).
- Arquivos são baixados com o token e exibidos por endereço local (`blob:`), com cache limitado em
  memória que é **esvaziado ao sair da conta**.
- Avatar em todos os lugares que mostram uma pessoa (mensagens, membros, amigos, DMs, salas de voz,
  perfil, barra do usuário); banner no perfil e em "Minha conta"; trocar/remover em
  Configurações → Minha conta, com aviso de que os metadados são removidos.

## Testes
- Automatizados: **233 passando** (protocolo 33, desktop 79, servidor 121); typecheck limpo; build OK.
  - Servidor (17 novos): detecção de tipo (inclusive SVG/HTML como texto), dimensões, remoção de
    EXIF/GPS mantendo orientação, PNG/WebP limpos, JPEG malformado recusado, nomes de arquivo seguros;
    envio/anexo/download; quem não vê o canal não baixa (nem sabendo o id) e sem login dá 401; perder
    acesso ao canal corta o arquivo; anexo de outra pessoa/outro canal/já usado é recusado; sem
    ATTACH_FILES; limite de tamanho (413 próprio); excluir mensagem apaga o conteúdo; metadados ausentes
    no que é servido; limpeza de pendentes e órfãos; DM; avatar só imagem, troca invalida o anterior,
    banner, remoção, limite de tamanho.
  - Protocolo (3 novos) e cliente (1 novo).
- **No app, com duas contas**: anexar uma imagem (gerada num canvas, entregue ao campo de arquivo —
  o seletor de arquivos do sistema não abre no navegador de desenvolvimento) → cartão com prévia →
  enviar com legenda → imagem exibida inteira; a outra conta abriu o canal e a imagem carregou
  (640×360) pelo download autenticado. Avatar enviado em Minha conta → apareceu na hora para a própria
  conta e, após recarregar, para a outra (mensagens, membros, sala).

### Problemas encontrados e corrigidos
- Uma consulta SQL inserida por script perdeu o `$1` (o PowerShell interpretou como variável) e
  causava erro 500 ao enviar mensagem com anexo — pego pelos testes, corrigido.
- Imagem anexada aparecia cortada em janelas estreitas (altura fixa); agora o espaço é reservado pela
  proporção e a imagem encolhe inteira.

## Limites e próximos passos
- **Avatar novo não chega em tempo real para as outras pessoas**: elas veem depois de recarregar ou
  reabrir a lista (o evento de atualização de perfil para terceiros ainda não existe — o mesmo vale
  para nome de exibição).
- Sem verificação de vírus/malware nos arquivos: arquivos executáveis podem ser enviados e baixados
  (são sempre servidos como download, nunca executados pelo app). Avalie um antivírus no servidor
  antes de abrir o serviço ao público.
- Sem recorte de avatar na interface: a imagem é centralizada e recortada visualmente em círculo.
- Sem miniaturas geradas no servidor: imagens grandes são baixadas inteiras para exibir.
- GIF mantém metadados de comentário (raros e sem localização).
- Arquivos guardados no disco local do servidor: em produção é preciso disco persistente com backup
  ou armazenamento de objetos.
