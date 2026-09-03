import { resolveContractsOnce } from "./contracts-resolution";

describe("the mobile Metro contract dependency", () => {
  it("resolves the contracts public entry once through the workspace package", () => {
    expect(resolveContractsOnce()).toEqual(["free", "verified"]);
  });
});
