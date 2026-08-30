# RevelAI — relatório de correção documental, sexta passagem

- Data: 2026-08-30
- Escopo: correção do único achado Critical de `revelai-architecture-final.md` (Sol xhigh): ciclo semântico entre G6/C8 e as provas produzidas pelos clientes.
- Resultado: G6 voltou a ser um gate exclusivamente Core/C8; GW e GM carregam as provas de isolamento produzidas por W4 e M5 sem bloquear os próprios produtores. Este arquivo deve permanecer byte a byte igual a `revelAI/docs/reviews/revelai-planning-fix-report.md` para o staging C0.
- Limites respeitados: somente documentação; sem código, dependências, assets, commit ou push.

## Arquivos atualizados

| Arquivo | Correção |
| --- | --- |
| `revelAI/docs/superpowers/plans/2026-08-30-revelai-delivery-dag.md` | Restaura G6 a C8/Fastify, adiciona GW/GM, ajusta Mermaid, ownership e ordem de entrega. |
| `revelAI/docs/superpowers/plans/2026-08-30-revelai-web-client.md` | Declara que a prova de isolamento de W2/W3/W4 é aceita por GW somente após W4. |
| `revelAI/docs/superpowers/plans/2026-08-30-revelai-mobile-client.md` | Declara que a prova de isolamento de M2–M5 é aceita por GM somente após M5. |
| `revelAI/docs/reviews/revelai-planning-fix-report.md` | Espelho interno deste relatório final para C0; remove a alegação de que G6 carrega isolamento de rotas. |

## Contrato de gates sem ciclo

| Gate | Produzido por | Consumidores | Prova |
| --- | --- | --- | --- |
| G6: Public vertical slice | C8 | C9, C10, W1–W5, M1–M5 | Somente Fastify/Core: transporte e media wire/erros exatos, sessões/attempts, Free pipeline, demo verificado não ranqueado sem receipt live, mock ranqueado com `WorkflowBenchmarkReceipt` parseado e guarda transacional de deleção. |
| GW: Web production-tracer isolation | W4 | W5, W6 | W2/W3 omitem `/_test/verified/*` em produção, o artefato Vite/Playwright não monta tela/porta fake e W4 possui o único `/verified` público. W4 não depende de GW. |
| GM: Mobile production-tracer isolation | M5 | M6 | M2/M3/M4 ficam em `review-harness/**` fora do Expo Router, deep links nativos/Expo-web antigos caem em `+not-found`, e M5 possui o único `ProductionVerifiedTracer` em `/verified`. M5 não depende de GM. |

## Topologia corrigida

`C8 → G6 → clientes/Core seguintes` é agora executável somente com evidência do C8. No ramo Web, `W3 → W4 → GW → W5/W6`; no Mobile, `M4 → M5 → GM → M6`. Cada gate de cliente é posterior ao nó que produz a sua evidência e não é pré-requisito do próprio nó nem de qualquer nó Core. As regras detalhadas de isolamento continuam locais em W2/W3/W4 e M2/M3/M4/M5.

## Validações documentais

- Passaram: busca que confirma G6 exclusivamente Core/Fastify; `tsort` do Mermaid sem ciclo; produtores/consumidores de GW/GM estritamente posteriores; alinhamento Mermaid/ledger/prosa; espelho interno byte a byte; whitespace e `git diff --check --no-index`.

## Riscos e próximos gates

1. As provas GW/GM continuam obrigações de implementação e precisam rodar no artefato Vite e nos manifests/linking nativo/Expo-web reais.
2. G6 continua bloqueando clientes até C8 concluir o vertical slice Fastify; isso é intencional e não depende de artefatos dos clientes.
3. Continuam pendentes a importação/aceite A1 e um receipt competitivo live para ativar policy real. O staging C0 segue explícito e limitado a caminhos no repositório.
