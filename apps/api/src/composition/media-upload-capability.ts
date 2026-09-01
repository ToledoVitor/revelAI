import {
  createUnavailableMediaUploadService,
  type MediaUploadService,
} from "../services/media-upload-service.js";

/**
 * Opaque HTTP-facing handle. Its service is intentionally recoverable only by
 * this composition boundary, never from structural fields supplied to HTTP.
 */
export type MediaUploadCapability = object;

export type MediaUploadCapabilityHost = Readonly<{
  repository: object;
  queue: object;
}>;

type IssuedMediaUploadCapability = Readonly<{
  service: MediaUploadService;
  host: MediaUploadCapabilityHost;
}>;

const issuedMediaUploadCapabilities = new WeakMap<
  object,
  IssuedMediaUploadCapability
>();

/** Issues the frozen capability after an outer composition has sealed its ports. */
export function issueMediaUploadCapability(
  service: MediaUploadService,
  host: MediaUploadCapabilityHost,
): MediaUploadCapability {
  const capability = Object.freeze({});
  issuedMediaUploadCapabilities.set(
    capability,
    Object.freeze({ service, host: Object.freeze({ ...host }) }),
  );
  return capability;
}

/** The default API path has no C5 composition and fails without host details. */
export function createUnavailableMediaUploadCapability(
  host: MediaUploadCapabilityHost,
): MediaUploadCapability {
  return issueMediaUploadCapability(
    createUnavailableMediaUploadService(),
    host,
  );
}

/** Resolves an exact capability without exposing its service or host internals. */
export function resolveMediaUploadCapability(
  value: unknown,
): MediaUploadService | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return issuedMediaUploadCapabilities.get(value)?.service;
}

/** Resolves only a capability issued for the exact API repository and queue. */
export function resolveMediaUploadCapabilityForHost(
  value: unknown,
  host: MediaUploadCapabilityHost,
): MediaUploadService | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const issued = issuedMediaUploadCapabilities.get(value);
  if (
    !issued ||
    issued.host.repository !== host.repository ||
    issued.host.queue !== host.queue
  )
    return undefined;
  return issued.service;
}
