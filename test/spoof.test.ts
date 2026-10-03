import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GnssSpoofer } from '../src/spoof.js'
import { Frame, MISSION } from '../src/site.js'
import type { Mav } from '../src/mav.js'

const frame = new Frame(-35.363261, 149.16523, MISSION.base)

function fakeMav() {
  const params: Record<string, number> = {}
  const mav = { setParam: async (name: string, value: number) => void (params[name] = value) } as unknown as Mav
  return { mav, params }
}

/** Metres north/east encoded in the glitch parameters. */
function offsetM(params: Record<string, number>) {
  const one = frame.offsetDeg(1, 1)
  return { north: params.SIM_GPS1_GLTCH_X / one.dLat, east: params.SIM_GPS1_GLTCH_Y / one.dLon }
}

test('the false position walks away at 4 m/s, north-north-east', async () => {
  const { mav, params } = fakeMav()
  const s = new GnssSpoofer(mav)
  s.start(100)
  await s.update(110, frame)
  const o = offsetM(params)
  assert.ok(Math.abs(Math.hypot(o.north, o.east) - 40) < 0.01)
  assert.ok(Math.abs((Math.atan2(o.east, o.north) * 180) / Math.PI - 30) < 0.01)
})

test('the walk stops at 140 m', async () => {
  const { mav, params } = fakeMav()
  const s = new GnssSpoofer(mav)
  s.start(0)
  await s.update(500, frame)
  const o = offsetM(params)
  assert.ok(Math.abs(Math.hypot(o.north, o.east) - 140) < 0.01)
})

test('stop clears the glitch', async () => {
  const { mav, params } = fakeMav()
  const s = new GnssSpoofer(mav)
  s.start(0)
  await s.update(10, frame)
  await s.stop()
  assert.equal(params.SIM_GPS1_GLTCH_X, 0)
  assert.equal(params.SIM_GPS1_GLTCH_Y, 0)
  assert.equal(s.active, false)
})
