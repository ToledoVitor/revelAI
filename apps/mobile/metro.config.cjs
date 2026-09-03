const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);

config.watchFolders = [...new Set([...config.watchFolders, workspaceRoot])];
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, "node_modules"),
  path.join(workspaceRoot, "node_modules"),
];
const phosphorCommonJsEntry = path.join(
  projectRoot,
  "node_modules/phosphor-react-native/lib/commonjs/index.js",
);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "phosphor-react-native") {
    return { filePath: phosphorCommonJsEntry, type: "sourceFile" };
  }

  return context.resolveRequest(context, moduleName, platform);
};
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
