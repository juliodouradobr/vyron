# Relatório — Etapa 4 (Supressão de ruído)

Data: 2026-10-25. Números completos e reproduzíveis em [`NOISE_BENCHMARK.md`](NOISE_BENCHMARK.md)
(`npm run bench:noise -w @nexo/desktop`).

## Escolha do modelo

| Candidato | Licença | Resultado da avaliação |
|---|---|---|
| **RNNoise** (Xiph) via WASM da sapphi-red | BSD-3 / Apache-2.0 / MIT | **Escolhido.** WASM de 153 KB (157 KB SIMD) com a API C pura: instanciado direto, roda no AudioWorklet, no thread principal e no Node. |
| RNNoise via `@shiguredo/rnnoise-wasm` | Apache-2.0 | Descartado: o build só roda em `window`/Web Worker — falha no AudioWorklet e no Node. |
| GTCRN | MIT | Promissor (mais recente), mas o WASM disponível tem API minificada; fica para avaliação futura. |
| Jitsi rnnoise-wasm | sem licença declarada no npm | Descartado por licença. |

Tudo roda localmente. Nenhum áudio é enviado a serviço externo.

## Cadeia de áudio (ordem e motivo)

captura (cancelamento de eco + ganho automático do WebRTC) → **supressão neural** → volume de
entrada → **limitador de picos** → ativação por voz → Opus.
- O eco é removido antes, porque o RNNoise não distingue eco de voz.
- A supressão clássica do WebRTC fica **desligada** nos modos neurais (evita processar o ruído duas
  vezes) e **ligada** no modo Economia.
- Nos modos Desativado/Economia, o nó neural **sai da cadeia**: 0 ms de latência adicionada.
- Limitação honesta: a ordem AGC → supressão vem de a AGC fazer parte da captura do navegador; ela
  não foi comparada por teste com a ordem inversa.

## Modos

| Modo | O que faz |
|---|---|
| Automático (padrão) | Estima a relação fala/ruído e escolhe Equilibrado (< 9 dB), Leve (9–17) ou Natural (≥ 17), com histerese e 3 s mínimos por decisão; recua se a fala começar a ser atenuada. |
| Forte | Rede completa + portão guiado pela detecção de voz entre palavras (fora do Automático: corta mais palavras com muito ruído). |
| Equilibrado | Rede completa. |
| Leve / Natural | Redução limitada a ~18 / ~10 dB (mistura com o sinal original alinhado). |
| Economia | Só a supressão clássica do WebRTC. |
| Desativado | Nenhuma supressão adicional. |

**Proteções:** custo medido no início (acima de 30% de um núcleo → Economia); carga ≥ 50% na thread
de áudio em duas leituras seguidas → Economia automática, com aviso. Escolher outro modo tenta de novo.

## Resultados medidos (fala sintética — ver limitação abaixo)

| Modo | Δ SI-SDR médio | Redução nas pausas | Cortes de palavra |
|---|---|---|---|
| Natural | −0,5 dB | 6,4 dB | 0% |
| Leve | −1,2 dB | 10,1 dB | 8,0% |
| Equilibrado | −1,9 dB | 14,2 dB | 10,5% |
| Forte | −2,0 dB | 15,1 dB | 11,9% |
| **Automático** | **−0,8 dB** | **9,0 dB** | **5,1%** |

- Latência adicionada (medida por correlação): **20 ms** nos modos neurais.
- Custo: **~290–410 µs por 10 ms** no Node (SIMD), **378 µs** no Chromium → ~3–4% de um núcleo.
- No navegador (AudioWorklet real): ruído branco **−24,8 → −59,8 dBFS** (Equilibrado), Desativado intacto.
- Com SNR baixa os modos neurais **melhoram** o SI-SDR (até +9 dB); com SNR alta, **pioram**, porque
  a rede distorce mais do que limpa. Esse achado definiu o critério do Automático.

### Bugs e erros de projeto encontrados pela bancada (e corrigidos)
1. Métrica de "cortes" sem o mesmo ganho de normalização na referência (falso 90% de cortes).
2. Automático decidindo pelo nível **absoluto** do ruído — escolhia processamento forte em ambiente limpo.
3. Média de níveis em dB subestimava a SNR (desigualdade de Jensen) → médias em potência.
4. Proteção de inteligibilidade contava ruído removido como "fala perdida".
5. O Forte cortava até 38% dos quadros de fala com muito ruído → removido do Automático.

## Testes
- 5 testes do núcleo (passagem exata no Desativado, sem NaN/saturação ao trocar de modo, blocos
  irregulares, portão sem cliques) + **regressão** contra a linha de base: falha se uma mudança
  piorar SI-SDR (> 0,5 dB), cortes (> 2 p.p.) ou redução (> 1 dB).
- Total do projeto: **153/153** · `tsc` e `vite build` ok.

## Limitações reais (não escondidas)
- **Fala sintética.** O RNNoise foi treinado com fala real; os números medem o comportamento da cadeia
  e pegam regressões, não a qualidade percebida. Próximo passo: bases reais (VCTK + DEMAND, CC BY 4.0
  — preciso da sua permissão para baixar) e avaliação com ouvintes; o A/B no app já permite isso.
- **Não testado com microfone real** (o painel desta sessão bloqueia a captura).
- O RNNoise **não remove** conversas/TV ao fundo (é fala) e não remove reverberação; transientes
  (teclado, cliques) são reduzidos só parcialmente (~8 dB na bancada).
- A carga é medida com `Date.now()` (o AudioWorklet não tem `performance.now`): detecta bem
  sobrecarga séria, não variações pequenas.
