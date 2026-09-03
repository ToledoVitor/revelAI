/**
 * Shares one teardown promise so concurrent shutdown callers wait for the
 * same owned-resource cleanup instead of returning while it is still running.
 */
export function createSharedStop(stopResources) {
  let stopPromise;

  return function stop() {
    if (stopPromise) return stopPromise;
    try {
      stopPromise = Promise.resolve(stopResources());
    } catch (error) {
      stopPromise = Promise.reject(error);
    }
    return stopPromise;
  };
}

/**
 * Terminates only a child that this runner created. Child `error` events can
 * occur for both TERM and KILL, so their listener remains attached until the
 * owned process reports `close`.
 */
export function createOwnedChildStop(
  child,
  { graceMilliseconds, schedule = setTimeout, clear = clearTimeout } = {},
) {
  let closed = false;
  let stopPromise;

  child.once("close", () => {
    closed = true;
  });

  return function stopOwnedChild() {
    if (stopPromise) return stopPromise;
    if (closed) return Promise.resolve();

    stopPromise = new Promise((resolveChild) => {
      let forceKill;
      const ignoreChildError = () => undefined;
      const closeChild = () => {
        closed = true;
        if (forceKill) clear(forceKill);
        child.off("error", ignoreChildError);
        resolveChild();
      };

      child.on("error", ignoreChildError);
      child.once("close", closeChild);

      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      if (closed || child.exitCode !== null) return;

      forceKill = schedule(() => {
        if (!closed && child.exitCode === null) child.kill("SIGKILL");
      }, graceMilliseconds);
      forceKill?.unref?.();
    });
    return stopPromise;
  };
}
