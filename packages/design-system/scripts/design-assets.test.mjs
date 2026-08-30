import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const importer = join(import.meta.dirname, "import-approved-design-assets.mjs");
const verifier = join(import.meta.dirname, "verify-design-assets.mjs");
const temporaryDirectories = [];

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function png(width, height, suffix = "") {
  const header = Buffer.alloc(24);
  header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.from(suffix)]);
}

async function temporaryRepository() {
  const root = await mkdtemp(join(tmpdir(), "revelai-design-assets-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeAsset(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function referenceManifest({
  source,
  sourceHash,
  sourceDimensions,
  destination,
  repositoryHash,
  repositoryDimensions,
}) {
  return `# Fixture asset manifest\n\n## Approved reference screenshots\n\n| Reference | Immutable source | Repository destination | Source SHA-256 | Source dimensions | Repository SHA-256 | Repository dimensions |\n| --- | --- | --- | --- | --- | --- | --- |\n| Fixture reference | \`${source}\` | \`${destination}\` | \`${sourceHash}\` | ${sourceDimensions} | \`${repositoryHash}\` | ${repositoryDimensions} |\n\n## Canonical standalone hero gate\n\n| Asset | Required destination | Required dimensions | Repository SHA-256 | Generation/acceptance rule |\n| --- | --- | --- | --- | --- |\n`;
}

function heroManifest(masterHash, webHash, mobileHash) {
  return `| Hero master | \`docs/design/assets/revelai-hero-master.png\` | 1600×1200 | \`${masterHash}\` | Generated |\n| Web hero crop | \`apps/web/public/assets/futsal-hero.png\` | 1600×1200 | \`${webHash}\` | Derived from accepted master |\n| Mobile hero crop | \`apps/mobile/assets/futsal-hero.png\` | 900×1200 | \`${mobileHash}\` | Derived from accepted master |\n`;
}

function receipt(masterHash, webHash, mobileHash, accepted = true) {
  return JSON.stringify(
    {
      master: {
        generatorRunId: "test-run-123",
        sha256: masterHash,
        width: 1600,
        height: 1200,
        licensedOrGenerated: "generated",
        accepted,
        checklist: {
          noText: true,
          noLogoOrSponsor: true,
          noUiOrDeviceChrome: true,
          athleteVisible: true,
          ballVisible: true,
        },
      },
      webCrop: { sha256: webHash, width: 1600, height: 1200 },
      mobileCrop: { sha256: mobileHash, width: 900, height: 1200 },
    },
    null,
    2,
  );
}

async function run(script, root, manifest) {
  return execFile(
    process.execPath,
    [script, "--repo-root", root, "--manifest", manifest],
    {
      cwd: repositoryRoot,
    },
  );
}

async function expectFailure(script, root, manifest, message) {
  await expect(run(script, root, manifest)).rejects.toMatchObject({
    stderr: expect.stringContaining(message),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("import-approved-design-assets", () => {
  it("copies a verified source byte-for-byte to its repository destination", async () => {
    const root = await temporaryRepository();
    const source = join(root, "external", "approved.png");
    const destination = "docs/design/references/fixture.png";
    const contents = png(7, 9, "approved-source-bytes");
    const manifest = join(root, "docs/design/asset-manifest.md");

    await writeAsset(source, contents);
    await writeAsset(
      manifest,
      referenceManifest({
        source,
        sourceHash: sha256(contents),
        sourceDimensions: "7×9",
        destination,
        repositoryHash: sha256(contents),
        repositoryDimensions: "7×9",
      }),
    );

    await run(importer, root, manifest);

    await expect(readFile(join(root, destination))).resolves.toEqual(contents);
  });

  it("rejects a missing approved source before creating its destination", async () => {
    const root = await temporaryRepository();
    const source = join(root, "external", "missing.png");
    const manifest = join(root, "docs/design/asset-manifest.md");

    await writeAsset(
      manifest,
      referenceManifest({
        source,
        sourceHash: "a".repeat(64),
        sourceDimensions: "7×9",
        destination: "docs/design/references/fixture.png",
        repositoryHash: "a".repeat(64),
        repositoryDimensions: "7×9",
      }),
    );

    await expectFailure(importer, root, manifest, "Missing approved source");
  });

  it("rejects a source whose bytes drift from its immutable hash", async () => {
    const root = await temporaryRepository();
    const source = join(root, "external", "drifted.png");
    const manifest = join(root, "docs/design/asset-manifest.md");
    const contents = png(7, 9, "drifted-source-bytes");

    await writeAsset(source, contents);
    await writeAsset(
      manifest,
      referenceManifest({
        source,
        sourceHash: "b".repeat(64),
        sourceDimensions: "7×9",
        destination: "docs/design/references/fixture.png",
        repositoryHash: sha256(contents),
        repositoryDimensions: "7×9",
      }),
    );

    await expectFailure(importer, root, manifest, "Source hash mismatch");
  });

  it("rejects a source whose dimensions drift from its immutable provenance", async () => {
    const root = await temporaryRepository();
    const source = join(root, "external", "wrong-size.png");
    const manifest = join(root, "docs/design/asset-manifest.md");
    const contents = png(7, 8, "wrong-dimensions");

    await writeAsset(source, contents);
    await writeAsset(
      manifest,
      referenceManifest({
        source,
        sourceHash: sha256(contents),
        sourceDimensions: "7×9",
        destination: "docs/design/references/fixture.png",
        repositoryHash: sha256(contents),
        repositoryDimensions: "7×9",
      }),
    );

    await expectFailure(importer, root, manifest, "Source dimension mismatch");
  });
});

describe("verify-design-assets", () => {
  async function verifiedFixture() {
    const root = await temporaryRepository();
    const reference = png(7, 9, "committed-reference");
    const master = png(1600, 1200, "accepted-master");
    const web = png(1600, 1200, "web-crop");
    const mobile = png(900, 1200, "mobile-crop");
    const manifest = join(root, "docs/design/asset-manifest.md");
    const referenceHash = sha256(reference);
    const masterHash = sha256(master);
    const webHash = sha256(web);
    const mobileHash = sha256(mobile);

    await writeAsset(
      join(root, "docs/design/references/fixture.png"),
      reference,
    );
    await writeAsset(
      join(root, "docs/design/assets/revelai-hero-master.png"),
      master,
    );
    await writeAsset(join(root, "apps/web/public/assets/futsal-hero.png"), web);
    await writeAsset(join(root, "apps/mobile/assets/futsal-hero.png"), mobile);
    await writeAsset(
      join(root, "docs/design/assets/a1-asset-receipt.json"),
      receipt(masterHash, webHash, mobileHash),
    );
    await writeAsset(
      manifest,
      referenceManifest({
        source: "/unavailable-external-source/fixture.png",
        sourceHash: "c".repeat(64),
        sourceDimensions: "7×9",
        destination: "docs/design/references/fixture.png",
        repositoryHash: referenceHash,
        repositoryDimensions: "7×9",
      }) + heroManifest(masterHash, webHash, mobileHash),
    );

    return {
      root,
      manifest,
      master,
      masterHash,
      web,
      webHash,
      mobile,
      mobileHash,
    };
  }

  it("verifies committed assets without requiring unavailable external source paths", async () => {
    const fixture = await verifiedFixture();

    await expect(
      run(verifier, fixture.root, fixture.manifest),
    ).resolves.toMatchObject({ stdout: expect.stringContaining("verified") });
  });

  it("verifies an isolated copy of the committed assets without external sources", async () => {
    const root = await temporaryRepository();
    const manifest = join(root, "docs/design/asset-manifest.md");

    await cp(join(repositoryRoot, "docs/design"), join(root, "docs/design"), {
      recursive: true,
    });
    await cp(join(repositoryRoot, "apps"), join(root, "apps"), {
      recursive: true,
    });
    const committedManifest = await readFile(manifest, "utf8");
    await writeAsset(
      manifest,
      committedManifest.replaceAll(
        /`\/Users\/vitortoledo\/\.codex\/generated_images\/[^`]+`/g,
        "`/unavailable-external-source/removed.png`",
      ),
    );

    await expect(run(verifier, root, manifest)).resolves.toMatchObject({
      stdout: expect.stringContaining("10 assets"),
    });
  });

  it("rejects a missing receipt", async () => {
    const fixture = await verifiedFixture();
    await rm(join(fixture.root, "docs/design/assets/a1-asset-receipt.json"));

    await expectFailure(
      verifier,
      fixture.root,
      fixture.manifest,
      "Missing asset receipt",
    );
  });

  it("rejects an unaccepted master receipt", async () => {
    const fixture = await verifiedFixture();
    await writeAsset(
      join(fixture.root, "docs/design/assets/a1-asset-receipt.json"),
      receipt(fixture.masterHash, fixture.webHash, fixture.mobileHash, false),
    );

    await expectFailure(
      verifier,
      fixture.root,
      fixture.manifest,
      "accepted must be true",
    );
  });

  it("rejects a malformed receipt checklist", async () => {
    const fixture = await verifiedFixture();
    const malformedReceipt = JSON.parse(
      receipt(fixture.masterHash, fixture.webHash, fixture.mobileHash),
    );
    delete malformedReceipt.master.checklist.ballVisible;
    await writeAsset(
      join(fixture.root, "docs/design/assets/a1-asset-receipt.json"),
      JSON.stringify(malformedReceipt),
    );

    await expectFailure(
      verifier,
      fixture.root,
      fixture.manifest,
      "Asset receipt checklist has an invalid shape",
    );
  });

  it("rejects a committed destination hash mutation", async () => {
    const fixture = await verifiedFixture();
    await writeAsset(
      join(fixture.root, "docs/design/references/fixture.png"),
      png(7, 9, "mutated-reference"),
    );

    await expectFailure(
      verifier,
      fixture.root,
      fixture.manifest,
      "Repository hash mismatch",
    );
  });

  it("rejects a committed destination dimension mutation", async () => {
    const fixture = await verifiedFixture();
    const dimensionDrift = png(899, 1200, "wrong-mobile-dimensions");
    await writeAsset(
      join(fixture.root, "apps/mobile/assets/futsal-hero.png"),
      dimensionDrift,
    );
    const manifest = await readFile(fixture.manifest, "utf8");
    await writeAsset(
      fixture.manifest,
      manifest.replace(fixture.mobileHash, sha256(dimensionDrift)),
    );

    await expectFailure(
      verifier,
      fixture.root,
      fixture.manifest,
      "Repository dimension mismatch",
    );
  });
});
