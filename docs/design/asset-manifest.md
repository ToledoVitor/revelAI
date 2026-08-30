# RevelAI approved design asset manifest

This manifest preserves both one-time external provenance and portable repository truth for A1. External source paths/hashes below are immutable import provenance; they are not a runtime or CI dependency. Screenshots remain design references; they are not licensed/runtime hero crops.

## Two A1 commands

`rtk pnpm import:design-assets` runs only once on a workstation that has the listed external source files. `packages/design-system/scripts/import-approved-design-assets.mjs` reads those source paths, verifies each listed SHA-256 and dimensions, then byte-for-byte copies it to its repository destination. A missing or drifted external source makes this **import** fail; no later verification reads the external paths.

`rtk pnpm verify:design-assets` is the portable post-A1 gate. `packages/design-system/scripts/verify-design-assets.mjs` reads only the committed repository destinations in this manifest, `docs/design/assets/a1-asset-receipt.json`, the hero master, and web/mobile crops. It verifies their SHA-256/dimensions and every required receipt field. It must not stat, open, or require the external paths. CI and a clean checkout execute only this verifier.

## Approved reference screenshots

| Reference | Immutable source | Repository destination | Source SHA-256 | Source dimensions | Repository SHA-256 | Repository dimensions |
| --- | --- | --- | --- | --- | --- | --- |
| Mobile home | `/Users/vitortoledo/.codex/generated_images/01a03adf-5003-79c1-9c74-531e76823d17/exec-fe9f36c6-aa7f-4c16-9b3d-ab0d9c471158.png` | `docs/design/references/mobile-home.png` | `e1e264790703ed3f36b5002b208d0f6aadd6e49b2eda4698298310e9932b5d18` | 853×1844 | `e1e264790703ed3f36b5002b208d0f6aadd6e49b2eda4698298310e9932b5d18` | 853×1844 |
| Desktop home | `/Users/vitortoledo/.codex/generated_images/01a03adf-5003-79c1-9c74-531e76823d17/exec-b0329963-a7f3-432f-9f90-dd48af68ea42.png` | `docs/design/references/desktop-home.png` | `926898de7d7347cf802b49372cddeb74f7e851b2a0188fe27a36616935f9bf48` | 1487×1058 | `926898de7d7347cf802b49372cddeb74f7e851b2a0188fe27a36616935f9bf48` | 1487×1058 |
| Mobile challenge | `/Users/vitortoledo/.codex/generated_images/01a03adf-5003-79c1-9c74-531e76823d17/exec-ae9a606d-0eb8-4d71-a859-5c1b20af37e4.png` | `docs/design/references/mobile-challenge.png` | `f61346b20c54a7b3cb714ba90b4570e3edf0384dddb50976757242f302cd7bad` | 852×1846 | `f61346b20c54a7b3cb714ba90b4570e3edf0384dddb50976757242f302cd7bad` | 852×1846 |
| Mobile calibration | `/Users/vitortoledo/.codex/generated_images/01a03adf-5003-79c1-9c74-531e76823d17/exec-1c9417ab-00ce-45db-abbb-799f7002507c.png` | `docs/design/references/mobile-calibration.png` | `155047c2c2b7985ce08658b54a734dfe92f4243a04a82c0cc8b22107eae6e429` | 852×1846 | `155047c2c2b7985ce08658b54a734dfe92f4243a04a82c0cc8b22107eae6e429` | 852×1846 |
| Mobile record | `/Users/vitortoledo/.codex/generated_images/01a03adf-5003-79c1-9c74-531e76823d17/exec-68e02991-c671-4dcf-8583-70abec29a86e.png` | `docs/design/references/mobile-record.png` | `98a48c0aed65cb5005b9b18fa1f96f268c84017f51592dfe9a895d82bdaad11c` | 853×1844 | `98a48c0aed65cb5005b9b18fa1f96f268c84017f51592dfe9a895d82bdaad11c` | 853×1844 |
| Mobile processing | `/Users/vitortoledo/.codex/generated_images/01a03adf-5003-79c1-9c74-531e76823d17/exec-2a7688c5-5a2f-4757-9fa9-24d94d2668ff.png` | `docs/design/references/mobile-processing.png` | `4e262f66bcf787d0cf1a64d8805c373324622e57caf5bd666417ddd223d2bf8e` | 852×1846 | `4e262f66bcf787d0cf1a64d8805c373324622e57caf5bd666417ddd223d2bf8e` | 852×1846 |
| Mobile report | `/Users/vitortoledo/.codex/generated_images/01a03adf-5003-79c1-9c74-531e76823d17/exec-0444e72f-4317-41db-888e-dad62cc13bf4.png` | `docs/design/references/mobile-report.png` | `fe9f3dd782b3447927fec06c2e82bf1ab5e2680e23b350cccf7b498bd3200df6` | 853×1844 | `fe9f3dd782b3447927fec06c2e82bf1ab5e2680e23b350cccf7b498bd3200df6` | 853×1844 |

## Canonical standalone hero gate

A1 creates a new, repository-owned generated asset; no screenshot above may substitute for it.

| Asset | Required destination | Required dimensions | Repository SHA-256 | Generation/acceptance rule |
| --- | --- | --- | --- | --- |
| Hero master | `docs/design/assets/revelai-hero-master.png` | 1600×1200 | `42c677f39e1955b40cad63f2355332b0d0e326224fcbba0e19e7cbcd0b45924c` | Generate from the exact A1 prompt in the Core plan. It must be text-free, logo-free, sponsor-free, UI-free, and show a complete ball and athlete. Reviewer records generator run ID, SHA-256, and `accepted: true` in the A1 asset receipt before a crop may be used. |
| Web hero crop | `apps/web/public/assets/futsal-hero.png` | 1600×1200 | `42c677f39e1955b40cad63f2355332b0d0e326224fcbba0e19e7cbcd0b45924c` | Deterministic export from the accepted master; receipt records SHA-256 and master SHA. |
| Mobile hero crop | `apps/mobile/assets/futsal-hero.png` | 900×1200 | `ad74681e01bc83298239566c77a25bf5e9ae175bc539b802c91c379f4dfe6e1b` | Deterministic portrait crop from the accepted master; receipt records SHA-256 and master SHA. |

## Deterministic hero conversion

The selected built-in generation is a 1448×1086 (4:3) original, so it was resampled proportionally to the accepted 1600×1200 master without stretching. The web export is a deterministic 1600×1200 export of that master. The portrait crop is the 900×1200 rectangle at `(x: 600, y: 0)` from the master, preserving the athlete and full ball. The commands were `rtk sips --resampleHeightWidth 1200 1600 <generated-source> --out docs/design/assets/revelai-hero-master.png`, `rtk sips --resampleHeightWidth 1200 1600 docs/design/assets/revelai-hero-master.png --out apps/web/public/assets/futsal-hero.png`, and `rtk sips --cropToHeightWidth 1200 900 --cropOffset 0 600 docs/design/assets/revelai-hero-master.png --out apps/mobile/assets/futsal-hero.png`.

The A1 implementation commits `docs/design/assets/a1-asset-receipt.json` with this exact shape and asset verification rejects missing/false fields:

```json
{
  "master": {
    "generatorRunId": "non-empty string",
    "sha256": "64 lowercase hexadecimal characters",
    "width": 1600,
    "height": 1200,
    "licensedOrGenerated": "generated",
    "accepted": true,
    "checklist": {
      "noText": true,
      "noLogoOrSponsor": true,
      "noUiOrDeviceChrome": true,
      "athleteVisible": true,
      "ballVisible": true
    }
  },
  "webCrop": { "sha256": "64 lowercase hexadecimal characters", "width": 1600, "height": 1200 },
  "mobileCrop": { "sha256": "64 lowercase hexadecimal characters", "width": 900, "height": 1200 }
}
```

The `non-empty string` and hash patterns above are validation constraints, not placeholder values. A1 remains blocked until it records a real generated run and reviewer acceptance. Importer tests use source-present/source-hash-drift fixtures. Portable verifier mutation tests copy the committed tree to a temporary directory and prove missing receipt, `accepted: false`, destination hash drift, and dimension drift fail without mutating tracked files. A clean post-A1 checkout with the external source directory absent must pass `rtk pnpm verify:design-assets` using only committed assets and receipt.
