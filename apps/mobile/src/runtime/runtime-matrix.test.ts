import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import mobilePackage from "../../package.json";
import { runtimeMatrix } from "./runtime-matrix";

type Lockfile = Readonly<{
  importers: Record<
    string,
    Readonly<{
      dependencies?: Record<string, Readonly<{ version: string }>>;
      devDependencies?: Record<string, Readonly<{ version: string }>>;
    }>
  >;
  snapshots: Record<
    string,
    Readonly<{ dependencies?: Record<string, string> }>
  >;
}>;

function resolvedVersion(value: string) {
  return value.split("(")[0];
}

function findSnapshot(
  lockfile: Lockfile,
  packageName: string,
  version: string,
) {
  const prefix = `${packageName}@${version}`;
  const snapshots = Object.entries(lockfile.snapshots).filter(
    ([key]) => key === prefix || key.startsWith(`${prefix}(`),
  );

  expect(snapshots).toHaveLength(1);
  return snapshots[0]?.[1];
}

describe("the mobile runtime matrix", () => {
  it("keeps the Expo SDK 54 runtime and native peers on their accepted pins", () => {
    expect(runtimeMatrix).toEqual({
      expo: "54.0.18",
      expoMetroConfig: "54.0.7",
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
      secureStoreResolved: "15.0.8",
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

    const lockfile = parse(
      readFileSync(resolve(__dirname, "../../../../pnpm-lock.yaml"), "utf8"),
    ) as Lockfile;
    const mobileImporter = lockfile.importers["apps/mobile"];

    expect(mobileImporter).toBeDefined();
    expect(mobileImporter?.dependencies?.metro).toBeUndefined();
    expect(mobileImporter?.devDependencies?.metro).toBeUndefined();
    expect(
      resolvedVersion(mobileImporter?.dependencies?.expo?.version ?? ""),
    ).toBe(runtimeMatrix.expo);
    expect(
      resolvedVersion(
        mobileImporter?.dependencies?.["expo-secure-store"]?.version ?? "",
      ),
    ).toBe(runtimeMatrix.secureStoreResolved);

    const expoSnapshot = findSnapshot(lockfile, "expo", runtimeMatrix.expo);
    expect(
      resolvedVersion(expoSnapshot?.dependencies?.["@expo/metro-config"] ?? ""),
    ).toBe(runtimeMatrix.expoMetroConfig);

    const metroConfigSnapshot = findSnapshot(
      lockfile,
      "@expo/metro-config",
      runtimeMatrix.expoMetroConfig,
    );
    expect(
      resolvedVersion(metroConfigSnapshot?.dependencies?.["@expo/metro"] ?? ""),
    ).toBe(runtimeMatrix.metroProvider.replace("@expo/metro@", ""));

    const metroProviderSnapshot = findSnapshot(
      lockfile,
      "@expo/metro",
      runtimeMatrix.metroProvider.replace("@expo/metro@", ""),
    );
    expect(
      resolvedVersion(metroProviderSnapshot?.dependencies?.metro ?? ""),
    ).toBe(runtimeMatrix.metro);
  });
});
