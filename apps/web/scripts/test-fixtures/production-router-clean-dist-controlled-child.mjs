const keepAlive = setInterval(() => {}, 1_000);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    process.stdout.write(`forwarded:${signal}\n`);
    clearInterval(keepAlive);
  });
}

process.stdout.write("child-ready\n");
