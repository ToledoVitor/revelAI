export const CANONICAL_LINUX_RENDERER = "playwright-1.62.1-noble-linux-amd64";
export const DARWIN_ARM64_RENDERER = "darwin-arm64-local";

export type VisualRenderer =
  | typeof CANONICAL_LINUX_RENDERER
  | typeof DARWIN_ARM64_RENDERER;

export type VisualGateMode = "structural" | "darwin" | "canonical";

type VisualRuntime = {
  platform: string;
  arch: string;
};

type VisualGate =
  | { mode: "structural" }
  | {
      mode: "darwin" | "canonical";
      renderer: VisualRenderer;
    };

function parseVisualGateMode(mode: string | undefined): VisualGateMode {
  if (!mode) {
    throw new Error("Visual gate mode is required.");
  }

  if (mode === "structural" || mode === "darwin" || mode === "canonical") {
    return mode;
  }

  throw new Error(`Unsupported visual gate mode: ${mode}.`);
}

export function resolveVisualGate({
  mode,
  rendererIdentity,
  runtime,
}: {
  mode?: string;
  rendererIdentity?: string;
  runtime: VisualRuntime;
}): VisualGate {
  const parsedMode = parseVisualGateMode(mode);

  if (parsedMode === "structural") {
    return { mode: "structural" };
  }

  if (parsedMode === "canonical") {
    if (rendererIdentity !== CANONICAL_LINUX_RENDERER) {
      throw new Error(
        `Canonical visual pixels require renderer ${CANONICAL_LINUX_RENDERER}.`,
      );
    }

    if (runtime.platform !== "linux" || runtime.arch !== "x64") {
      throw new Error("Canonical visual pixels require linux/x64.");
    }

    return { mode: "canonical", renderer: CANONICAL_LINUX_RENDERER };
  }

  if (rendererIdentity !== DARWIN_ARM64_RENDERER) {
    throw new Error(
      `Darwin visual pixels require renderer ${DARWIN_ARM64_RENDERER}.`,
    );
  }

  if (runtime.platform !== "darwin" || runtime.arch !== "arm64") {
    throw new Error("Darwin visual pixels require darwin/arm64.");
  }

  return { mode: "darwin", renderer: DARWIN_ARM64_RENDERER };
}
