# Bancada de supressão de ruído

Gerado por `npm run bench:noise -w @nexo/desktop` em 2026-10-25.
Máquina: Intel(R) Core(TM) i5-8265U CPU @ 1.60GHz · Node v24.20.0 · win32 10.0.26200. Execução: 83.5 s.

> **Limitação importante:** a fala é **sintética** (formantes), não gravações reais. O RNNoise foi
> treinado com fala real, então os números indicam o comportamento da cadeia e servem para
> detectar regressões — não são uma medida de qualidade perceptual. Para isso: o A/B
> "original × processado" nas configurações (com sua própria voz) e, no futuro, bases reais
> (ex.: VCTK + DEMAND, CC BY 4.0) e avaliação com ouvintes.

## Custo de processamento (medido)

| Variante | µs por quadro de 10 ms | % de um núcleo |
|---|---|---|
| RNNoise SIMD — Equilibrado | 290.3 | 2.9% |
| RNNoise SIMD — Forte (com portão) | 287.5 | 2.87% |
| RNNoise sem SIMD — Equilibrado | 409 | 4.09% |

Latência adicionada pelos modos neurais (medida por correlação): 20 ms.
Desativado/Economia: o nó sai da cadeia (0 ms adicionais).

## Resumo por modo (média de 15 condições)

| Modo | Δ SI-SDR médio | Redução média nas pausas | Nível médio da fala | Cortes médios |
|---|---|---|---|---|
| Desativado | 0.0 dB | 0.0 dB | 0.0 dB | 0.0% |
| Natural | -0.5 dB | 6.4 dB | -1.1 dB | 0.0% |
| Leve | -1.2 dB | 10.1 dB | -1.3 dB | 8.0% |
| Equilibrado | -1.9 dB | 14.2 dB | -1.4 dB | 10.5% |
| Forte | -2.0 dB | 15.1 dB | -1.4 dB | 11.9% |
| Automático | -0.8 dB | 9.0 dB | -1.3 dB | 5.1% |

Leitura: **Δ SI-SDR** maior = saída mais próxima da fala limpa. **Redução nas pausas** = quanto ruído
some quando ninguém fala. **Nível da fala** perto de 0 dB = voz preservada. **Cortes** = % de quadros
de fala que ficaram mais de 10 dB abaixo do original (palavras "comidas").

## Resultados completos

| Ruído | SNR | Modo | SI-SDR entrada | SI-SDR saída | Δ SI-SDR | Redução nas pausas | Nível da fala | Cortes de palavra | Latência |
|---|---|---|---|---|---|---|---|---|---|
| white | 0 dB | Desativado | -2.2 | -2.2 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| white | 0 dB | Natural | -2.2 | 4.9 | +7.1 | 9.7 dB | -2.7 dB | 0% | 20 ms |
| white | 0 dB | Leve | -2.2 | 7.1 | +9.3 | 16.8 dB | -3.1 dB | 7.6% | 20 ms |
| white | 0 dB | Equilibrado | -2.2 | 7.1 | +9.3 | 27.5 dB | -3.2 dB | 13.4% | 20 ms |
| white | 0 dB | Forte | -2.2 | 7 | +9.1 | 28.6 dB | -3.3 dB | 15.1% | 20 ms |
| white | 0 dB | Automático | -2.2 | 6.1 | +8.3 | 13.4 dB | -3 dB | 6.7% | 20 ms |
| white | 10 dB | Desativado | 7.8 | 7.9 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| white | 10 dB | Natural | 7.8 | 10.6 | +2.8 | 9.4 dB | -0.8 dB | 0% | 20 ms |
| white | 10 dB | Leve | 7.8 | 9.6 | +1.7 | 16 dB | -0.9 dB | 6.1% | 20 ms |
| white | 10 dB | Equilibrado | 7.8 | 8.5 | +0.7 | 24.5 dB | -0.9 dB | 8.7% | 20 ms |
| white | 10 dB | Forte | 7.8 | 8.4 | +0.5 | 26.5 dB | -0.9 dB | 9% | 20 ms |
| white | 10 dB | Automático | 7.8 | 9.6 | +1.7 | 16 dB | -0.9 dB | 6.1% | 20 ms |
| white | 20 dB | Desativado | 17.8 | 17.9 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| white | 20 dB | Natural | 17.8 | 12 | -5.8 | 9 dB | -0.5 dB | 0% | 20 ms |
| white | 20 dB | Leve | 17.8 | 9.8 | -8 | 14.8 dB | -0.6 dB | 11.3% | 20 ms |
| white | 20 dB | Equilibrado | 17.8 | 8.5 | -9.4 | 21.1 dB | -0.6 dB | 12.5% | 20 ms |
| white | 20 dB | Forte | 17.8 | 8.4 | -9.5 | 23.6 dB | -0.6 dB | 12.8% | 20 ms |
| white | 20 dB | Automático | 17.8 | 12 | -5.8 | 9 dB | -0.5 dB | 0% | 20 ms |
| pink | 0 dB | Desativado | -2.2 | -2.2 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| pink | 0 dB | Natural | -2.2 | 3 | +5.2 | 9.5 dB | -3.3 dB | 0% | 20 ms |
| pink | 0 dB | Leve | -2.2 | 4.2 | +6.5 | 16.1 dB | -4 dB | 11.9% | 20 ms |
| pink | 0 dB | Equilibrado | -2.2 | 4.1 | +6.3 | 24 dB | -4.3 dB | 21.8% | 20 ms |
| pink | 0 dB | Forte | -2.2 | 2.8 | +5 | 24.2 dB | -4.6 dB | 38.7% | 20 ms |
| pink | 0 dB | Automático | -2.2 | 3.6 | +5.9 | 13.4 dB | -3.8 dB | 9.3% | 20 ms |
| pink | 10 dB | Desativado | 7.9 | 7.9 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| pink | 10 dB | Natural | 7.9 | 9.7 | +1.8 | 9.4 dB | -0.8 dB | 0% | 20 ms |
| pink | 10 dB | Leve | 7.9 | 8.6 | +0.7 | 15.9 dB | -0.9 dB | 10.2% | 20 ms |
| pink | 10 dB | Equilibrado | 7.9 | 7.5 | -0.4 | 24.5 dB | -1 dB | 11.6% | 20 ms |
| pink | 10 dB | Forte | 7.9 | 7.4 | -0.4 | 25.9 dB | -1 dB | 11.9% | 20 ms |
| pink | 10 dB | Automático | 7.9 | 8 | +0.2 | 17.4 dB | -1 dB | 10.5% | 20 ms |
| pink | 20 dB | Desativado | 17.8 | 17.9 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| pink | 20 dB | Natural | 17.8 | 11.6 | -6.3 | 9.2 dB | -0.6 dB | 0% | 20 ms |
| pink | 20 dB | Leve | 17.8 | 9.4 | -8.4 | 15.4 dB | -0.6 dB | 13.1% | 20 ms |
| pink | 20 dB | Equilibrado | 17.8 | 8.2 | -9.7 | 22.8 dB | -0.6 dB | 13.7% | 20 ms |
| pink | 20 dB | Forte | 17.8 | 8.1 | -9.7 | 25.6 dB | -0.6 dB | 13.7% | 20 ms |
| pink | 20 dB | Automático | 17.8 | 10.3 | -7.5 | 10.9 dB | -0.6 dB | 6.7% | 20 ms |
| fan | 0 dB | Desativado | -2.2 | -2.2 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| fan | 0 dB | Natural | -2.2 | 0 | +2.3 | 6.2 dB | -2 dB | 0% | 20 ms |
| fan | 0 dB | Leve | -2.2 | 0.4 | +2.6 | 8.8 dB | -2.4 dB | 6.1% | 20 ms |
| fan | 0 dB | Equilibrado | -2.2 | 0.4 | +2.6 | 10.6 dB | -2.6 dB | 11% | 20 ms |
| fan | 0 dB | Forte | -2.2 | 0.4 | +2.6 | 10.6 dB | -2.6 dB | 11% | 20 ms |
| fan | 0 dB | Automático | -2.2 | 0.4 | +2.6 | 10.6 dB | -2.6 dB | 11% | 20 ms |
| fan | 10 dB | Desativado | 7.9 | 7.9 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| fan | 10 dB | Natural | 7.9 | 8.2 | +0.3 | 7.6 dB | -0.8 dB | 0% | 20 ms |
| fan | 10 dB | Leve | 7.9 | 7.1 | -0.7 | 11.4 dB | -0.9 dB | 12.5% | 20 ms |
| fan | 10 dB | Equilibrado | 7.9 | 6.4 | -1.4 | 14.2 dB | -0.9 dB | 13.4% | 20 ms |
| fan | 10 dB | Forte | 7.9 | 6.4 | -1.5 | 14.5 dB | -0.9 dB | 13.4% | 20 ms |
| fan | 10 dB | Automático | 7.9 | 6.4 | -1.4 | 14.2 dB | -0.9 dB | 13.4% | 20 ms |
| fan | 20 dB | Desativado | 17.8 | 17.9 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| fan | 20 dB | Natural | 17.8 | 11.4 | -6.4 | 8.4 dB | -0.6 dB | 0% | 20 ms |
| fan | 20 dB | Leve | 17.8 | 9.3 | -8.5 | 13.3 dB | -0.6 dB | 12.5% | 20 ms |
| fan | 20 dB | Equilibrado | 17.8 | 8.1 | -9.8 | 18.1 dB | -0.6 dB | 13.4% | 20 ms |
| fan | 20 dB | Forte | 17.8 | 8 | -9.8 | 19 dB | -0.6 dB | 13.4% | 20 ms |
| fan | 20 dB | Automático | 17.8 | 10.2 | -7.6 | 9.8 dB | -0.6 dB | 6.1% | 20 ms |
| keyboard | 0 dB | Desativado | -2.2 | -2.2 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| keyboard | 0 dB | Natural | -2.2 | 1.4 | +3.6 | 5.1 dB | -1.5 dB | 0% | 20 ms |
| keyboard | 0 dB | Leve | -2.2 | 2.2 | +4.4 | 6.8 dB | -1.8 dB | 1.7% | 20 ms |
| keyboard | 0 dB | Equilibrado | -2.2 | 2.6 | +4.8 | 7.8 dB | -2 dB | 3.5% | 20 ms |
| keyboard | 0 dB | Forte | -2.2 | 2.8 | +5 | 8.6 dB | -2 dB | 4.4% | 20 ms |
| keyboard | 0 dB | Automático | -2.2 | 2 | +4.2 | 6.4 dB | -1.8 dB | 0.9% | 20 ms |
| keyboard | 10 dB | Desativado | 7.9 | 7.9 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| keyboard | 10 dB | Natural | 7.9 | 9.2 | +1.3 | 4.5 dB | -0.6 dB | 0% | 20 ms |
| keyboard | 10 dB | Leve | 7.9 | 8.6 | +0.7 | 5.8 dB | -0.7 dB | 6.1% | 20 ms |
| keyboard | 10 dB | Equilibrado | 7.9 | 8 | +0.2 | 6.6 dB | -0.7 dB | 7% | 20 ms |
| keyboard | 10 dB | Forte | 7.9 | 8.1 | +0.2 | 7.6 dB | -0.7 dB | 7.6% | 20 ms |
| keyboard | 10 dB | Automático | 7.9 | 9 | +1.1 | 5.1 dB | -0.7 dB | 2% | 20 ms |
| keyboard | 20 dB | Desativado | 17.8 | 17.8 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| keyboard | 20 dB | Natural | 17.8 | 12.6 | -5.2 | 5.2 dB | -0.5 dB | 0% | 20 ms |
| keyboard | 20 dB | Leve | 17.8 | 10.6 | -7.3 | 6.9 dB | -0.6 dB | 4.1% | 20 ms |
| keyboard | 20 dB | Equilibrado | 17.8 | 9.4 | -8.5 | 7.9 dB | -0.6 dB | 6.7% | 20 ms |
| keyboard | 20 dB | Forte | 17.8 | 9.4 | -8.5 | 8.7 dB | -0.7 dB | 6.7% | 20 ms |
| keyboard | 20 dB | Automático | 17.8 | 11.8 | -6 | 5.4 dB | -0.6 dB | 3.2% | 20 ms |
| babble | 0 dB | Desativado | -2 | -2 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| babble | 0 dB | Natural | -2 | -2.1 | -0.1 | 1.2 dB | -1 dB | 0% | 20 ms |
| babble | 0 dB | Leve | -2 | -2.4 | -0.4 | 1.4 dB | -1.1 dB | 1.7% | 20 ms |
| babble | 0 dB | Equilibrado | -2 | -2.6 | -0.6 | 1.4 dB | -1.2 dB | 2% | 20 ms |
| babble | 0 dB | Forte | -2 | -2.6 | -0.6 | 1.4 dB | -1.2 dB | 2% | 20 ms |
| babble | 0 dB | Automático | -2 | -2.1 | -0.1 | 1.2 dB | -1 dB | 0% | 20 ms |
| babble | 10 dB | Desativado | 8.1 | 8.1 | 0 | 0 dB | 0 dB | 0% | 20 ms |
| babble | 10 dB | Natural | 8.1 | 6.9 | -1.2 | 1 dB | -0.6 dB | 0% | 20 ms |
| babble | 10 dB | Leve | 8.1 | 6.1 | -2 | 1.1 dB | -0.7 dB | 4.9% | 20 ms |
| babble | 10 dB | Equilibrado | 8.1 | 5.5 | -2.6 | 1.1 dB | -0.7 dB | 6.1% | 20 ms |
| babble | 10 dB | Forte | 8.1 | 5.5 | -2.6 | 1.1 dB | -0.7 dB | 6.1% | 20 ms |
| babble | 10 dB | Automático | 8.1 | 6.7 | -1.4 | 1 dB | -0.6 dB | 0.3% | 20 ms |
| babble | 20 dB | Desativado | 18.1 | 18.2 | 0 | 0.1 dB | 0 dB | 0% | 20 ms |
| babble | 20 dB | Natural | 18.1 | 11.4 | -6.8 | 0.8 dB | -0.5 dB | 0% | 20 ms |
| babble | 20 dB | Leve | 18.1 | 9.4 | -8.7 | 0.9 dB | -0.6 dB | 10.5% | 20 ms |
| babble | 20 dB | Equilibrado | 18.1 | 8.2 | -9.9 | 1 dB | -0.6 dB | 12.2% | 20 ms |
| babble | 20 dB | Forte | 18.1 | 8.2 | -9.9 | 1 dB | -0.6 dB | 12.2% | 20 ms |
| babble | 20 dB | Automático | 18.1 | 11.4 | -6.8 | 0.8 dB | -0.5 dB | 0% | 20 ms |
