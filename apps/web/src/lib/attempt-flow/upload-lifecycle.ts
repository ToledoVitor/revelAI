import type { AttemptMode, AttemptOutcome } from "@revelai/contracts";
import { useCallback, useEffect, useRef } from "react";
import type {
  RevelApiAbort,
  RevelApiError,
  RevelApiUploadProgress,
} from "../api/client";
import { isAmbiguousUploadError } from "./upload-reconciliation";

type AttemptRead = Readonly<{
  id: string;
  mode: AttemptMode;
  outcome: AttemptOutcome;
}>;
type UploadAccepted = Readonly<{
  attemptId: string;
  mode: AttemptMode;
  outcome: AttemptOutcome;
}>;

type UploadClient = Readonly<{
  uploadAttemptMedia(
    attemptId: string,
    media: File,
    options: Readonly<{
      signal: AbortSignal;
      onProgress(progress: RevelApiUploadProgress): void;
    }>,
  ): Promise<UploadAccepted>;
  getAttempt(
    attemptId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AttemptRead>;
}>;

type ActiveRequest = Readonly<{
  attemptId: string;
  generation: number;
  uploadGeneration: number;
  controller: AbortController;
}>;

export type UploadReconcileRequest = Readonly<{
  attemptId: string;
  generation: number;
  uploadGeneration: number;
  fallbackMessage: string;
}>;

type AttemptUploadLifecycleInput = Readonly<{
  enabled: boolean;
  attemptId?: string;
  media?: File;
  expectedMode: AttemptMode;
  generation: number;
  uploadGeneration: number;
  client: UploadClient;
  isGenerationCurrent(generation: number, uploadGeneration: number): boolean;
  isAbort(error: unknown): error is RevelApiAbort;
  isRouteError(error: unknown): error is RevelApiError;
  hasRouteErrorCode(error: unknown, code: RevelApiError["code"]): boolean;
  errorMessage(error: unknown): string;
  onProgress(progress: RevelApiUploadProgress | undefined): void;
  onOutcome(outcome: AttemptOutcome, attemptId: string): void;
  onMismatch(): void;
  onError(message: string): void;
}>;

/**
 * Neutral upload owner for every Attempt mode. It makes XHR/fetch progress,
 * cancellation, duplicate/lost-response reconciliation, and generation
 * invalidation one lifecycle rather than two feature-specific copies.
 */
export function useAttemptUploadLifecycle(input: AttemptUploadLifecycleInput) {
  const inputRef = useRef(input);
  inputRef.current = input;
  const activeUploadRef = useRef<ActiveRequest | undefined>(undefined);
  const activeReconciliationRef = useRef<AbortController | undefined>(
    undefined,
  );

  const isCurrent = useCallback((request: ActiveRequest) => {
    const latest = inputRef.current;
    return (
      !request.controller.signal.aborted &&
      activeUploadRef.current === request &&
      latest.attemptId === request.attemptId &&
      latest.generation === request.generation &&
      latest.uploadGeneration === request.uploadGeneration &&
      latest.isGenerationCurrent(request.generation, request.uploadGeneration)
    );
  }, []);

  const reconcile = useCallback(async (request: UploadReconcileRequest) => {
    const current = inputRef.current;
    activeReconciliationRef.current?.abort();
    const controller = new AbortController();
    activeReconciliationRef.current = controller;
    try {
      const attempt = await current.client.getAttempt(request.attemptId, {
        signal: controller.signal,
      });
      const latest = inputRef.current;
      if (
        controller.signal.aborted ||
        activeReconciliationRef.current !== controller ||
        !latest.isGenerationCurrent(
          request.generation,
          request.uploadGeneration,
        )
      )
        return;
      activeReconciliationRef.current = undefined;
      latest.onOutcome(attempt.outcome, request.attemptId);
    } catch (error) {
      const latest = inputRef.current;
      if (
        controller.signal.aborted ||
        activeReconciliationRef.current !== controller ||
        !latest.isGenerationCurrent(
          request.generation,
          request.uploadGeneration,
        ) ||
        latest.isAbort(error)
      )
        return;
      activeReconciliationRef.current = undefined;
      latest.onError(request.fallbackMessage);
    }
  }, []);

  const abort = useCallback(() => {
    const active = activeUploadRef.current;
    activeUploadRef.current = undefined;
    active?.controller.abort();
    activeReconciliationRef.current?.abort();
    activeReconciliationRef.current = undefined;
  }, []);

  useEffect(() => {
    if (!input.enabled || !input.attemptId || !input.media) return;
    const request: ActiveRequest = {
      attemptId: input.attemptId,
      generation: input.generation,
      uploadGeneration: input.uploadGeneration,
      controller: new AbortController(),
    };
    activeUploadRef.current = request;
    void input.client
      .uploadAttemptMedia(request.attemptId, input.media, {
        signal: request.controller.signal,
        onProgress: (progress) => {
          if (isCurrent(request)) inputRef.current.onProgress(progress);
        },
      })
      .then((accepted) => {
        if (!isCurrent(request)) return;
        activeUploadRef.current = undefined;
        const latest = inputRef.current;
        latest.onProgress(undefined);
        if (
          accepted.attemptId !== request.attemptId ||
          accepted.mode !== latest.expectedMode
        ) {
          latest.onMismatch();
          return;
        }
        latest.onOutcome(accepted.outcome, request.attemptId);
      })
      .catch((error: unknown) => {
        if (!isCurrent(request)) return;
        activeUploadRef.current = undefined;
        const latest = inputRef.current;
        latest.onProgress(undefined);
        if (
          isAmbiguousUploadError(error, {
            isAbort: latest.isAbort,
            isRouteError: latest.isRouteError,
            hasRouteErrorCode: latest.hasRouteErrorCode,
          })
        ) {
          void reconcile({
            attemptId: request.attemptId,
            generation: request.generation,
            uploadGeneration: request.uploadGeneration,
            fallbackMessage: latest.errorMessage(error),
          });
          return;
        }
        latest.onError(latest.errorMessage(error));
      });
    return () => {
      if (activeUploadRef.current === request) {
        activeUploadRef.current = undefined;
        request.controller.abort();
      }
    };
  }, [
    input.attemptId,
    input.enabled,
    input.generation,
    input.media,
    input.uploadGeneration,
    isCurrent,
    reconcile,
  ]);

  useEffect(() => () => abort(), [abort]);

  return { abort, reconcile };
}
