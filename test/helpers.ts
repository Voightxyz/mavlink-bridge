import type { Snapshot, Vehicle } from '../src/vehicle.js'
import { MISSION, type Obstacle } from '../src/site.js'

/** A cruising, healthy snapshot; override what a test needs. */
export function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    t: 120,
    tick: 1200,
    phase: 'enroute',
    pos: { x: 500, y: 300 },
    gpsPos: { x: 501, y: 301 },
    inertialPos: { x: 500, y: 300 },
    alt: 60,
    vs: 0,
    heading: 90,
    speed: 10.3,
    battery: 80,
    voltage: 12.6,
    sats: 17,
    hdop: 1.21,
    wind: { x: 0, y: 0 },
    targetWp: 1,
    wpReached: 1,
    progress: 0.4,
    divergence: 1.4,
    faultActive: false,
    faultDetected: false,
    distToBase: 420,
    distToTarget: 460,
    inspect: null,
    cmd: { tool: 'continue' },
    navSource: 'GNSS',
    ekfPosRatio: 0.02,
    ekfGpsGlitch: false,
    apMode: 'GUIDED',
    armed: true,
    link: { connected: true, rate: 220 },
    preflight: null,
    lat: -35.36,
    lon: 149.16,
    ...over,
  }
}

/** The parts of Vehicle the agent reads, with an optional obstacle on the track. */
export function vehicle(obstacle: Obstacle | null = null, avoidance = 135): Vehicle {
  return {
    mission: MISSION,
    obstacleAhead: () => obstacle,
    avoidanceHeading: () => avoidance,
    directHeading: () => 90,
  } as unknown as Vehicle
}
