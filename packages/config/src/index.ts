import { isIP } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";

const nodeEnvironmentSchema = z.enum(["development", "test", "production"]);
const nonEmptyStringSchema = z.string().trim().min(1);

const apiEnvInputSchema = z
  .object({
    NODE_ENV: nodeEnvironmentSchema.optional().default("development"),
    HOST: nonEmptyStringSchema.optional().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).optional().default(3000),
    PUBLIC_BASE_URL: nonEmptyStringSchema.optional(),
    DATA_DIR: nonEmptyStringSchema.optional().default(".revelai/data"),
    MEDIA_DIR: nonEmptyStringSchema.optional().default(".revelai/media"),
    DATABASE_PATH: nonEmptyStringSchema.optional(),
    ALLOW_UNAUTHENTICATED_PUBLIC: z.string().optional(),
    ROBOFLOW_API_KEY: nonEmptyStringSchema.optional(),
    ROBOFLOW_API_URL: nonEmptyStringSchema.optional(),
    ROBOFLOW_WORKSPACE_ID: nonEmptyStringSchema.optional(),
    ROBOFLOW_WORKFLOW_VERSION: z.literal("1.0.0").optional(),
    ROBOFLOW_WALL_PASS_WORKFLOW_ID: z
      .literal("revelai-wall-pass-geometry-v1")
      .optional(),
    ROBOFLOW_WALL_PASS_MODEL_BUNDLE_ID: nonEmptyStringSchema.optional(),
    ROBOFLOW_FREE_WORKFLOW_ID: z.literal("revelai-free-training-v1").optional(),
    ROBOFLOW_FREE_MODEL_BUNDLE_ID: nonEmptyStringSchema.optional(),
  })
  .strict();

const requiredRoboflowVariableNames = [
  "ROBOFLOW_API_URL",
  "ROBOFLOW_WORKSPACE_ID",
  "ROBOFLOW_WORKFLOW_VERSION",
  "ROBOFLOW_WALL_PASS_WORKFLOW_ID",
  "ROBOFLOW_WALL_PASS_MODEL_BUNDLE_ID",
  "ROBOFLOW_FREE_WORKFLOW_ID",
  "ROBOFLOW_FREE_MODEL_BUNDLE_ID",
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
  apiKey?: string;
  apiUrl: string;
  workspaceId: string;
  workflowVersion: "1.0.0";
  wallPass: Readonly<{
    workflowId: "revelai-wall-pass-geometry-v1";
    modelBundleId: string;
  }>;
  freeTraining: Readonly<{
    workflowId: "revelai-free-training-v1";
    modelBundleId: string;
  }>;
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
  const apiUrlValue = input.ROBOFLOW_API_URL;
  const workspaceId = input.ROBOFLOW_WORKSPACE_ID;
  const workflowVersion = input.ROBOFLOW_WORKFLOW_VERSION;
  const wallPassWorkflowId = input.ROBOFLOW_WALL_PASS_WORKFLOW_ID;
  const wallPassModelBundleId = input.ROBOFLOW_WALL_PASS_MODEL_BUNDLE_ID;
  const freeWorkflowId = input.ROBOFLOW_FREE_WORKFLOW_ID;
  const freeModelBundleId = input.ROBOFLOW_FREE_MODEL_BUNDLE_ID;
  const suppliedVariables = [
    apiKey,
    apiUrlValue,
    workspaceId,
    workflowVersion,
    wallPassWorkflowId,
    wallPassModelBundleId,
    freeWorkflowId,
    freeModelBundleId,
  ].filter((value) => value !== undefined);

  if (suppliedVariables.length === 0) {
    return { kind: "demo" };
  }

  if (
    requiredRoboflowVariableNames.some((name) => input[name] === undefined) ||
    apiUrlValue === undefined ||
    workspaceId === undefined ||
    workflowVersion === undefined ||
    wallPassWorkflowId === undefined ||
    wallPassModelBundleId === undefined ||
    freeWorkflowId === undefined ||
    freeModelBundleId === undefined
  ) {
    throw new Error(
      "Incomplete Roboflow configuration: set every ROBOFLOW_* variable or none of them",
    );
  }

  const apiUrl = parseHttpUrl(apiUrlValue, "ROBOFLOW_API_URL");

  if (apiUrl.protocol !== "https:" && !isLoopbackHost(apiUrl.hostname)) {
    throw new Error("A key-bearing external provider URL must use HTTPS");
  }

  return {
    kind: "roboflow",
    ...(apiKey === undefined ? {} : { apiKey }),
    apiUrl: apiUrl.toString().replace(/\/$/, ""),
    workspaceId,
    workflowVersion,
    wallPass: {
      workflowId: wallPassWorkflowId,
      modelBundleId: wallPassModelBundleId,
    },
    freeTraining: {
      workflowId: freeWorkflowId,
      modelBundleId: freeModelBundleId,
    },
  };
}

export function parseApiEnv(source: ApiEnvInput): ApiEnv {
  const input = apiEnvInputSchema.parse(source);
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
      dataDir: resolve(input.DATA_DIR),
      mediaDir: resolve(input.MEDIA_DIR),
      databasePath: resolve(
        input.DATABASE_PATH ?? `${input.DATA_DIR}/revelai.sqlite`,
      ),
    },
    visionProvider: parseVisionProvider(input),
    startupWarnings: isPublicBind ? [publicBindWarning] : [],
  };
}
