import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MediaUploadContext } from "../repositories/attempt-repository.js";
import type { MediaUploadService } from "../services/media-upload-service.js";
import { fastifyRoutePath, type ApiRouteContract } from "./openapi.js";
import {
  createStreamingMultipartIntake,
  drainMediaUploadRequest,
  MultipartParserError,
  prepareMediaMultipartRequest,
  wrapMediaMultipartPayload,
} from "./streamed-multipart.js";

/**
 * Encapsulates the multipart parser, drain hook, and one upload route in a
 * Fastify child scope. Other attempt routes never inherit this parser state.
 */
export function registerAttemptMediaUploadPlugin(
  app: FastifyInstance,
  input: Readonly<{
    /** Internal application-composition seam, never an adapter capability. */
    mediaUpload: MediaUploadService;
    route: ApiRouteContract;
    maxUploadBytes: number;
    maxMultipartBytes: number;
    requiredAthleteId(request: FastifyRequest): string;
    attemptId(request: FastifyRequest): string;
    sendAccepted(reply: FastifyReply, value: unknown): unknown;
  }>,
): void {
  const mediaUpload = input.mediaUpload;
  const route = input.route;
  if (!route.multipart)
    throw new Error("C2 media upload route requires multipart wire contract.");
  app.register((mediaApp, _options, done) => {
    const mediaUploads = new WeakMap<FastifyRequest, MediaUploadContext>();
    mediaApp.addContentTypeParser(
      "multipart/form-data",
      (_request, _payload, callback) => callback(null, undefined),
    );
    mediaApp.addHook("onResponse", async (request) => {
      drainMediaUploadRequest(request, input.maxMultipartBytes);
    });
    mediaApp.route({
      method: "POST",
      url: fastifyRoutePath(route),
      onRequest: async (request) => {
        const upload = await mediaUpload.preflight({
          attemptId: input.attemptId(request),
          athleteId: input.requiredAthleteId(request),
        });
        prepareMediaMultipartRequest(request, {
          maxUploadBytes: input.maxUploadBytes,
          maxMultipartBytes: input.maxMultipartBytes,
        });
        mediaUploads.set(request, upload);
      },
      preParsing: (request, _reply, payload, callback) => {
        try {
          callback(null, wrapMediaMultipartPayload(request, payload));
        } catch (error) {
          callback(error instanceof Error ? error : new MultipartParserError());
        }
      },
      handler: async (request, reply) => {
        const upload = mediaUploads.get(request);
        if (!upload) throw new MultipartParserError();
        const accepted = await mediaUpload.accept({
          context: upload,
          multipart: createStreamingMultipartIntake(request),
        });
        return input.sendAccepted(reply, accepted);
      },
    });
    done();
  });
}
