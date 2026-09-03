const readinessPrefix = "REVELAI_EXECUTABLE_READY ";

// A wrapper mode kills its real executable at this bound; readiness beyond it
// cannot represent a cooperative executable and must fail through child close.
export const cleanApiModeTimeoutMs = 120_000;
export const bootstrapReadinessTimeoutMs = 45_000;

export function readinessPlanFor({ name, readiness }) {
  if (name === "between-case" && readiness === "inner:between-case:demo") {
    return Object.freeze({
      progress: "inner:before-case:demo",
      progressTimeoutMs: bootstrapReadinessTimeoutMs,
      target: readiness,
      targetTimeoutMs: cleanApiModeTimeoutMs,
    });
  }
  return Object.freeze({
    target: readiness,
    targetTimeoutMs: bootstrapReadinessTimeoutMs,
  });
}

export async function waitForReadiness(observer, plan) {
  if (plan.progress !== undefined) {
    await observer.waitFor(plan.progress, plan.progressTimeoutMs);
  }
  return observer.waitFor(plan.target, plan.targetTimeoutMs);
}

export function createReadinessObserver({
  stdout,
  close,
  createError,
  schedule = setTimeout,
  clear = clearTimeout,
}) {
  if (stdout === null) throw createError({ kind: "stdout-unavailable" });
  let output = "";
  let closed = false;
  const ready = new Map();
  const waiters = new Map();

  const rejectWaiters = (kind) => {
    closed = true;
    for (const [name, waiter] of waiters) {
      clear(waiter.timeout);
      waiter.reject(createError({ kind, name }));
    }
    waiters.clear();
  };
  const resolveWaiter = (entry) => {
    const waiter = waiters.get(entry.name);
    if (waiter === undefined) return;
    clear(waiter.timeout);
    waiters.delete(entry.name);
    waiter.resolve(entry);
  };
  const onData = (chunk) => {
    output += Buffer.from(chunk).toString("utf8");
    while (true) {
      const newline = output.indexOf("\n");
      if (newline === -1) break;
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      const match = new RegExp(
        `^${readinessPrefix}(?<name>[^ ]+) (?<pid>[1-9][0-9]*)$`,
      ).exec(line);
      if (match?.groups === undefined) continue;
      const entry = Object.freeze({
        name: match.groups.name,
        pid: Number(match.groups.pid),
      });
      ready.set(entry.name, entry);
      resolveWaiter(entry);
    }
  };

  stdout.on("data", onData);
  stdout.once("error", () => rejectWaiters("stdout-error"));
  stdout.once("end", () => rejectWaiters("stdout-end"));
  void close.closed.then(() => rejectWaiters("child-close"));

  return Object.freeze({
    waitFor(name, timeoutMs) {
      const existing = ready.get(name);
      if (existing !== undefined) return Promise.resolve(existing);
      if (
        closed ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        waiters.has(name)
      ) {
        return Promise.reject(createError({ kind: "wait-rejected", name }));
      }
      return new Promise((resolve, reject) => {
        const timeout = schedule(() => {
          waiters.delete(name);
          reject(createError({ kind: "timeout", name }));
        }, timeoutMs);
        waiters.set(name, { reject, resolve, timeout });
      });
    },
  });
}
