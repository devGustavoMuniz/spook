# Relatório dos adicionais (fora do SPEC)

Tudo aqui foi pedido **depois** do checkpoint `checkpoint-spec-completo` (commit `e39b794`, 31/10/2026). A lista bruta sai de
`git log checkpoint-spec-completo..HEAD`. Este arquivo é atualizado a cada adicional e vira o relatório final.

## 1. Supressão de ruído e cancelamento de eco melhores (qualidade de vida)

**Pedido:** "ligar, desligar ou melhorar a supressão de ruído, como o Krisp do Discord, com a melhor alternativa gratuita; cancelamento de
eco para não ouvir a própria voz, ao mostrar a tela ou vazando na call".

**Pesquisa:** o Krisp do LiveKit só existe no LiveKit Cloud pago. As alternativas livres são o RNNoise (BSD-3) e o DeepFilterNet3 (MIT/Apache-2.0).

| Parte | Estado |
| --- | --- |
| Web: 3 níveis de ruído (Desligada, Padrão do navegador, Forte com RNNoise), eco e ganho com interruptores, diálogo de compartilhar tela | Feito |
| Web: DeepFilterNet3 em vez de RNNoise | Não usado: o pacote comunitário depende de CDN de terceiros (403) e não traz WASM/modelo; custo de CPU maior |
| Desktop: nível Forte (RNNoise nativo) e atraso do eco medido em vez de fixo | Em andamento |

**Ressalvas:** a qualidade percebida da voz humana nos três níveis, o CPU em notebook comum e o comportamento real do Chrome com as opções de
compartilhamento só podem ser julgados por você (`VALIDACAO-MANUAL.md`, seção "Adicionais").
