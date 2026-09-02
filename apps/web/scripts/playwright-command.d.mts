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
  mode: VisualGateMode;
  rendererIdentity: string | undefined;
  playwrightArgs: readonly string[];
  environment: NodeJS.ProcessEnv;
  runtime: {
    execPath: string;
    platform?: string;
  };
}): {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
};
