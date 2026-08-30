/**
 * Compatibility export for the C5 stored-media extraction capability. The
 * implementation intentionally lives beside local private storage so callers
 * cannot provide, learn, or persist media paths.
 */
export {
  LocalFrameExtraction as FfmpegFrameExtractor,
  type BoundedFrameProcessRunner as FrameExtractionRunner,
  type FrameRetentionRepository,
} from "../storage/local-frame-extraction.js";
