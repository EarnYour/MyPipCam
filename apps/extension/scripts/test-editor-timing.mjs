/**
 * Lightweight unit checks for editor EDL timing helpers (no test runner).
 * Run: node scripts/test-editor-timing.mjs
 */
import assert from 'node:assert/strict'

/** @typedef {{ start: number, end: number }} TimeRange */

/** @param {TimeRange[]} ranges @param {number} [gap] */
function mergeRanges(ranges, gap = 0.02) {
  const sorted = [...ranges]
    .filter((r) => r.end > r.start + gap)
    .sort((a, b) => a.start - b.start)
  const merged = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + gap) {
      last.end = Math.max(last.end, r.end)
    } else {
      merged.push({ ...r })
    }
  }
  return merged
}

/** @param {TimeRange[]} ranges @param {number} t */
function rangeContaining(ranges, t) {
  for (const r of ranges) {
    if (t >= r.start && t < r.end) return r
  }
  return null
}

/**
 * Mirrors silenceDetect.nextPlayableTime — keep in sync when changing the helper.
 * @param {number} t
 * @param {number} inSec
 * @param {number} outSec
 * @param {TimeRange[]} removes
 */
function nextPlayableTime(t, inSec, outSec, removes) {
  if (!(outSec > inSec)) return { time: inSec, ended: true }

  const merged = mergeRanges(
    removes.map((r) => ({
      start: Math.max(inSec, r.start),
      end: Math.min(outSec, r.end),
    })),
  )

  let time = Math.min(Math.max(t, inSec), outSec)
  if (time >= outSec) return { time: outSec, ended: true }

  for (let i = 0; i < merged.length + 2; i++) {
    const hit = rangeContaining(merged, time)
    if (!hit) return { time, ended: false }
    if (hit.end >= outSec - 1e-3) return { time: outSec, ended: true }
    time = hit.end
  }

  return { time: outSec, ended: true }
}

// Keep outside cuts
assert.deepEqual(nextPlayableTime(1, 0, 10, [{ start: 3, end: 5 }]), {
  time: 1,
  ended: false,
})

// Inside a middle cut → jump to cut end (next keep)
assert.deepEqual(nextPlayableTime(4, 0, 10, [{ start: 3, end: 5 }]), {
  time: 5,
  ended: false,
})

// Exactly at cut start → skip
assert.deepEqual(nextPlayableTime(3, 0, 10, [{ start: 3, end: 5 }]), {
  time: 5,
  ended: false,
})

// At cut end (half-open) → playable
assert.deepEqual(nextPlayableTime(5, 0, 10, [{ start: 3, end: 5 }]), {
  time: 5,
  ended: false,
})

// Cut through out → ended
assert.deepEqual(nextPlayableTime(8, 0, 10, [{ start: 7, end: 10 }]), {
  time: 10,
  ended: true,
})

// Adjacent cuts merge then skip both
assert.deepEqual(
  nextPlayableTime(2.5, 0, 20, [
    { start: 2, end: 4 },
    { start: 4.01, end: 6 },
  ]),
  { time: 6, ended: false },
)

// Clamp below in
assert.deepEqual(nextPlayableTime(-1, 1, 10, []), { time: 1, ended: false })

console.log('test-editor-timing: ok')
