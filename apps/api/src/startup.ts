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
  for (const warning of config.startupWarnings)
    input.log?.warning(Object.freeze({ ...warning }));
  await input.server.listen({ host: config.host, port: config.port });
  return Object.freeze({
    config,
    close: async () => {
      try {
        for (const resource of resources) await resource.close();
      } finally {
        await input.server.close();
      }
    },
  });
}
