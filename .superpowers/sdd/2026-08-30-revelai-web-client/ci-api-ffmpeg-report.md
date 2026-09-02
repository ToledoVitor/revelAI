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

## Hosted timeout recovery

Hosted retry `33693218189` proved the JPEG correction: the COM rejection was
gone. Its only API failure was instead Vitest's implicit 5,000-ms budget on
the now-complete smoke (reported duration 5,071 ms), followed by
`ENOTEMPTY` while `afterEach` tried to remove the `.frames` directory. That
second error identified a test-harness lifecycle race: a timed-out promise
could still have an FFmpeg child writing its owned directory while cleanup
removed it. It was not a production 30-second runner timeout, a process
failure, or a weaker C5 evidence invariant.

Commit `19bda2b` scopes a 15,000-ms timeout to this one integration smoke.
The budget covers its real mini-probe, 64-second fixture encoding, and
640-frame extraction, remains below the production extraction bound of
30,000 ms, and does not alter global Vitest configuration. A native Ubuntu
24.04 single-CPU replay measured the actual mini-probe at 68 ms and the full
640-file path at 4,473 ms; the hosted 5,071-ms end-to-end observation leaves
about 10 seconds of targeted headroom.

The smoke now tracks every child it owns, including both capability commands,
fixture generation, and the extractor. Its suite cleanup first sends SIGTERM,
waits for each child `close`, and only then removes test roots; a 1,000-ms
SIGKILL escalation mirrors the existing production process runner rather than
adding an arbitrary delay. Vitest's local runner confirms `afterEach` runs
before `onTestFinished`, so the cancellation-safe cleanup intentionally lives
in `afterEach` rather than a later test hook.

RED: a new lifecycle regression passed a tracking set to the old test helper
and observed zero owned children instead of one. GREEN: the tracked child is
terminated, its close is awaited, the set empties, and only then can its root
be removed. Focused verification passed 15 tests with one honest local
no-FFmpeg skip. API lint, typecheck, and formatting passed; the full API suite
passed 41 files, 495 tests, with one expected local capability skip.

### Teardown review correction

Sol's follow-up found two remaining races in `19bda2b`. A child `error` event
could previously clear its forced-kill timer and release cleanup before the
actual `close` event. Separately, teardown took one `Set` snapshot: after
child A closed, the smoke continuation could register child B after that
snapshot while root removal proceeded. Both failures would recreate the
`ENOTEMPTY` race despite the scoped timeout.

Commit `3d549b8` replaces that shared set with a fresh tracker for every test
generation. Closing the tracker happens before it drains; children registered
afterward are immediately terminated and the drain loops until the tracker is
empty. An error is now only retained for the eventual result—only `close` may
clear escalation, release tracking, settle the result, and resolve the close
waiter. Result settlement intentionally precedes that waiter so A's
continuation can register B before draining resumes.

RED/GREEN coverage now includes a child whose termination reports an error
before close, proving root cleanup still waits for close, and an A-success →
B-registration teardown sequence, proving B is terminated and root cleanup
does not finish until B closes. Focused verification passed 17 tests with one
honest local no-FFmpeg skip; API lint, typecheck, and formatting passed. A
first full API run exposed an unrelated intermittent SQLite migration
contention (`database is locked`); its exact focused test passed twice, and a
fresh full API run passed 41 files, 497 tests, with one expected skip.

### Admission and multi-error correction

Sol's next review found that `3d549b8` still admitted a late successor by
spawning it before registration. If draining had already observed an empty
tracker, an asynchronous A continuation could start B while root cleanup was
under way. It also found that the single-use error listener handled a TERM
error but left a later SIGKILL error unhandled.

Commit `bd57535` reserves tracker admission synchronously before spawning.
Once a test generation is closing, reservation fails and `runProcess` rejects
without calling its spawner; a failed spawn releases its reservation. The
error listener now remains installed until close, retains the first error for
the result, and handles later forced-kill errors without releasing the
tracker. The normal 1,000-ms grace remains unchanged; only the controlled
unit regression injects a 1-ms grace.

RED/GREEN coverage delays B until after `closeAndDrain` resolves and proves
its spawner is never called, so it cannot race root removal. A second
TERM-error → SIGKILL-error → close regression proves both errors are handled,
the first is reported, and release still happens only at close. Focused
verification passed 19 tests with one honest local no-FFmpeg skip; API lint,
typecheck, and formatting passed. The fresh full API suite passed 41 files,
500 tests, with one expected skip.

The macOS developer host has no `ffmpeg`, so the real-codec smoke remains an
honest capability skip locally. The Ubuntu replay covers the hosted codec
path; a fresh hosted CI run remains the final confirmation after the root task
pushes the commits.
