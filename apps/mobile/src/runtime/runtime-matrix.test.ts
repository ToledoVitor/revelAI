import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import mobilePackage from "../../package.json";
import { runtimeMatrix } from "./runtime-matrix";

describe("the mobile runtime matrix", () => {
  it("keeps the Expo SDK 54 runtime and native peers on their accepted pins", () => {
    expect(runtimeMatrix).toEqual({
      expo: "54.0.18",
      jest: "29.7.0",
      jestExpo: "54.0.18",
      metro: "0.83.2",
      metroProvider: "@expo/metro@54.1.0",
      phosphorReactNative: "2.1.0",
      react: "19.1.0",
      reactDom: "19.1.0",
      reactNative: "0.81.4",
      reactNativeSvg: "15.12.1",
      reactNativeWeb: "0.21.0",
      secureStore: "~15.0.8",
    });
    expect(mobilePackage.dependencies).toMatchObject({
      expo: runtimeMatrix.expo,
      "expo-secure-store": runtimeMatrix.secureStore,
      "phosphor-react-native": runtimeMatrix.phosphorReactNative,
      react: runtimeMatrix.react,
      "react-dom": runtimeMatrix.reactDom,
      "react-native": runtimeMatrix.reactNative,
      "react-native-svg": runtimeMatrix.reactNativeSvg,
      "react-native-web": runtimeMatrix.reactNativeWeb,
    });
    expect(mobilePackage.devDependencies).toMatchObject({
      jest: runtimeMatrix.jest,
      "jest-expo": runtimeMatrix.jestExpo,
    });
    const workspaceOverrides = readFileSync(
      resolve(__dirname, "../../../../pnpm-workspace.yaml"),
      "utf8",
    );

    for (const [dependency, version] of [
      ["expo", runtimeMatrix.expo],
      ["react", runtimeMatrix.react],
      ["react-dom", runtimeMatrix.reactDom],
      ["react-native", runtimeMatrix.reactNative],
      ["react-native-svg", runtimeMatrix.reactNativeSvg],
      ["react-native-web", runtimeMatrix.reactNativeWeb],
    ]) {
      expect(workspaceOverrides).toContain(
        `"@revelai/mobile>${dependency}": ${version}`,
      );
    }

    const lockfile = readFileSync(
      resolve(__dirname, "../../../../pnpm-lock.yaml"),
      "utf8",
    );

    expect(lockfile).toContain(`"${runtimeMatrix.metroProvider}"`);
    expect(lockfile).toContain(`metro: ${runtimeMatrix.metro}`);
  });
});
