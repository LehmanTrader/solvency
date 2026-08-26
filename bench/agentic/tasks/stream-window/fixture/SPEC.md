# Event-time windows

`createWindows(sizeMs, latenessMs, onFinal)` -> `{ add, watermark, pending }`.

Tumbling windows aligned to epoch: window W covers `[W*sizeMs, (W+1)*sizeMs)`.

- `add(ts, value)`: place the event in its window and return `'ok'`, unless the
  window is already finalized — then return `'late'` and change nothing.
- `watermark(ts)`: advance the watermark to `ts` (never backwards; a smaller ts is a
  no-op). Advancing finalizes — in ascending window order — every window whose end
  + latenessMs <= watermark. For each, call `onFinal({ start, end, count, sum, min, max })`.
  Windows never receiving events emit nothing.
- Events at or ahead of the watermark are normal; only finalization gates lateness.
- `pending()` -> array of not-yet-final window starts, ascending.
- `add` after finalize must not resurrect a window; `watermark` must be idempotent.
