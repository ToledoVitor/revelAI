import { log } from "node:console";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const webBundleDirectory = resolve(
  import.meta.dirname,
  "../dist/_expo/static/js/web",
);
const entryBundles = readdirSync(webBundleDirectory).filter((fileName) =>
  /^entry-[a-f0-9]+\.js$/.test(fileName),
);
const maximumRawBytes = 2_000_000;
const maximumGzipBytes = 600_000;

if (entryBundles.length !== 1) {
  throw new Error(
    `Expected one web entry bundle, found ${entryBundles.length} in ${webBundleDirectory}.`,
  );
}

const entryBundle = resolve(webBundleDirectory, entryBundles[0]);
const rawBytes = statSync(entryBundle).size;
const gzipBytes = gzipSync(readFileSync(entryBundle)).length;

if (rawBytes > maximumRawBytes || gzipBytes > maximumGzipBytes) {
  throw new Error(
    `Web entry bundle exceeds M0 bounds: ${rawBytes} raw bytes (max ${maximumRawBytes}), ${gzipBytes} gzip bytes (max ${maximumGzipBytes}).`,
  );
}

log(
  `Web entry bundle: ${rawBytes} raw bytes, ${gzipBytes} gzip bytes (limits ${maximumRawBytes}/${maximumGzipBytes}).`,
);
