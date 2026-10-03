import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Frame, MISSION, obstacleOnTrack, avoidancePoint, dist, bearing } from '../src/site.js'

const frame = new Frame(-35.363261, 149.16523, MISSION.base)

test('Pad A sits on the vehicle home', () => {
  const p = frame.toLocal(-35.363261, 149.16523)
  assert.ok(dist(p, MISSION.base) < 1e-6)
})

test('local metres and lat/lon round-trip', () => {
  for (const wp of MISSION.waypoints) {
    const { lat, lon } = frame.toGeo(wp)
    assert.ok(dist(frame.toLocal(lat, lon), wp) < 0.01, wp.id)
  }
})

test('100 m north is about 0.0009 degrees of latitude', () => {
  const { lat } = frame.toGeo({ x: MISSION.base.x, y: MISSION.base.y + 100 })
  assert.ok(Math.abs(lat - -35.363261 - 100 / 111_320) < 1e-9)
})

test('bearing: 0 is north, 90 is east', () => {
  assert.equal(bearing({ x: 0, y: 0 }, { x: 0, y: 10 }), 0)
  assert.equal(bearing({ x: 0, y: 0 }, { x: 10, y: 0 }), 90)
})

test('none of the planned legs crosses the crane no-fly zone', () => {
  const route = [MISSION.base, ...MISSION.waypoints, MISSION.base]
  for (let i = 1; i < route.length; i++) assert.equal(obstacleOnTrack(route[i - 1], route[i], MISSION.obstacles), null)
})

test('a track through the crane is caught, and the detour clears it', () => {
  const crane = MISSION.obstacles[0]
  const from = { x: crane.x - 300, y: crane.y }
  const to = { x: crane.x + 300, y: crane.y }
  assert.equal(obstacleOnTrack(from, to, MISSION.obstacles)?.id, crane.id)
  assert.ok(dist(avoidancePoint(from, to, crane), crane) > crane.r)
})
