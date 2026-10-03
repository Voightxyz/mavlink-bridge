/**
 * The inspection site, in local metres: x east, y north, Pad A at (120, 120).
 * Pad A is pinned to the vehicle's home position, so every MAVLink
 * coordinate maps onto the 3D view and every waypoint onto a lat/lon.
 */

export type Vec = { x: number; y: number }

export interface Asset {
  id: string
  name: string
  kind: 'stack' | 'tanks' | 'cooling'
  x: number
  y: number
}

export interface Waypoint {
  id: string
  x: number
  y: number
  alt: number
  asset: Asset
}

export interface Obstacle {
  id: string
  label: string
  x: number
  y: number
  r: number
  heightM: number
}

export interface Mission {
  id: string
  name: string
  description: string
  vehicle: string
  home: string
  base: Vec
  cruiseAlt: number
  geofenceR: number
  inspectSeconds: number
  waypoints: Waypoint[]
  obstacles: Obstacle[]
}

export const MISSION: Mission = {
  id: 'MSN-0427',
  name: 'Site inspection, North Yard',
  description: 'Inspect flare stack FS-1, tank farm TK-3 and cooling tower CT-1 at 60 m AGL. Keep clear of crane C-1. Return to Pad A.',
  vehicle: 'VX-01 · ArduCopter',
  home: 'Pad A',
  base: { x: 120, y: 120 },
  cruiseAlt: 60,
  geofenceR: 700,
  inspectSeconds: 6,
  waypoints: [
    { id: 'WP1', x: 780, y: 160, alt: 60, asset: { id: 'FS-1', name: 'Flare stack', kind: 'stack', x: 815, y: 178 } },
    { id: 'WP2', x: 820, y: 760, alt: 60, asset: { id: 'TK-3', name: 'Tank farm', kind: 'tanks', x: 862, y: 805 } },
    { id: 'WP3', x: 180, y: 820, alt: 60, asset: { id: 'CT-1', name: 'Cooling tower', kind: 'cooling', x: 135, y: 872 } },
  ],
  obstacles: [{ id: 'C-1', label: 'Crane C-1', x: 520, y: 470, r: 110, heightM: 95 }],
}

export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y)
/** 0 = north (+y), clockwise. */
export const bearing = (from: Vec, to: Vec) => norm((Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI)
export const norm = (deg: number) => ((deg % 360) + 360) % 360

const M_PER_DEG = 111_320

/** Converts between lat/lon and the site's local frame, anchored at the vehicle's home. */
export class Frame {
  constructor(
    readonly homeLat: number,
    readonly homeLon: number,
    readonly base: Vec,
  ) {}

  toLocal(lat: number, lon: number): Vec {
    const north = (lat - this.homeLat) * M_PER_DEG
    const east = (lon - this.homeLon) * M_PER_DEG * Math.cos((this.homeLat * Math.PI) / 180)
    return { x: this.base.x + east, y: this.base.y + north }
  }

  toGeo(p: Vec): { lat: number; lon: number } {
    const lat = this.homeLat + (p.y - this.base.y) / M_PER_DEG
    const lon = this.homeLon + (p.x - this.base.x) / (M_PER_DEG * Math.cos((this.homeLat * Math.PI) / 180))
    return { lat, lon }
  }

  /** Metres north/east as degrees at the home latitude. */
  offsetDeg(north: number, east: number): { dLat: number; dLon: number } {
    return { dLat: north / M_PER_DEG, dLon: east / (M_PER_DEG * Math.cos((this.homeLat * Math.PI) / 180)) }
  }
}

/** First obstacle whose no-fly circle (plus margin) the straight track from `from` to `to` crosses. */
export function obstacleOnTrack(from: Vec, to: Vec, obstacles: Obstacle[], margin = 25): Obstacle | null {
  for (const o of obstacles) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len2 = dx * dx + dy * dy || 1
    const u = Math.max(0, Math.min(1, ((o.x - from.x) * dx + (o.y - from.y) * dy) / len2))
    const px = from.x + u * dx
    const py = from.y + u * dy
    if (Math.hypot(px - o.x, py - o.y) < o.r + margin) return o
  }
  return null
}

/** Tangent point around an obstacle, on the side closer to the target. */
export function avoidancePoint(pos: Vec, to: Vec, o: Obstacle, margin = 35): Vec {
  const base = Math.atan2(o.y - pos.y, o.x - pos.x)
  const left = { x: o.x + Math.cos(base + Math.PI / 2) * (o.r + margin), y: o.y + Math.sin(base + Math.PI / 2) * (o.r + margin) }
  const right = { x: o.x + Math.cos(base - Math.PI / 2) * (o.r + margin), y: o.y + Math.sin(base - Math.PI / 2) * (o.r + margin) }
  return dist(left, to) < dist(right, to) ? left : right
}
