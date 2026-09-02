# CI API FFmpeg investigation — 2026-09-02

## Outcome

Hosted quality run `33689431803` failed only the C5 portable-codec smoke.
The failure was deterministic JPEG metadata incompatibility, not a timeout,
resource/concurrency issue, FFmpeg process failure, or evidence-cap breach.

Functional fix: `a56c0ca` (`fix(api): emit comment-free frame evidence`).

## Evidence and root cause

The hosted stack trace reaches `materializeFrames` at
`apps/api/src/storage/local-frame-extraction.ts:644`, the strict
`isJpeg(rawBytes)` check. It therefore passed process completion, evidence
parsing, decoded-timestamp selection, scene matching, frame naming, and size
validation before rejection.

An Ubuntu 24.04 replay using the workflow's `apt-get install ffmpeg` package
(`ffmpeg 6.1.1-3ubuntu5`) generated the same 64-second, 1280x720, 10fps MPEG-4
fixture and ran the prior owned extraction argv:

| Invariant | Result before fix |
| --- | --- |
| FFmpeg extraction / decoded files | exit 0 / 640 files |
| Decoded-showinfo / scene metadata | 640 / 600 records |
| stdout / stderr evidence | 38,220 B / 253,403 B (below 2 MiB / 343,680 B caps) |
| first JPEG size | 5,621 B (below 52,428 B cap) |
| first JPEG markers | `FFD8 FFE0 … JFIF … FFFE 0010 Lavc60.31.102` |

`0xFFFE` is a JPEG COM segment. The C5 validator deliberately accepts only
its baseline-JFIF structural subset and therefore rejects that optional FFmpeg
build comment. FFmpeg's MJPEG encoder emits the `Lavc…` COM unless bitexact
mode is selected. A YUV video-range output can also add a `CS=ITU601` COM, so
using bitexact alone would not establish the required evidence form.

## Fix

The owned image-output stream now explicitly uses:

```text
-c:v mjpeg -pix_fmt yuvj420p -bitexact
```

before the image2 output path. `mjpeg` plus full-range `yuvj420p` produces
baseline JFIF without the range COM, and `-bitexact` suppresses the build COM.
The strict JPEG parser, output caps, 30-second process bound, selection rules,
and private-file checks were not relaxed or enlarged.

The smoke's capability probe does not infer availability from inventory text.
It performs a small real pipeline: lavfi/color produces a 16x16 MPEG-4 MP4,
then FFmpeg decodes it through the same fps/split/showinfo/select/metadata
graph, emits bitexact full-range MJPEG through image2, sends the active branch
to the null muxer, and must leave a readable first frame. This covers the
lavfi input, color source, MPEG-4 encoder and decoder, MP4/image2/null
muxers, filters, and MJPEG `yuvj420p` compatibility together.

## Test-first and verification evidence

1. RED: the initial owned-argv boundary regression failed because the
   image-output options were absent.
2. GREEN: the same test passed after the single owned-argv change.
3. Ubuntu 24.04 full replay with the new argv: 640 frames, 640 showinfo
   records, 600 scene records, stdout 38,220 B, stderr 253,356 B, 5,603-B
   frame, and no `Lavc` or `CS=ITU601` comment. The produced file reports as
   baseline JFIF, and `jpeg-js` decoded it strictly to `1280x720` RGBA.
4. Review correction RED: an executable that returns complete inventory text
   but rejects real commands was incorrectly accepted by the old helper.
   The replacement real-pipeline probe rejects it; the test is GREEN.
5. Review correction RED: the exact encoder block was not immediately before
   the image path because `-y` intervened. Moving that existing global option
   before the block made the exact contiguous assertion GREEN.
6. API lint and typecheck passed; focused formatting and diff checks passed.
7. Full API suite after the correction passed: 41 files, 494 tests, 1
   expected local FFmpeg skip.

The macOS developer host has no `ffmpeg`, so the real-codec smoke remains an
honest capability skip locally. The Ubuntu replay covers the hosted codec
path; a fresh hosted CI run remains the final confirmation after the root task
pushes the commits.
