# W3 report — captura verificada de revisão

## Outcome

W3 foi entregue inicialmente no commit funcional
`17c38c30eb88ef7cb61d521ecb6dfa87858cfd1f`. O round de revisão Sol foi
resolvido no commit funcional `1b2f761939a7d5022369c043518706ce46e0a3fe`.

O cliente agora oferece `/_test/verified/capture` somente em DEV/teste. A tela
de revisão orienta a gravação do passe na parede, grava localmente quando o
navegador oferece um formato aceito, aceita vídeo existente, monta o `FormData`
C2 exato e simula preparação, progresso, cancelamento, retry e erros seguros.
Ela não cria tentativa, sessão de calibração, upload de produção nem chama
`/v1/*`.

Em build de produção a rota de captura, o módulo, a fake port e seus marcadores
de avaliação ficam fora do grafo e do artefato; a URL direta e a navegação
in-app continuam na fronteira normal de indisponibilidade. As garantias W2
continuam cobrindo setup e agora também captura.

## Arquivos funcionais

- `apps/web/src/verified/capture.tsx`: UI/adapter de captura no navegador,
  estados limitados do contrato, ciclo do `MediaRecorder`, limpeza e fake port
  local de upload.
- `apps/web/src/verified/capture.test.tsx`: testes públicos da captura,
  upload e recuperação (12 casos).
- `apps/web/src/verified/capture-route.test.tsx`: rota DEV/teste sem mutação
  real.
- `apps/web/src/app.tsx`: lazy route protegida pelo mesmo
  `reviewRoutesEnabled` de W2, sem segunda flag.
- `apps/web/src/app.test.tsx`,
  `apps/web/src/production-router-harness.test.ts` e
  `apps/web/src/test/production-router-harness.tsx`: prova de que os módulos
  setup/capture não entram no router transformado de produção e que as duas
  fake ports nunca são chamadas.
- `apps/web/scripts/assert-production-router-artifact.mjs` e
  `apps/web/src/visual/production-route-isolation.visual.spec.ts`: varredura
  do artefato e prova Playwright servido para as duas rotas, tanto direta como
  in-app.
- `apps/web/src/visual/review-capture-lazy-import.visual.spec.ts`: smoke DEV
  do import lazy da captura, sem erro de console nem resposta 4xx do módulo.
- `apps/web/src/styles.css`: estilo responsivo da tela de revisão, preservando
  os tokens e foco existente.

## RED → GREEN

1. Criei primeiro o teste público da rota de captura. Ele falhou porque
   `/_test/verified/capture` resolvia a fronteira `Indisponível` e o heading
   `Captura para passe na parede` não existia. Após registrar o lazy import
   sob a guarda W2, ficou verde.
2. Criei em seguida a bateria de comportamento da captura antes da
   implementação completa. Contra o esqueleto inicial, os oito cenários
   falharam por ausência dos requisitos/controles e do ciclo de captura.
   A implementação mínima seguinte tornou a bateria verde e foi expandida para
   12 cenários: cronômetro 5+4+60, MIME, permissões, fallback, parada precoce,
   erro/Blob vazio, C2, cancelamento, retry, progresso e descarte/URLs.
3. O primeiro teste de erro/Blob vazio expôs uma espera indevida do próprio
   harness ao misturar remount com fake timers; a correção fez a recuperação
   acontecer no mesmo componente e manteve o cenário em tempo falso. Nenhuma
   lógica de produção foi relaxada para tornar o teste verde.
4. A cobertura final tornou a etapa de preparação indeterminada observável
   antes de emitir o progresso por bytes, eliminando uma atualização síncrona
   que poderia mascarar essa transição no teste.

## Verificações executadas

| Comando | Resultado |
| --- | --- |
| `rtk pnpm --filter @revelai/web exec vitest run src/app.test.tsx src/production-router-harness.test.ts src/verified/setup.test.tsx src/verified/capture-route.test.tsx src/verified/capture.test.tsx --config vitest.config.ts` | 5 arquivos, 29 testes verdes |
| `rtk pnpm --filter @revelai/web exec vitest run src/verified/capture.test.tsx --config vitest.config.ts` | 12 testes verdes |
| `rtk pnpm --filter @revelai/web run lint` | verde |
| `rtk pnpm --filter @revelai/web run typecheck` | verde |
| `rtk pnpm --filter @revelai/web run build` | verde |
| `rtk pnpm --filter @revelai/web run build:production-router` | artefato limpo gerado; sem chunk/marcador setup ou capture |
| `rtk pnpm --filter @revelai/web run test:production-router` | 4 testes Playwright verdes (setup/capture, URL direta/in-app) |
| `rtk pnpm --filter @revelai/web run test:visual:structural:run` | 22 passados, 8 skips estruturais previstos; smoke DEV da captura passou em desktop e mobile, sem console/4xx |
| `rtk pnpm --filter @revelai/web run test` | 16 arquivos Vitest / 127 testes verdes, checks de build limpo e suíte visual estrutural verdes |
| `rtk pnpm check` | format, lint, typecheck, testes e build de todos os pacotes verdes |
| `rtk git diff --check` | verde antes do commit funcional |

## Auto-revisão contra o brief

- A única condição de rota é a exportação W2 intacta:
  `reviewRoutesEnabled = import.meta.env.DEV || import.meta.env.MODE === "test"`.
  Não há override de produção, flag alternativa ou rota de produção.
- A captura solicita a câmera traseira por preferência, anuncia fallback de
  câmera não traseira e deixa vídeo existente disponível para permissão negada,
  câmera ausente ou MIME sem suporte. A ordem dos cinco candidatos,
  nome/extensão/MIME declarado e a ausência de construção do recorder no
  fallback são testados.
- O asset gravado somente se torna elegível após parada automática aos 64 s de
  tempo do recorder. Parada antecipada, erro e Blob vazio descartam o asset;
  tracks, listeners, timers e URLs de preview são limpos em erro, descarte,
  unmount e handoff aceito.
- A orientação mostra extensões/MIME, limite importado de 250 MiB, geometria,
  duração e pré-rolagem, sem prometer certificação do navegador nem expor
  limiares privados.
- O `FormData` é criado da fixture C2 aceita tipada como
  `MediaUploadFormDataRequestDescriptor`, contém uma única parte `media` e
  usa somente mapeamentos seguros de fixtures C2 rejeitadas. Não renderiza
  path local/servidor, payload bruto ou mensagem bruta de erro.
- A fake port é local e injetável para teste. A rota direta tem spy de `fetch`
  zerado; as provas graph/harness/artifact/Playwright confirmam que em produção
  nem setup nem capture avaliam módulo/fake port ou fazem `/v1/*`.

## Preocupações remanescentes

Nenhuma bloqueadora. A conclusão de upload deliberadamente é local e deixa
qualquer criação de sessão/tentativa, upload real, polling, resultado e decisão
de integridade para W4, conforme a fronteira de ownership do plano.

## Round de revisão Sol — CHANGES_REQUIRED → resolvido

O review reproduziu cinco regressões públicas em `capture.test.tsx`: preview
sem autoplay, metadados de arquivo vazio falsificados, upload bloqueado pelo
cleanup do primeiro effect em `StrictMode`, fake upload padrão síncrono sem
janela para cancelar e controles de troca/descarte ainda ativos durante upload.
Um segundo RED no navegador DEV real verificou que o vídeo tinha `srcObject` e
`autoplay`, mas permanecia com `paused: true`.

A correção preserva as fronteiras W2/W3 e acrescenta:

- lifetime seguro em replay de `StrictMode`: cada setup restaura o indicador de
  montagem; cleanup invalida a geração de upload e aborta o controlador ativo;
- preview de câmera com `autoPlay`, `muted`, `playsInline` e chamada a `play()`
  com rejeição tratada;
- fake port em três fases assíncronas de 250 ms, canceláveis por `AbortSignal`
  e controláveis pelos timers falsos de Vitest;
- exclusão mútua durante upload, geração/controlador por upload e descarte de
  callbacks/resultados tardios após cancelamento; a confirmação aceita retorna
  a captura para `idle` e mensagem coerente;
- liberação dos chunks depois de materializar o `Blob`, em erro, handoff
  aceito, descarte, nova captura/seleção e unmount;
- separação entre tipo declarado pelo arquivo e MIME normalizado do wire. A UI
  conserva nome/tamanho/tipo original, declara ausência de tipo quando vazia e
  exibe bytes exatos; somente o `File` no `FormData` é normalizado;
- harness de router de produção que limpa e exige `undefined` tanto para os
  marcadores de setup quanto de capture.

### RED → GREEN da revisão

1. A bateria pública expandida chegou a 5 falhas em 17 casos antes da
   implementação: faltavam a janela de preparação/cancelamento, exclusão mútua
   de controles, metadata fiel, e o lifetime correto em `StrictMode`.
2. O teste Playwright DEV injetou um `MediaStream` de canvas, mediu
   `{ autoplay: true, hasStream: true, paused: true }` em RED e depois ficou
   verde com `paused: false`, além de verificar cancelamento do fake local.
3. Em GREEN, 17 testes de captura e 4 do harness passaram; a matriz focada de
   rota/router/setup/capture ficou em 34 testes verdes. O browser estrutural
   passou nos dois viewports e a rota produzida preservou 4/4 fronteiras
   indisponíveis.

### Verificações após a revisão

| Comando | Resultado |
| --- | --- |
| `rtk pnpm --filter @revelai/web exec vitest run src/app.test.tsx src/production-router-harness.test.ts src/verified/setup.test.tsx src/verified/capture-route.test.tsx src/verified/capture.test.tsx --config vitest.config.ts` | 5 arquivos, 34 testes verdes |
| `rtk pnpm --filter @revelai/web run lint` e `rtk pnpm --filter @revelai/web run typecheck` | verdes |
| `rtk pnpm --filter @revelai/web run test:visual:structural:run` | 24 passados, 8 skips estruturais previstos; teste DEV real de StrictMode verde em desktop e mobile |
| `rtk pnpm --filter @revelai/web run build` | verde |
| `rtk pnpm --filter @revelai/web run build:production-router` e `rtk pnpm --filter @revelai/web run test:production-router` | verde; 4 testes Playwright de setup/capture, URL direta/in-app |
| `rtk pnpm check` | exit 0: format, lint, typecheck, todos os testes e builds de todos os pacotes |
| `rtk git diff --check` | verde antes do commit funcional |
