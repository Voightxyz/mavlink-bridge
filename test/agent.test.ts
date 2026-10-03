import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autopilot, violates, isStale, tidyRationale, SAFETY } from '../src/agent.js'
import { MISSION } from '../src/site.js'
import { snap, vehicle } from './helpers.js'

test('cruising with GNSS and EKF in agreement: continue', () => {
  assert.equal(autopilot(vehicle(), snap()).cmd.tool, 'continue')
})

test('GNSS/EKF divergence above the limit: return to launch', () => {
  const d = autopilot(vehicle(), snap({ divergence: SAFETY.gpsDivergenceM + 0.1 }))
  assert.equal(d.cmd.tool, 'return_to_base')
  assert.match(d.reasoning, /GNSS rejected/)
})

test('divergence exactly at the limit is still inside it', () => {
  assert.equal(autopilot(vehicle(), snap({ divergence: SAFETY.gpsDivergenceM })).cmd.tool, 'continue')
})

test('fault already detected: return to launch even if the divergence reads low', () => {
  assert.equal(autopilot(vehicle(), snap({ faultDetected: true, divergence: 3 })).cmd.tool, 'return_to_base')
})

test('battery under the reserve: return to launch', () => {
  assert.equal(autopilot(vehicle(), snap({ battery: SAFETY.minBattery - 1 })).cmd.tool, 'return_to_base')
})

test('on station: hold the inspection pass', () => {
  const d = autopilot(vehicle(), snap({ phase: 'inspect', inspect: { asset: 'FS-1', name: 'Flare stack', remaining: 3 } }))
  assert.equal(d.cmd.tool, 'continue')
  assert.match(d.reasoning, /FS-1/)
})

test('no-fly zone on the track: steer to the avoidance heading', () => {
  const d = autopilot(vehicle(MISSION.obstacles[0], 135), snap())
  assert.deepEqual(d.cmd, { tool: 'set_heading', heading: 135 })
})

test('returning home: nothing to decide', () => {
  assert.equal(autopilot(vehicle(), snap({ phase: 'rtb', divergence: 80, faultDetected: true })).cmd.tool, 'continue')
})

test('any command other than RTL breaks the rules once GNSS integrity is lost', () => {
  const s = snap({ divergence: 25 })
  for (const tool of ['continue', 'hold', 'set_heading', 'set_altitude'] as const) {
    assert.ok(violates({ tool, heading: 90, altitude: 60 }, s), tool)
  }
  assert.equal(violates({ tool: 'return_to_base' }, s), null)
})

test('altitude outside 20 to 120 m is refused in flight', () => {
  assert.ok(violates({ tool: 'set_altitude', altitude: 15 }, snap()))
  assert.ok(violates({ tool: 'set_altitude', altitude: 150 }, snap()))
  assert.equal(violates({ tool: 'set_altitude', altitude: 80 }, snap()), null)
})

test('a decision made before GNSS was rejected is stale once it is', () => {
  assert.equal(isStale(snap(), snap({ faultDetected: true })), true)
  assert.equal(isStale(snap({ faultDetected: true }), snap({ faultDetected: true })), false)
  assert.equal(isStale(snap(), snap()), false)
})

test('rationale reads like an operator log line', () => {
  assert.equal(tidyRationale('Log: Track clear to WP3 CT-1. Continue.'), 'Track clear to WP3 CT-1. Continue.')
  assert.equal(tidyRationale('Okay, I will continue \u2014 track is clear.'), 'Continue, track is clear.')
  assert.ok(tidyRationale('Clear. '.repeat(60)).length <= 160)
})
