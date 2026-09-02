export type PnpmRuntime = {
  execPath: string;
  platform?: string;
};

export declare function createPnpmInvocation(input: {
  argumentsList: readonly string[];
  environment?: NodeJS.ProcessEnv;
  runtime?: PnpmRuntime;
}): {
  command: string;
  args: string[];
};
