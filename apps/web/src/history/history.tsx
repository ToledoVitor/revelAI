import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { AttemptListResponse } from "@revelai/contracts";
import type { createRevelApiClient, RevelApiError } from "../lib/api/client";

type HistoryClient = Pick<
  ReturnType<typeof createRevelApiClient>,
  "deleteAttempt" | "listAttempts"
>;
type HistoryPageParam = string | undefined;
type TrainingHistoryProps = Readonly<{ client: HistoryClient }>;

const historyQueryKey = ["training-history"] as const;

function messageFor(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as RevelApiError).message === "string" &&
    typeof (error as RevelApiError).code === "string" &&
    typeof (error as RevelApiError).retryable === "boolean" &&
    typeof (error as RevelApiError).status === "number"
  ) {
    return (error as RevelApiError).message;
  }
  return "Erro";
}

export function TrainingHistory({ client }: TrainingHistoryProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queryClient = useQueryClient();
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
  const history = useInfiniteQuery({
    queryKey: historyQueryKey,
    initialPageParam: undefined as HistoryPageParam,
    queryFn: ({ pageParam, signal }) =>
      client.listAttempts(pageParam ? { cursor: pageParam } : undefined, {
        signal,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const deleteAttempt = useMutation({
    mutationFn: (id: string) => client.deleteAttempt(id),
    onMutate: () => setDeleteMessage(null),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<
        InfiniteData<AttemptListResponse, HistoryPageParam>
      >(historyQueryKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            items: page.items.filter((attempt) => attempt.id !== id),
          })),
        };
      });
      setDeleteMessage("Treino excluído.");
      headingRef.current?.focus();
    },
  });

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const attempts = history.data?.pages.flatMap((page) => page.items) ?? [];
  const deletingId = deleteAttempt.variables;
  const initialLoadFailed =
    history.isError && !history.isFetchNextPageError && attempts.length === 0;

  return (
    <main
      className="training-history"
      aria-labelledby="training-history-heading"
    >
      <h1 id="training-history-heading" ref={headingRef} tabIndex={-1}>
        Meus treinos neste dispositivo
      </h1>
      {deleteMessage ? <p role="status">{deleteMessage}</p> : null}
      {history.isPending ? <p role="status">Carregando treinos.</p> : null}
      {initialLoadFailed ? (
        <section aria-label="Erro ao carregar treinos">
          <p role="alert">{messageFor(history.error)}</p>
          <button type="button" onClick={() => void history.refetch()}>
            Tentar novamente
          </button>
        </section>
      ) : null}
      {!history.isPending && !initialLoadFailed && attempts.length === 0 ? (
        <p role="status">Nenhum treino neste dispositivo ainda.</p>
      ) : null}
      {attempts.length > 0 ? (
        <section aria-label="Lista de treinos">
          {attempts.map((attempt) => (
            <article key={attempt.id}>
              <h2>
                {attempt.mode === "free"
                  ? "Treino livre"
                  : "Desafio verificado"}
              </h2>
              <p>{attempt.status}</p>
              <time dateTime={attempt.createdAt}>{attempt.createdAt}</time>
              <button
                type="button"
                aria-label={
                  deleteAttempt.isPending && deletingId === attempt.id
                    ? "Excluindo treino"
                    : "Excluir treino"
                }
                disabled={deleteAttempt.isPending}
                onClick={() => deleteAttempt.mutate(attempt.id)}
              >
                {deleteAttempt.isPending && deletingId === attempt.id
                  ? "Excluindo treino"
                  : "Excluir treino"}
              </button>
              {deleteAttempt.isError && deletingId === attempt.id ? (
                <p role="alert">{messageFor(deleteAttempt.error)}</p>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
      {history.hasNextPage ? (
        <section aria-label="Mais treinos">
          {history.isFetchNextPageError ? (
            <p role="alert">{messageFor(history.error)}</p>
          ) : null}
          <button
            type="button"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage
              ? "Carregando mais treinos"
              : history.isFetchNextPageError
                ? "Tentar carregar mais"
                : "Carregar mais treinos"}
          </button>
        </section>
      ) : null}
    </main>
  );
}
