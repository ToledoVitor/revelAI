export const cleanupAcknowledgementRequestType =
  "revelai-clean-api-cleanup-ack-request-v1";
export const cleanupCompleteType = "revelai-clean-api-cleanup-complete-v1";

export function cleanupAcknowledgementRequest({
  invocationNonce,
  terminationNonce,
}) {
  assertNonce(invocationNonce);
  assertNonce(terminationNonce);
  return Object.freeze({
    type: cleanupAcknowledgementRequestType,
    invocationNonce,
    terminationNonce,
  });
}

export function cleanupCompleteMessage({
  pid,
  invocationNonce,
  terminationNonce,
}) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("Invalid clean API cleanup acknowledgement.");
  }
  assertNonce(invocationNonce);
  assertNonce(terminationNonce);
  return Object.freeze({
    type: cleanupCompleteType,
    pid,
    invocationNonce,
    terminationNonce,
  });
}

export function cleanupAcknowledgementTerminationNonce(
  message,
  invocationNonce,
) {
  if (!isNonce(invocationNonce) || !isPlainObject(message)) return undefined;
  if (
    !hasExactKeys(message, ["type", "invocationNonce", "terminationNonce"]) ||
    message.type !== cleanupAcknowledgementRequestType ||
    message.invocationNonce !== invocationNonce ||
    !isNonce(message.terminationNonce)
  ) {
    return undefined;
  }
  return message.terminationNonce;
}

export function createCleanupAcknowledgementGate({
  expectedPid,
  invocationNonce,
  terminationNonce,
  cleanupDeadlineMs,
  closeAfterCleanupMs,
  schedule,
  clear,
  onDeadline,
  onCloseAfterAcknowledgement,
}) {
  if (!Number.isSafeInteger(expectedPid) || expectedPid < 1) {
    throw new Error("Invalid clean API cleanup acknowledgement gate.");
  }
  assertNonce(invocationNonce);
  assertNonce(terminationNonce);

  let state = "running";
  let cleanupDeadline;
  let closeAfterAcknowledgement;

  const clearTimers = () => {
    if (cleanupDeadline !== undefined) clear(cleanupDeadline);
    if (closeAfterAcknowledgement !== undefined) {
      clear(closeAfterAcknowledgement);
    }
    cleanupDeadline = undefined;
    closeAfterAcknowledgement = undefined;
  };

  return Object.freeze({
    accept(message) {
      if (
        state !== "terminating" ||
        !isCleanupCompleteMessage({
          message,
          expectedPid,
          invocationNonce,
          terminationNonce,
        })
      ) {
        return false;
      }
      state = "acknowledged";
      clear(cleanupDeadline);
      cleanupDeadline = undefined;
      closeAfterAcknowledgement = schedule(() => {
        if (state !== "acknowledged") return;
        state = "close-after-acknowledgement-expired";
        onCloseAfterAcknowledgement();
      }, closeAfterCleanupMs);
      return true;
    },
    beginTermination() {
      if (state !== "running") return false;
      state = "terminating";
      cleanupDeadline = schedule(() => {
        if (state !== "terminating") return;
        state = "cleanup-deadline-expired";
        onDeadline();
      }, cleanupDeadlineMs);
      return true;
    },
    settle() {
      if (state === "settled") return;
      state = "settled";
      clearTimers();
    },
  });
}

export function isNonce(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function isCleanupCompleteMessage({
  message,
  expectedPid,
  invocationNonce,
  terminationNonce,
}) {
  return (
    isPlainObject(message) &&
    hasExactKeys(message, [
      "type",
      "pid",
      "invocationNonce",
      "terminationNonce",
    ]) &&
    message.type === cleanupCompleteType &&
    message.pid === expectedPid &&
    message.invocationNonce === invocationNonce &&
    message.terminationNonce === terminationNonce
  );
}

function hasExactKeys(message, expected) {
  const keys = Object.keys(message);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(message, key))
  );
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertNonce(value) {
  if (!isNonce(value)) throw new Error("Invalid clean API cleanup nonce.");
}
