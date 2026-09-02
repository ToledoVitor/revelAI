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
