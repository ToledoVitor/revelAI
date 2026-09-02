import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";

function getPnpmEntry(environment) {
  const entry = environment.npm_execpath;

  if (typeof entry !== "string" || entry.trim() === "") {
    throw new Error(
      "npm_execpath is required to invoke pnpm. Run this command through a package script instead of calling its Node runner directly.",
    );
  }

  if (!isAbsolute(entry)) {
    throw new Error(
      "npm_execpath must be an absolute path to the active pnpm entry.",
    );
  }

  try {
    accessSync(entry, constants.R_OK);
    if (!statSync(entry).isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new Error(
      `npm_execpath does not point to a readable pnpm entry: ${entry}`,
    );
  }

  return entry;
}

export function createPnpmInvocation({
  argumentsList,
  environment = process.env,
  runtime = process,
}) {
  const entry = getPnpmEntry(environment);

  if (typeof runtime.execPath !== "string" || runtime.execPath.trim() === "") {
    throw new Error("A Node executable path is required to invoke pnpm.");
  }

  return {
    command: runtime.execPath,
    args: [entry, ...argumentsList],
  };
}
