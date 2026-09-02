export const CANONICAL_LINUX_RENDERER = "playwright-1.62.1-noble-linux-amd64";
export const DARWIN_ARM64_RENDERER = "darwin-arm64-local";

const rendererByMode = {
  structural: undefined,
  darwin: DARWIN_ARM64_RENDERER,
  canonical: CANONICAL_LINUX_RENDERER,
};

function assertVisualGateMode(mode) {
  if (!mode) {
    throw new Error("Visual gate mode is required.");
  }

  if (!(mode in rendererByMode)) {
    throw new Error(`Unsupported visual gate mode: ${mode}.`);
  }
}

export function parseVisualGateArguments(argumentsList) {
  const playwrightArgs = [];
  let mode;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const inlineValue = argument.match(/^--revelai-visual-mode=(.+)$/)?.[1];

    if (inlineValue) {
      if (mode) {
        throw new Error("Visual gate mode may be provided only once.");
      }

      mode = inlineValue;
      continue;
    }

    if (argument === "--revelai-visual-mode") {
      if (mode) {
        throw new Error("Visual gate mode may be provided only once.");
      }

      mode = argumentsList[index + 1];
      index += 1;
      continue;
    }

    playwrightArgs.push(argument);
  }

  assertVisualGateMode(mode);
  return {
    mode,
    rendererIdentity: rendererByMode[mode],
    playwrightArgs,
  };
}

export function createPlaywrightCommand({
  platform,
  mode,
  rendererIdentity,
  playwrightArgs,
  environment,
}) {
  const sanitizedEnvironment = { ...environment };
  delete sanitizedEnvironment.NO_COLOR;
  delete sanitizedEnvironment.REVELAI_VISUAL_MODE;
  delete sanitizedEnvironment.REVELAI_VISUAL_RENDERER;
  sanitizedEnvironment.REVELAI_VISUAL_MODE = mode;

  if (rendererIdentity) {
    sanitizedEnvironment.REVELAI_VISUAL_RENDERER = rendererIdentity;
  }

  return {
    command: platform === "win32" ? "pnpm.cmd" : "pnpm",
    args: ["exec", "playwright", "test", ...playwrightArgs],
    environment: sanitizedEnvironment,
  };
}
