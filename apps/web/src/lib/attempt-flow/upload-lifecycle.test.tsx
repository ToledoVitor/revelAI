import { render, screen, waitFor } from "@testing-library/react";
import type { AttemptOutcome } from "@revelai/contracts";
import { useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useAttemptUploadLifecycle } from "./upload-lifecycle";

const pending: AttemptOutcome = {
  state: "pending",
  attemptId: "attempt-neutral",
  mode: "free",
  status: "uploaded",
};

function Harness({
  upload,
  getAttempt,
}: Readonly<{
  upload: Parameters<
    typeof useAttemptUploadLifecycle
  >[0]["client"]["uploadAttemptMedia"];
  getAttempt: Parameters<
    typeof useAttemptUploadLifecycle
  >[0]["client"]["getAttempt"];
}>) {
  const [progress, setProgress] = useState("idle");
  const [outcome, setOutcome] = useState("none");
  const media = useMemo(
    () => new File(["video"], "neutral.webm", { type: "video/webm" }),
    [],
  );
  useAttemptUploadLifecycle({
    enabled: true,
    attemptId: "attempt-neutral",
    media,
    expectedMode: "free",
    generation: 1,
    uploadGeneration: 1,
    client: { uploadAttemptMedia: upload, getAttempt },
    isGenerationCurrent: () => true,
    isAbort: (_error): _error is never => false,
    isRouteError: (_error): _error is never => false,
    hasRouteErrorCode: () => false,
    errorMessage: () => "safe",
    onProgress: (next) =>
      setProgress(next ? `${next.loaded}/${next.total ?? "?"}` : "done"),
    onOutcome: (next) => setOutcome(next.state),
    onMismatch: () => setOutcome("mismatch"),
    onError: (message) => setOutcome(message),
  });
  return <output>{`${progress}:${outcome}`}</output>;
}

describe("neutral Attempt upload lifecycle", () => {
  it("owns upload progress and accepted outcomes without a mode-specific wrapper", async () => {
    const upload = vi.fn(async (_id, _media, options) => {
      options.onProgress({ loaded: 3, total: 9 });
      return {
        attemptId: "attempt-neutral",
        mode: "free" as const,
        outcome: pending,
      };
    });
    const getAttempt = vi.fn();

    render(<Harness upload={upload} getAttempt={getAttempt} />);

    await waitFor(() => expect(screen.getByText("done:pending")).toBeVisible());
    expect(upload).toHaveBeenCalledOnce();
    expect(getAttempt).not.toHaveBeenCalled();
  });
});
