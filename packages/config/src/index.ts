import { isIP } from "node:net";
import { z } from "zod";

const nodeEnvironmentSchema = z.enum(["development", "test", "production"]);
const nonEmptyStringSchema = z.string().trim().min(1);

const apiEnvInputSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema.optional().default("development"),
  HOST: nonEmptyStringSchema.optional().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).optional().default(3000),
  PUBLIC_BASE_URL: nonEmptyStringSchema.optional(),
  DATA_DIR: nonEmptyStringSchema.optional().default(".revelai/data"),
  MEDIA_DIR: nonEmptyStringSchema.optional().default(".revelai/media"),
  DATABASE_PATH: nonEmptyStringSchema.optional(),
  ALLOW_UNAUTHENTICATED_PUBLIC: z.string().optional(),
  ROBOFLOW_API_KEY: nonEmptyStringSchema.optional(),
  ROBOFLOW_BASE_URL: nonEmptyStringSchema.optional(),
  ROBOFLOW_WORKSPACE_ID: nonEmptyStringSchema.optional(),
  ROBOFLOW_WORKFLOW_ID: nonEmptyStringSchema.optional(),
  ROBOFLOW_WORKFLOW_VERSION: nonEmptyStringSchema.optional(),
});

const roboflowVariableNames = [
  "ROBOFLOW_API_KEY",
  "ROBOFLOW_BASE_URL",
  "ROBOFLOW_WORKSPACE_ID",
  "ROBOFLOW_WORKFLOW_ID",
  "ROBOFLOW_WORKFLOW_VERSION",
] as const;

const publicBindWarning: ApiStartupWarning = {
  id: "unauthenticated_mvp_public_bind",
  message:
    "Unauthenticated MVP mode is enabled for a non-loopback bind; do not use this configuration as a production security boundary.",
};

export type ApiEnvInput = Readonly<Record<string, string | undefined>>;

export type ApiNodeEnvironment = z.infer<typeof nodeEnvironmentSchema>;

export type ApiStartupWarning = {
  id: "unauthenticated_mvp_public_bind";
  message: string;
};

export type ApiEnvPaths = {
  dataDir: string;
  mediaDir: string;
  databasePath: string;
};

export type DemoVisionProviderConfig = {
  kind: "demo";
};

export type RoboflowVisionProviderConfig = {
  kind: "roboflow";
  apiKey: string;
  baseUrl: string;
  workspaceId: string;
  workflowId: string;
  workflowVersion: string;
};

export type VisionProviderConfig =
  | DemoVisionProviderConfig
  | RoboflowVisionProviderConfig;

export type ApiEnv = {
  nodeEnv: ApiNodeEnvironment;
  host: string;
  port: number;
  publicBaseUrl: string;
  paths: ApiEnvPaths;
  visionProvider: VisionProviderConfig;
  startupWarnings: ApiStartupWarning[];
};

function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/^\[|\]$/g, "");

  if (normalizedHost === "localhost") {
    return true;
  }

  if (isIP(normalizedHost) === 4) {
    return normalizedHost.split(".")[0] === "127";
  }

  return isIP(normalizedHost) === 6 && normalizedHost === "::1";
}

function formatHostForUrl(host: string): string {
  const normalizedHost = host.replace(/^\[|\]$/g, "");

  return isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : host;
}

function parseHttpUrl(value: string, variableName: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be an absolute HTTP(S) URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${variableName} must be an absolute HTTP(S) URL`);
  }

  return url;
}

function parseAllowUnauthenticatedPublic(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  if (value === "true") {
    return true;
  }

  throw new Error("ALLOW_UNAUTHENTICATED_PUBLIC must be exactly true when set");
}

function parseVisionProvider(
  input: z.infer<typeof apiEnvInputSchema>,
): VisionProviderConfig {
  const apiKey = input.ROBOFLOW_API_KEY;
  const baseUrlValue = input.ROBOFLOW_BASE_URL;
  const workspaceId = input.ROBOFLOW_WORKSPACE_ID;
  const workflowId = input.ROBOFLOW_WORKFLOW_ID;
  const workflowVersion = input.ROBOFLOW_WORKFLOW_VERSION;
  const suppliedVariables = [
    apiKey,
    baseUrlValue,
    workspaceId,
    workflowId,
    workflowVersion,
  ].filter((value) => value !== undefined);

  if (suppliedVariables.length === 0) {
    return { kind: "demo" };
  }

  if (
    suppliedVariables.length !== roboflowVariableNames.length ||
    apiKey === undefined ||
    baseUrlValue === undefined ||
    workspaceId === undefined ||
    workflowId === undefined ||
    workflowVersion === undefined
  ) {
    throw new Error(
      "Incomplete Roboflow configuration: set every ROBOFLOW_* variable or none of them",
    );
  }

  const baseUrl = parseHttpUrl(baseUrlValue, "ROBOFLOW_BASE_URL");

  if (baseUrl.protocol !== "https:" && !isLoopbackHost(baseUrl.hostname)) {
    throw new Error("A key-bearing external provider URL must use HTTPS");
  }

  return {
    kind: "roboflow",
    apiKey,
    baseUrl: baseUrl.toString(),
    workspaceId,
    workflowId,
    workflowVersion,
  };
}

export function parseApiEnv(source: ApiEnvInput): ApiEnv {
  const input = apiEnvInputSchema.parse({
    NODE_ENV: source.NODE_ENV,
    HOST: source.HOST,
    PORT: source.PORT,
    PUBLIC_BASE_URL: source.PUBLIC_BASE_URL,
    DATA_DIR: source.DATA_DIR,
    MEDIA_DIR: source.MEDIA_DIR,
    DATABASE_PATH: source.DATABASE_PATH,
    ALLOW_UNAUTHENTICATED_PUBLIC: source.ALLOW_UNAUTHENTICATED_PUBLIC,
    ROBOFLOW_API_KEY: source.ROBOFLOW_API_KEY,
    ROBOFLOW_BASE_URL: source.ROBOFLOW_BASE_URL,
    ROBOFLOW_WORKSPACE_ID: source.ROBOFLOW_WORKSPACE_ID,
    ROBOFLOW_WORKFLOW_ID: source.ROBOFLOW_WORKFLOW_ID,
    ROBOFLOW_WORKFLOW_VERSION: source.ROBOFLOW_WORKFLOW_VERSION,
  });
  const publicBaseUrl = parseHttpUrl(
    input.PUBLIC_BASE_URL ??
      `http://${formatHostForUrl(input.HOST)}:${input.PORT}`,
    "PUBLIC_BASE_URL",
  );

  if (input.NODE_ENV === "production" && publicBaseUrl.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production");
  }

  const allowUnauthenticatedPublic = parseAllowUnauthenticatedPublic(
    input.ALLOW_UNAUTHENTICATED_PUBLIC,
  );
  const isPublicBind = !isLoopbackHost(input.HOST);

  if (isPublicBind && !allowUnauthenticatedPublic) {
    throw new Error(
      "Non-loopback unauthenticated binding requires ALLOW_UNAUTHENTICATED_PUBLIC=true",
    );
  }

  return {
    nodeEnv: input.NODE_ENV,
    host: input.HOST,
    port: input.PORT,
    publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
    paths: {
      dataDir: input.DATA_DIR,
      mediaDir: input.MEDIA_DIR,
      databasePath: input.DATABASE_PATH ?? `${input.DATA_DIR}/revelai.sqlite`,
    },
    visionProvider: parseVisionProvider(input),
    startupWarnings: isPublicBind ? [publicBindWarning] : [],
  };
}
