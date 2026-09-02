export declare const CANONICAL_LINUX_RENDERER: string;
export declare const DARWIN_ARM64_RENDERER: string;

export type VisualGateMode = "structural" | "darwin" | "canonical";

export declare function parseVisualGateArguments(
  argumentsList: readonly string[],
): {
  mode: VisualGateMode;
  rendererIdentity: string | undefined;
  playwrightArgs: string[];
};

export declare function createPlaywrightCommand(input: {
  platform: string;
  mode: VisualGateMode;
  rendererIdentity: string | undefined;
  playwrightArgs: readonly string[];
  environment: NodeJS.ProcessEnv;
}): {
  command: "pnpm" | "pnpm.cmd";
  args: string[];
  environment: NodeJS.ProcessEnv;
};
