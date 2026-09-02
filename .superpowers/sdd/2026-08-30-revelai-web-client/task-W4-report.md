# W4 report — tracer verificado de produção e ranking

## Outcome

W4 foi entregue no commit funcional
`37660acf295b4af0ddc1b9055fca200f773d806c`.

`/verified` é agora o único owner de produção do desafio verificado e da
view de ranking (`/verified?view=ranking`). Home encaminha `Desafio
verificado` para esse owner e a navegação global encaminha `Ranking` para a
mesma rota; `Treino livre` e `Analisar treino` permanecem no boundary
indisponível sem chamada de API. As rotas/fakes W2/W3 continuam DEV/test-only
e não entram no grafo de produção.

O tracer é o único responsável por setup, sessão, tentativa, upload, pending,
terminal e ranking. Ele consome exclusivamente o cliente W1 e contratos já
parseados: não há cálculo local de score, ranking, percentil, elegibilidade ou
motivo de integridade.

## Arquivos funcionais

- `apps/web/src/verified/tracer.tsx`: owner de `/verified`, sequência de
  mutações, polling com backoff e abort, report terminal e leaderboard.
- `apps/web/src/verified/production-capture.tsx`: captura de produção sem
  import/fake de review; countdown, MIME, pré-rolagem, janela ativa, stop,
  fallback de arquivo e limpeza estrita.
- `apps/web/src/app.tsx` e `apps/web/src/home/home.tsx`: navegação de Home e
  Ranking para o único owner.
- `apps/web/src/lib/api/client.ts`: normalização segura de `AbortError` mesmo
  quando o ambiente fornece um `DOMException` que não herda de `Error`.

## Sequência e ownership comprovados

O teste público do tracer fixa esta ordem, corpo e transição visível:

1. A navegação monta `Preparação do desafio verificado`; nenhum `fetch` ocorre
   antes disso.
2. Depois dos gates visíveis `device`, `space`, `athlete`, `rehearsal` e
   `record`, o tracer cria a calibration session com `wall-pass`/versão 1.
3. O estado de readiness é montado e chama `/ready` com os cinco gates na
   ordem exata.
4. A tela de captura é montada antes de criar a tentativa `verified` ligada à
   calibration pronta.
5. O estado de upload é montado antes de enviar exatamente uma parte
   `FormData` chamada `media`. Um erro/abort de attach mantém o mesmo arquivo e
   Attempt para novo envio; um retry terminal começa uma calibration e Attempt
   novos.
6. O `202` somente entra em pending quando attempt e mode são o verified owner;
   um snapshot C2 válido porém pertencente a outro mode/attempt falha fechado e
   não inicia polling.

## Cobertura W4

- `tracer.test.tsx` (20 cenários): ordem e FormData; Demo, Ranked e
  Experimental; Free valid fail-closed; todos os quatro invalid e três failed;
  retry com novas identidades; media route error/retry; abort sem resposta;
  C2 cross-mode; 1/2/4/5 s de polling; foco, visibility, refresh manual,
  coalescing, stale response; leaderboard vazio, erro/retry, cursor, ordem e
  empates.
- `production-capture.test.tsx` (4 cenários): preferência de MIME,
  countdown 5 s + pré-rolagem 4 s + ativo 60 s/stop 64 s, permissões/fallback,
  stop antecipado/erro/blob vazio, e cleanup de tracks/listeners em StrictMode.
- `home.test.tsx`, `app.test.tsx` e `production-router-harness.test.ts`:
  Home/Ranking, uma única rota manifest, navegação direta produzida e zero
  review port/fake/mutação.

## RED → GREEN

1. O primeiro teste público foi criado antes do tracer: `Desafio verificado`
   ainda chegava a `Indisponível`, então o H1 de preparação não existia. A
   rota/owner mínimo tornou esse teste verde antes da sequência completa.
2. A expansão do leaderboard revelou RED real: ao consumir `nextCursor`, a
   segunda página substituía a primeira (recebidos apenas ranks 2/4, esperados
   1/2/2/4). O loader agora acrescenta somente entradas que o servidor já
   ordenou, sem recalcular empate/rank.
3. O teste C2 de snapshot aceito pertencente a outro attempt/mode mostrou que
   o tracer avançava para pending. O guard de ownership tornou a falha segura,
   reteve a captura e impediu `GET result`.
4. O cancelamento que rejeita com `DOMException("AbortError")` inicialmente
   mostrava a mensagem genérica. A normalização estrutural no cliente fez o
   fluxo retornar à captura com arquivo preservado.
5. O teste de unmount StrictMode inicialmente observou zero remoções de
   listeners do recorder. O adapter passou a registrar/remover os três
   listeners (`dataavailable`, `error`, `stop`) antes de stop/unmount.

Os cenários de polling, outcomes, erros e acessibilidade foram então mantidos
como testes públicos do owner; a matriz final focada ficou verde com 101
testes.

## Verificações executadas

| Comando | Resultado |
| --- | --- |
| `rtk pnpm --dir apps/web exec vitest run src/verified/tracer.test.tsx src/verified/production-capture.test.tsx src/home/home.test.tsx src/app.test.tsx src/production-router-harness.test.ts src/lib/api/client.test.ts --config vitest.config.ts` | 6 arquivos, 101 testes verdes |
| `rtk pnpm --dir apps/web run lint` | verde |
| `rtk pnpm --dir apps/web run typecheck` | verde |
| `rtk pnpm --dir apps/web run build` | verde |
| `rtk pnpm --dir apps/web run test` | Node checks 11/11; Vitest 18 arquivos/158 testes; visual estrutural 24 passados, 8 skips previstos |
| `rtk pnpm check` | verde: format, lint, typecheck, todos os pacotes/testes e build |
| `rtk git diff --check` | verde antes do commit funcional |

## Auto-revisão e preocupações

- O production graph continua livre dos módulos, markers e fake ports de
  review; tanto a prova de build quanto o harness produzido continuam verdes.
- O report distingue snapshot congelado do resultado e `Ranking atual` live;
  demo/experimental não inserem campos/cópia competitivos no DOM, e Free nunca
  é renderizado no tracer.
- Não há promessa de notificação após o browser fechar. Estado pending informa
  explicitamente que o servidor continua processando e oferece refresh manual.
- Não há preocupação bloqueadora conhecida. A captura usa APIs físicas de
  câmera/recorder e por isso a matriz unitária controla essas fronteiras com
  mocks; o browser estrutural já passou em desktop e mobile.

## Review fix round — Sol (commit `5f7e665296b6021e7288d44b253017f9187d172b`)

O review independente retornou `CHANGES_REQUIRED`. Este round resolve os
findings sem criar um segundo owner de `/verified`, sem importar componentes
de review pela rota de produção e sem alterar a autoridade dos contratos W1.

### Correções funcionais

- `production-capture.tsx` recebeu uma geração de captura e lifetime montado:
  uma permissão que resolve depois de unmount para imediatamente todos os
  tracks. A ausência de `MediaRecorder` é tratada antes da contagem; o
  fallback por arquivo permanece utilizável e não há page error.
- `capture-media.ts` concentra a ordem exata de candidatos, formatos aceitos,
  normalização wire e os requisitos W3. Review e produção consomem a mesma
  primitiva neutra: MP4/MOV/WebM, dimensões/orientação, janela 5+4+60,
  continuidade e fiduciais. O adaptador de produção preserva fallback de
  câmera traseira, preview, replace/discard, URL cleanup, metadados source
  versus wire e normaliza apenas um WebM de tipo ausente para o wire.
- `setup-model.ts` concentra gates, textos corretivos/status e guidance W2.
  O tracer reintroduz gate bloqueado, recovery, back/cancel, foco a cada gate,
  estado de criação e fallback de vídeo existente antes de qualquer mutação.
  Um erro de `createAttempt` agora mantém a captura indisponível e oferece
  retry da mesma calibration preparada.
- O owner de upload/polling agora usa controller e geração ativos. Ele invalida
  antes de abortar, ignora resposta antiga mesmo quando o transporte ignora o
  sinal e reconcilia cancelamento pós-commit e `duplicate_media_upload` pelo
  Attempt autoritativo. Após `202` limpa a mídia local imediatamente, mostra
  progresso indeterminado acessível e mantém o mesmo Attempt em retry seguro.
  Polling usa request `{ attemptId, generation, controller }`, correlação
  completa de attempt/mode em todos os outcomes, backoff 1/2/4/5, e não deixa
  request abortado de uma geração bloquear a seguinte.
- O report terminal exibe toda a proveniência demo/Roboflow e todos os campos
  do snapshot ranked congelado; percentil e top-percent mantêm explicações
  distintas. Demo/experimental continuam estruturalmente sem ranking. O
  leaderboard live passou a cancelar/coalescer loads por geração, desabilitar
  controles durante loading, ignorar páginas stale e expor `entryId` no nome
  acessível sem mexer na ordenação/empates do servidor.

### RED → GREEN deste round

1. Permissão pendente seguida de unmount produzia `track.stop` zero vezes;
   com o lifetime/generation o teste observa stop imediato. Outro RED sem
   `MediaRecorder` antes dos 5 segundos agora chega ao fallback, sem countdown
   preso.
2. O tracer não tinha fallback W2 de vídeo existente: o novo teste público não
   encontrava o botão. O state `existing-video`, texto compartilhado e gate
   habilitado o deixaram GREEN sem `fetch`.
3. Erro de criação, upload antigo 503 depois de retry, abort pós-commit,
   duplicate upload, resultado de outro Attempt e poll abortado de geração
   velha tiveram testes de corrida públicos antes dos guards. Todos agora
   preservam owner/mídia corretos e falham fechados quando apropriado.
4. Clicks concorrentes no ranking e resposta de página após unmount iniciavam
   mais de um load/atualizavam estado stale; controles disabled, controller e
   generation deixaram essa matriz GREEN. Um `entryId` só em `key` também não
   tinha nome acessível; o item agora o anuncia.
5. As novas asserções RED de snapshot/proveniência, indicador de upload e
   limpeza após `202` passaram depois da renderização explícita dos dados
   parseados, sem inventar campos competitivos.

### Provas e gates do round

| Comando | Resultado |
| --- | --- |
| `rtk pnpm --dir apps/web exec vitest run src/verified/tracer.test.tsx src/verified/production-capture.test.tsx src/verified/capture.test.tsx src/verified/setup.test.tsx src/app.test.tsx src/production-router-harness.test.ts --config vitest.config.ts` | 6 arquivos, 76 testes verdes |
| `rtk pnpm --dir apps/web exec vitest run src/verified/tracer.test.tsx --config vitest.config.ts` | 33 testes verdes |
| `rtk pnpm check` | exit 0: format, lint, typecheck, Node checks, 18 arquivos/175 testes web, browser estrutural, pacotes e build verdes; somente os 8 skips visuais previstos |
| `rtk git diff --check` e `rtk git diff --cached --check` | verdes antes do commit funcional |

Não há preocupação bloqueadora conhecida. O envio via `fetch` não fornece
progresso percentual nativo; por isso o owner expõe progresso indeterminado
acessível enquanto a requisição está ativa, sem prometer percentual que o
transporte não mede. Nenhum push foi feito.

## Re-review round — Sol (commit `e28be0eb45bdb5ce728aebe74bc1283ae9650073`)

O segundo re-review retornou `CHANGES_REQUIRED`. Este round concentra a
reconciliação autoritativa de upload, substitui a simulação restante da rota
pública por câmera real e mede bytes de upload sem alterar o contrato C2.

### Correções funcionais

- `upload-reconciliation.ts` é a única transição pura de outcome de upload:
  `awaiting-upload` retorna à captura e preserva arquivo/Attempt;
  `uploaded`/`processing` descartam mídia e seguem pending; terminais seguem
  para resultado; attempt ou modo divergente falham fechado e preservam mídia.
  Upload normal, cancelamento, resposta duplicada e reconciliação ambígua usam
  essa mesma transição. O GET de reconciliação também é protegido por geração
  de fluxo **e** geração de upload, portanto um GET antigo não substitui um
  retry aceito.
- A rota `/verified` agora monta `ProductionSetupCamera`: solicita a câmera
  real, mostra preview, classifica denied/unsupported/unavailable, mantém
  fallback de vídeo existente e interrompe tracks tanto no cleanup normal
  quanto quando a permissão resolve após unmount. Cópia e controles de
  simulação ficaram exclusivamente no harness de review; os gates, Back,
  foco e ordem W2 foram preservados.
- O cliente usa XHR quando há observador de progresso em produção, mantendo
  `FormData`, identity header, credenciais same-origin, schema C2, decoding de
  erros, abort e geração do owner. O progresso expõe `loaded`/`total` reais e
  o tracer o anuncia com `progress` acessível. O fallback `fetch` permanece
  para chamadas sem observador e para o ambiente de teste.
- A captura de produção expõe exatamente `Enviar vídeo existente` e
  `Tentar novamente`, preservando as garantias W3 já compartilhadas para
  formatos, gravação, retry, preview e metadados wire/source.

### RED → GREEN deste round

1. O cancelamento pré-commit recebia GET `awaiting-upload`, limpava o arquivo
   e abria `Processando tentativa`. O novo teste público falhou assim antes da
   extração da transição; agora volta a captura com o mesmo arquivo/Attempt e
   um novo envio não cria Attempt.
2. A rota pública ainda expunha `Simular câmera pronta`. A asserção RED de
   owner não encontrou uma ativação real; `ProductionSetupCamera` deixa GREEN
   a ativação, retry após denied, fallback e cleanup do stream tardio.
3. O teste C2 com fake XHR inicialmente caía no transporte fetch/MSW e não
   emitia bytes. O adapter agora deixa GREEN `7/11` bytes, `FormData`, header
   de identidade e resposta aceita `202` parseada.
4. Os novos cenários públicos cobrem cancelamento pós-commit, resposta
   `duplicate_media_upload`, falha do primeiro upload após retry aceito e GET
   de cancelamento antigo após o novo envio. Nenhum deles consegue sobrescrever
   a geração atual; pós-commit e duplicado consultam o Attempt autoritativo.
5. A tabela da função pura cobre awaiting-upload, uploaded, processing,
   terminal e mismatch, provando explicitamente preservação/limpeza de mídia
   sem inferir ownership de status.

### Provas e gates do round

| Comando | Resultado |
| --- | --- |
| `rtk pnpm --dir apps/web exec vitest run src/lib/api/client.test.ts src/verified/upload-reconciliation.test.ts src/verified/production-setup-camera.test.tsx src/verified/production-capture.test.tsx src/verified/tracer.test.tsx src/verified/setup.test.tsx src/verified/capture.test.tsx src/app.test.tsx src/production-router-harness.test.ts --config vitest.config.ts` | 9 arquivos, 151 testes verdes |
| `rtk pnpm --dir apps/web run test:production-router` | 5 cenários browser de produção verdes, inclusive sem cópia/controles de simulação |
| `rtk pnpm --dir apps/web run lint` e `rtk pnpm --dir apps/web run typecheck` | verdes |
| `rtk pnpm check` | exit 0: format, lint, typecheck, testes e build de todos os pacotes; web Vitest 20 arquivos/187 testes verdes; visual estrutural 24 passados e 8 skips previstos |
| `rtk git diff --check` e `rtk git diff --cached --check` | verdes antes do commit funcional |

Não há preocupação bloqueadora conhecida. O progresso percentual é usado
somente onde XHR pode observar bytes reais; o owner mantém um estado
indeterminado acessível nos ambientes sem esse observador. Nenhum push foi
feito.

## Re-review round 3 — Sol (commit `acf82c466b747c33fa7226da4ce2ae230a441a79`)

O terceiro re-review identificou dois estados ambíguos: uma câmera já liberada
que ainda parecia pronta após Back, e uma resposta de upload perdida que era
tratada como erro local apesar de o servidor poder ter recebido a mídia.

### Correções funcionais

- O adapter de câmera agora sabe se possuía um stream físico ao encerrar o
  preview. Somente nesse caso o cleanup publica `pending`; streams são parados
  antes da atualização. Assim, Continue desmonta a prévia sem leak e Back
  bloqueia novamente o gate, oferece `Ativar câmera` e vídeo existente e só
  reabilita Continue após preview real novo. O fallback de vídeo existente
  permanece válido ao voltar porque não possui stream para liberar.
- O owner distingue `RevelApiError` (uma resposta HTTP pública e comprovada)
  de falha sem resposta. Abort, duplicidade e qualquer erro não-RouteError
  (incluindo TypeError/XHR error/status 0) consultam o Attempt autoritativo
  usando as mesmas gerações de fluxo e upload. A transição pura existente
  continua decidindo awaiting-upload, uploaded/processing, terminal e
  mismatch. Erro HTTP seguro, como `media_empty`, não dispara GET.
- Se a consulta autoritativa falhar ou ainda indicar `awaiting-upload`, o
  owner preserva arquivo e Attempt na captura para retry. Uma reconciliação
  antiga não altera um upload aceito posterior. O adapter XHR é provado como
  erro de transporte quando não há resposta, sem inventar RouteError.

### RED → GREEN deste round

1. O teste público activate → Continue → Back parou o track uma vez, mas
   encontrava Continue habilitado e não encontrava ativação/fallback. O RED
   confirmou o falso-ready; o cleanup condicionado ao stream tornou o gate,
   foco no H1 e controles GREEN.
2. O teste de upload que rejeita com TypeError pós-commit não encontrava
   `Processando tentativa`: o owner retornava diretamente à captura. Depois da
   classificação de erro sem resposta e GET autoritativo, `processing` limpa a
   mídia e inicia polling GREEN.
3. A matriz adicional cobre GET falho, GET `awaiting-upload`, retry no mesmo
   Attempt, resposta antiga após novo upload, abort já normalizado, duplicado
   e o RouteError HTTP `422 media_empty` sem reconciliação. O seam C2 inclui
   XHR `onerror`/status 0 como TypeError.
4. O browser do artifact de produção cobre a ida e volta do gate com fallback
   sem tráfego `/v1`; a prova unitária mantém a variante de câmera física,
   stream tardio e cleanup.

### Provas e gates do round

| Comando | Resultado |
| --- | --- |
| `rtk pnpm --dir apps/web exec vitest run src/lib/api/client.test.ts src/verified/production-setup-camera.test.tsx src/verified/production-capture.test.tsx src/verified/upload-reconciliation.test.ts src/verified/tracer.test.tsx src/verified/setup.test.tsx src/verified/capture.test.tsx src/app.test.tsx src/production-router-harness.test.ts --config vitest.config.ts` | 9 arquivos, 157 testes verdes |
| `rtk pnpm --dir apps/web run test:production-router` | 6 cenários browser de produção verdes, incluindo Back |
| `rtk pnpm check` | exit 0: format, lint, typecheck, testes e build de todos os pacotes; web Vitest 20 arquivos/193 testes verdes; visual estrutural 24 passados e 8 skips previstos |
| `rtk git diff --check` e `rtk git diff --cached --check` | verdes antes do commit funcional |

Os dez findings anteriores continuam cobertos: owner único `/verified`,
isolamento de review, C2/progresso, cleanup de capture, geração de poll/upload,
leaderboard concorrente e verdade competitiva não foram alterados. Não há
preocupação bloqueadora conhecida e nenhum push foi feito.
