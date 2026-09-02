import { fireEvent, render, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { describe, expect, it } from "vitest";
import {
  nextPendingPollBackoff,
  usePendingAttemptPolling,
} from "./pending-polling";

describe("pending attempt polling", () => {
  it("caps the shared 1/2/4/5 second progression", () => {
    expect([1, 2, 4, 5, 5].map(nextPendingPollBackoff)).toEqual([
      2, 4, 5, 5, 5,
    ]);
  });

  it("clears refreshing synchronously when a stale generation is disabled", () => {
    let resolve!: (value: { kind: "pending"; value: string }) => void;
    const request = () =>
      new Promise<{ kind: "pending"; value: string }>((next) => {
        resolve = next;
      });
    function Harness() {
      const [enabled, setEnabled] = useState(true);
      const polling = usePendingAttemptPolling({
        enabled,
        attemptId: "attempt-pending",
        generation: enabled ? 1 : 2,
        request,
        onDecision: () => undefined,
        onError: () => undefined,
        isAbort: () => false,
      });
      return createElement(
        "div",
        undefined,
        createElement(
          "button",
          { type: "button", onClick: () => void polling.refresh() },
          "refresh",
        ),
        createElement(
          "button",
          { type: "button", onClick: () => setEnabled(false) },
          "disable",
        ),
        createElement(
          "output",
          undefined,
          polling.refreshing ? "refreshing" : "ready",
        ),
      );
    }

    render(createElement(Harness));
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    expect(screen.getByText("refreshing")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "disable" }));
    expect(screen.getByText("ready")).toBeVisible();
    resolve({ kind: "pending", value: "late" });
  });
});
