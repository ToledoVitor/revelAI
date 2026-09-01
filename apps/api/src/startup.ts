import { parseApiEnv, type ApiEnv, type ApiEnvInput } from "@revelai/config";

export type ConfiguredApiServer = Readonly<{
  listen(input: Readonly<{ host: string; port: number }>): Promise<void>;
  close(): Promise<void>;
}>;
export type StartupResource = Readonly<{ close(): void | Promise<void> }>;
export type StartupLog = Readonly<{
  warning(input: Readonly<{ id: string; message: string }>): void;
}>;

export async function startConfiguredApi(
  input: Readonly<{
    environment: ApiEnvInput;
    server: ConfiguredApiServer;
    resources?: readonly StartupResource[];
    log?: StartupLog;
  }>,
): Promise<Readonly<{ config: ApiEnv; close(): Promise<void> }>> {
  const config = parseApiEnv(input.environment);
  const resources = Object.freeze([...(input.resources ?? [])]);
  if (config.startupWarnings.length > 0 && !input.log)
    throw new Error(
      "A persistent startup warning sink is required for public bind.",
    );
  for (const warning of config.startupWarnings)
    input.log?.warning(Object.freeze({ ...warning }));
  try {
    await input.server.listen({ host: config.host, port: config.port });
  } catch (error) {
    try {
      await closeServerThenResources(input.server, resources);
    } catch (closeError) {
      throw new AggregateError(
        [error, ...closeErrors(closeError)],
        "API startup failed and rollback could not close every owner.",
      );
    }
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    config,
    close: () =>
      (closePromise ??= closeServerThenResources(input.server, resources)),
  });
}

async function closeServerThenResources(
  server: ConfiguredApiServer,
  resources: readonly StartupResource[],
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await server.close();
  } catch (error) {
    errors.push(error);
  }
  for (const resource of resources) {
    try {
      await resource.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      "API shutdown could not close every owner.",
    );
}

function closeErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? [...error.errors] : [error];
}
