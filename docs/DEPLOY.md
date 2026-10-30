# Colocar o VYRON no ar (servidor próprio + app para Windows)

O VYRON tem duas partes:

1. **O servidor** — fica ligado 24 h num computador na internet (um servidor Linux alugado, "VPS").
   Guarda contas, mensagens e arquivos, e conecta as pessoas nas chamadas.
2. **O app para Windows** — o instalador que você e seus amigos instalam. Na primeira vez, cada pessoa
   informa o endereço do servidor na tela de entrada (ex.: `vyron.seudominio.com.br`).

Nada disso depende do ambiente de desenvolvimento nem de assistente nenhum: depois de no ar, roda sozinho.

---

## 1. O que você precisa providenciar

| Item | Para quê | Observação |
|---|---|---|
| **Servidor Linux (VPS)** com IP público | rodar o servidor | Ubuntu 24.04 ou Debian 12; 2 vCPU e 2–4 GB de RAM bastam para começar. Qualquer provedor serve. |
| **Domínio** (ex.: `seudominio.com.br`) | endereço com HTTPS | O certificado HTTPS é gratuito e automático (Let's Encrypt). |
| **Conta no GitHub** | guardar o código e gerar o instalador | O instalador é compilado lá, sem instalar nada no seu PC. |

> Custos (VPS e domínio) dependem do provedor que você escolher.

## 2. Domínio apontando para o servidor

No painel onde você registrou o domínio, crie um registro **DNS do tipo A**:

- Nome: `vyron` (vira `vyron.seudominio.com.br`)
- Valor: o **IP público** do seu VPS

Pode levar alguns minutos para valer.

## 3. Portas liberadas no firewall do VPS

| Porta | Protocolo | Para |
|---|---|---|
| 80 e 443 | TCP | HTTPS (o 80 só é usado para emitir o certificado e redirecionar) |
| 443 | UDP | HTTP/3 (opcional) |
| 3478 | TCP e UDP | TURN/STUN (chamadas atravessando redes restritivas) |
| 49160–49200 | UDP | mídia retransmitida pelo TURN |

O banco de dados e o servidor do VYRON **não** ficam expostos: só o Caddy (HTTPS) e o TURN.

## 4. Instalar o Docker no VPS

Siga o guia oficial para a sua distribuição: <https://docs.docker.com/engine/install/>
(inclui o `docker compose`).

## 5. Colocar o código no VPS

O código precisa estar num repositório Git seu (recomendado: privado no GitHub). No VPS:

```bash
git clone https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git vyron
cd vyron/deploy
cp .env.example .env
```

## 6. Configurar (`deploy/.env`)

Gere duas senhas fortes (rode duas vezes e use uma para cada):

```bash
openssl rand -base64 32
```

Edite o arquivo (`nano .env`) e preencha:

```
DOMAIN=vyron.seudominio.com.br
ACME_EMAIL=seu-email@exemplo.com
POSTGRES_PASSWORD=<primeira senha gerada>
TURN_SECRET=<segunda senha gerada>
```

O `.env` nunca deve ir para o Git (já está no `.gitignore`).

## 7. Subir

```bash
docker compose up -d --build
docker compose logs -f server     # Ctrl+C para sair dos logs
```

Confira no navegador: `https://vyron.seudominio.com.br/api/v1/health` deve mostrar
`{"ok":true,"db":"postgres"}`. Se aparecer erro de certificado nos primeiros minutos, aguarde: o Caddy
está emitindo o certificado.

O servidor cria as tabelas sozinho na primeira vez.

## 8. Gerar o instalador para Windows

1. Envie o código para o seu repositório no GitHub.
2. (Opcional) Em **Settings → Secrets and variables → Actions → Variables**, crie
   `VYRON_SERVER_URL` = `https://vyron.seudominio.com.br`. Assim o app já abre apontando para ele.
3. Em **Actions → Instalador Windows → Run workflow**.
4. Quando terminar (verde), abra a execução e baixe **VYRON-Windows** em *Artifacts*. Dentro há o
   instalador `.exe` (recomendado) e o `.msi`.

O mesmo fluxo roda os testes antes de compilar; se algum falhar, o instalador não é gerado.

### Aviso do Windows (SmartScreen)

O instalador **não tem assinatura digital de código**. Por isso o Windows pode mostrar
"O Windows protegeu o computador". Para instalar: **Mais informações → Executar assim mesmo**.
Para esse aviso sumir é preciso comprar um certificado de assinatura de código e configurá-lo no
fluxo de build — não está incluído.

## 9. Usar

1. Instale o app.
2. Na tela de entrada, clique em **Trocar servidor**, digite `vyron.seudominio.com.br` e **Conectar**
   (o app confere se há um servidor VYRON respondendo ali; exige HTTPS).
3. **Cadastre-se**. Cada pessoa recebe um identificador `Nome#00000` — é por ele que os amigos se
   adicionam.

## 10. Backups (importante)

Na pasta `deploy/` do VPS:

```bash
chmod +x backup.sh
./backup.sh
```

Gera `backups/vyron-DATA.sql.gz` (banco) e `.files.tar.gz` (anexos e avatares), mantendo os 14 mais
recentes. Para rodar todo dia às 4h, adicione ao `crontab -e`:

```
0 4 * * * cd /CAMINHO/vyron/deploy && ./backup.sh >> backups/backup.log 2>&1
```

**Copie os backups para fora do VPS** (se o VPS for perdido, os backups dentro dele também são).

Restaurar o banco num servidor novo:

```bash
gunzip -c backups/vyron-DATA.sql.gz | docker compose exec -T postgres psql -U vyron -d vyron
```

## 11. Atualizar o servidor

```bash
cd vyron && git pull
cd deploy && docker compose up -d --build
```

As migrações de banco rodam sozinhas ao iniciar. Gere um instalador novo pelo GitHub quando o app mudar.

---

## Limites desta versão (para saber antes)

- **Um servidor só**: o estado das salas de voz fica na memória de um processo. Reiniciar o servidor
  derruba as chamadas em andamento (o app reconecta sozinho). Escalar para vários servidores exige Redis
  e um SFU — não incluídos.
- **Chamadas são P2P** (até 8 pessoas por sala): cada pessoa envia o áudio/vídeo direto às outras. O
  TURN só retransmite quando a conexão direta não é possível.
- **TURN sem TLS** (porta 3478): a mídia já é criptografada ponta a ponta pelo WebRTC (DTLS-SRTP);
  TURN em TLS (5349) pode ser adicionado depois.
- **Servidor em casa** em vez de VPS também funciona, mas exige redirecionar as portas do item 3 no
  roteador e, no coturn, informar o IP externo (`--external-ip=IP_PUBLICO/IP_LOCAL` em
  `deploy/docker-compose.yml`).
- **Não testado ainda em produção real**: esta configuração (Docker, Caddy, coturn, Postgres) foi
  escrita e revisada, mas o ambiente onde foi preparada não tinha Docker. O servidor em si foi
  verificado em modo de produção (HTTPS fica a cargo do Caddy). O instalador nunca foi compilado aqui
  (sem Rust): o primeiro build no GitHub é o primeiro teste do núcleo nativo.
- O app só aceita servidores com **HTTPS** (exceto `localhost`, para desenvolvimento).
