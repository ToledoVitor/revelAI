export type AcceptedMediaMime = "video/mp4" | "video/quicktime" | "video/webm";

export function selectedMediaMime(file: File): AcceptedMediaMime | undefined {
  const extension = file.name.toLowerCase().split(".").at(-1);
  const expectedMime =
    extension === "mp4"
      ? "video/mp4"
      : extension === "mov"
        ? "video/quicktime"
        : extension === "webm"
          ? "video/webm"
          : undefined;

  if (!expectedMime) return undefined;
  const declaredMime = file.type.split(";", 1)[0]?.trim().toLowerCase();
  return declaredMime === "" || declaredMime === expectedMime
    ? expectedMime
    : undefined;
}

/** Normalization is transport-only; it does not add verified capture policy. */
export function normalizeSelectedMedia(
  sourceFile: File,
): Readonly<{ file: File; wireMime: AcceptedMediaMime }> | undefined {
  const wireMime = selectedMediaMime(sourceFile);
  if (!wireMime) return undefined;
  return {
    file:
      sourceFile.type === wireMime
        ? sourceFile
        : new File([sourceFile], sourceFile.name, { type: wireMime }),
    wireMime,
  };
}
