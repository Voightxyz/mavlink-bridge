/**
 * Mission executive on top of a real autopilot. ArduPilot flies the
 * aircraft (attitude, position control, EKF navigation); this class decides
 * where it should go: GUIDED position targets for each leg, an inspection
 * pass on station at each asset with the nose on the asset, a detour
 * around the crane no-fly zone, RTL at the end. The agent's tools become
 * MAVLink messages, and each one returns what the autopilot answered.
 *
 * Everything the view and the agent read comes from MAVLink telemetry:
 * GLOBAL_POSITION_INT (EKF estimate), GPS_RAW_INT (receiver), SIMSTATE
 * (simulator truth, used only to draw the aircraft), EKF_STATUS_REPORT,
 * VFR_HUD, SYS_STATUS, WIND, HEARTBEAT, STATUSTEXT.
 */

import { EventEmitter } from 'node:events'
import type { Mav, CommandResult } from './mav.js'
import { MISSION, Frame, dist, bearing, norm, obstacleOnTrack, avoidancePoint, type Mission, type Vec, type Obstacle } from './site.js'

export type Phase = 'ground' | 'takeoff' | 'enroute' | 'inspect' | 'hold' | 'rtb' | 'landing' | 'landed' | 'aborted'

export interface Command {
  tool: 'set_heading' | 'set_altitude' | 'hold' | 'return_to_base' | 'continue'
  heading?: number
  altitude?: number
}

/** One MAVLink exchange: what was sent and, for commands, what the autopilot answered. */
export interface MavOp {
  message: string
  command?: string
  params?: number[] | Record<string, number | string>
  result?: string
  ok: boolean
  ms?: number
}

export interface Snapshot {
  t: number
  tick: number
  phase: Phase
  pos: Vec
  gpsPos: Vec
  inertialPos: Vec
  alt: number
  vs: number
  heading: number
  speed: number
  battery: number
  voltage: number
  sats: number
  hdop: number
  wind: Vec
  targetWp: number
  wpReached: number
  progress: number
  divergence: number
  faultActive: boolean
  faultDetected: boolean
  distToBase: number
  distToTarget: number
  inspect: { asset: string; name: string; remaining: number } | null
  cmd: Command
  // MAVLink specifics
  navSource: 'GNSS' | 'VIO'
  ekfPosRatio: number
  ekfGpsGlitch: boolean
  apMode: string
  armed: boolean
  link: { connected: boolean; rate: number }
  preflight: string | null
  lat: number
  lon: number
}

const ESTIMATOR_GPS_GLITCH = 32768

const opFromCommand = (r: CommandResult): MavOp => ({ message: 'COMMAND_LONG', command: r.command, params: r.params, result: r.result, ok: r.ok, ms: r.ms })
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d

export class Vehicle extends EventEmitter {
  readonly mission: Mission = MISSION
  frame: Frame | null = null
  phase: Phase = 'ground'
  cmd: Command = { tool: 'continue' }
  targetWp = 0
  wpReached = 0
  faultActive = false
  faultDetected = false
  navSource: 'GNSS' | 'VIO' = 'GNSS'
  cruiseAlt = MISSION.cruiseAlt
  preflight: string | null = 'Connecting to autopilot'
  tick = 0
  readonly statusLog: { t: number; severity: number; text: string }[] = []

  private t0Boot = -1
  private legStart: Vec = { ...MISSION.base }
  private cmdHeading = 0
  private headingOverrideUntil = -1
  private inspectUntil = -1
  private holdPos: Vec | null = null
  private lastTargetAt = 0
  private lastTargetKey = ''
  private starting = false
  private ticking = false

  constructor(private mav: Mav) {
    super()
    mav.on('msg', (name: string, d: any) => {
      if (name === 'STATUSTEXT') {
        const text = String(d.text ?? '').replace(/\0/g, '').trim()
        if (!text) return
        this.statusLog.push({ t: this.t, severity: d.severity, text })
        if (this.statusLog.length > 30) this.statusLog.shift()
        if (this.phase === 'ground' && /^(PreArm|Arm):/.test(text)) this.preflight = text.replace(/^(PreArm|Arm):\s*/, '')
        this.emit('statustext', { severity: d.severity, text })
      }
    })
  }

  // ── Telemetry ────────────────────────────────────────────────────────────

  private get gpi() {
    return this.mav.last.GLOBAL_POSITION_INT
  }

  /** Simulated mission time in seconds (autopilot boot clock, so it follows the SITL speed-up). */
  get t(): number {
    const ms = this.gpi?.timeBootMs
    if (ms == null || this.t0Boot < 0) return 0
    return Math.max(0, (ms - this.t0Boot) / 1000)
  }

  get ekfPos(): Vec {
    const g = this.gpi
    return g && this.frame ? this.frame.toLocal(g.lat / 1e7, g.lon / 1e7) : { ...this.mission.base }
  }

  get gnssPos(): Vec {
    const g = this.mav.last.GPS_RAW_INT
    return g && this.frame && g.fixType >= 3 ? this.frame.toLocal(g.lat / 1e7, g.lon / 1e7) : this.ekfPos
  }

  /** Simulator ground truth. Only the 3D view uses it, to draw where the aircraft really is. */
  get truePos(): Vec {
    const s = this.mav.last.SIMSTATE
    return s && this.frame ? this.frame.toLocal(s.lat / 1e7, s.lng / 1e7) : this.ekfPos
  }

  get relAlt(): number {
    return (this.gpi?.relativeAlt ?? 0) / 1000
  }

  get divergence(): number {
    return dist(this.gnssPos, this.ekfPos)
  }

  get ekfPosRatio(): number {
    return this.mav.last.EKF_STATUS_REPORT?.posHorizVariance ?? 0
  }

  get activeWaypoint() {
    return this.mission.waypoints[Math.min(this.targetWp, this.mission.waypoints.length - 1)]
  }

  get target(): Vec {
    if (this.phase === 'rtb' || this.phase === 'landing' || this.phase === 'landed') return this.mission.base
    const wp = this.activeWaypoint
    return { x: wp.x, y: wp.y }
  }

  get progress(): number {
    const n = this.mission.waypoints.length + 1
    if (this.phase === 'landed') return 1
    if (this.phase === 'ground') return 0
    const legIdx = this.phase === 'rtb' || this.phase === 'landing' ? n - 1 : Math.min(this.targetWp, n - 1)
    const legLen = Math.max(1, dist(this.legStart, this.target))
    const frac = this.phase === 'inspect' ? 1 : Math.min(1, 1 - dist(this.ekfPos, this.target) / legLen)
    return Math.min(1, (legIdx + Math.max(0, frac)) / n)
  }

  obstacleAhead(): Obstacle | null {
    return obstacleOnTrack(this.ekfPos, this.target, this.mission.obstacles)
  }

  avoidanceHeading(o: Obstacle): number {
    return Math.round(bearing(this.ekfPos, avoidancePoint(this.ekfPos, this.target, o)))
  }

  directHeading(): number {
    return Math.round(bearing(this.ekfPos, this.target))
  }

  // ── Mission control ──────────────────────────────────────────────────────

  /** Anchors Pad A on the vehicle's home, only once the autopilot has a real position (never on 0,0 before the first fix). */
  private ensureFrame() {
    const home = this.mav.last.HOME_POSITION
    const fix = (this.mav.last.GPS_RAW_INT?.fixType ?? 0) >= 3
    if (home && (home.latitude !== 0 || home.longitude !== 0)) this.frame = new Frame(home.latitude / 1e7, home.longitude / 1e7, this.mission.base)
    else if (!this.frame && fix && this.gpi && (this.gpi.lat !== 0 || this.gpi.lon !== 0)) this.frame = new Frame(this.gpi.lat / 1e7, this.gpi.lon / 1e7, this.mission.base)
  }

  /** Reset for a new mission. The aircraft must be on the ground. */
  reset() {
    this.phase = 'ground'
    this.cmd = { tool: 'continue' }
    this.targetWp = 0
    this.wpReached = 0
    this.faultActive = false
    this.faultDetected = false
    this.cruiseAlt = this.mission.cruiseAlt
    this.t0Boot = -1
    this.legStart = { ...this.mission.base }
    this.headingOverrideUntil = -1
    this.inspectUntil = -1
    this.holdPos = null
    this.lastTargetKey = ''
    this.tick = 0
  }

  /** Back to GNSS navigation, GUIDED, arm (retrying through pre-arm checks), takeoff. */
  async launch(): Promise<MavOp[]> {
    if (this.starting) return []
    this.starting = true
    const ops: MavOp[] = []
    try {
      if (this.navSource !== 'GNSS') {
        const r = await this.mav.setEkfSourceSet(1)
        if (r.ok) this.navSource = 'GNSS'
      }
      // Fresh pack for every mission.
      await this.mav.resetBattery().catch(() => null)
      const deadline = Date.now() + 180_000
      while (!this.mav.armed && Date.now() < deadline) {
        await this.mav.setMode('GUIDED')
        const r = await this.mav.arm()
        if (r.ok) {
          ops.push(opFromCommand(r))
          break
        }
        await new Promise((res) => setTimeout(res, 1500))
      }
      if (!this.mav.armed) await new Promise((res) => setTimeout(res, 500))
      if (!this.mav.armed) throw new Error(`arming refused: ${this.preflight ?? 'unknown'}`)
      this.preflight = null
      this.ensureFrame()
      const tk = await this.mav.takeoff(this.cruiseAlt)
      ops.push(opFromCommand(tk))
      if (!tk.ok) throw new Error(`takeoff ${tk.result}`)
      this.t0Boot = this.gpi?.timeBootMs ?? 0
      this.phase = 'takeoff'
      this.cmdHeading = Math.round(bearing(this.mission.base, this.target))
      return ops
    } finally {
      this.starting = false
    }
  }

  private async sendTarget(p: Vec, alt: number, yawDeg?: number, force = false): Promise<MavOp | null> {
    if (!this.frame) return null
    const { lat, lon } = this.frame.toGeo(p)
    const key = `${p.x.toFixed(0)},${p.y.toFixed(0)},${alt.toFixed(0)},${yawDeg?.toFixed(0) ?? '-'}`
    const now = Date.now()
    if (!force && key === this.lastTargetKey && now - this.lastTargetAt < 1000) return null
    this.lastTargetKey = key
    this.lastTargetAt = now
    await this.mav.positionTarget(lat, lon, alt, yawDeg)
    const params: Record<string, number> = { lat: round(lat, 7), lon: round(lon, 7), alt_m: round(alt, 1) }
    if (yawDeg !== undefined) params.yaw_deg = Math.round(yawDeg)
    return { message: 'SET_POSITION_TARGET_GLOBAL_INT', params, ok: true }
  }

  private headingPoint(fromP: Vec, hdg: number, len = 250): Vec {
    const r = (hdg * Math.PI) / 180
    return { x: fromP.x + Math.sin(r) * len, y: fromP.y + Math.cos(r) * len }
  }

  /** Executive step, called ~10 times per second. */
  async step() {
    if (this.ticking) return
    this.ticking = true
    try {
      if (!this.frame || this.phase === 'ground') this.ensureFrame()
      if (this.phase === 'ground' && !this.starting && this.preflight === 'Connecting to autopilot' && this.mav.connected && this.gpi) this.preflight = 'Pre-flight checks'
      if (this.phase === 'ground' || this.phase === 'landed' || this.phase === 'aborted') return
      this.tick++
      const t = this.t
      const pos = this.ekfPos
      const mode = this.mav.mode
      const flying = this.mav.armed

      // The autopilot can change mode on its own (failsafes): follow it.
      if (flying && mode === 'LAND' && this.phase !== 'landing') this.phase = 'landing'
      if (flying && mode === 'RTL' && (this.phase === 'enroute' || this.phase === 'inspect' || this.phase === 'hold' || this.phase === 'takeoff')) {
        this.phase = 'rtb'
        this.legStart = pos
      }

      switch (this.phase) {
        case 'takeoff':
          if (this.relAlt >= this.cruiseAlt - 1.5) {
            this.phase = 'enroute'
            this.legStart = pos
          }
          break
        case 'enroute': {
          const wp = this.activeWaypoint
          if (dist(pos, wp) < 8) {
            this.phase = 'inspect'
            this.inspectUntil = t + this.mission.inspectSeconds
            await this.sendTarget(wp, this.cruiseAlt, bearing(wp, wp.asset), true)
            break
          }
          let aim: Vec = wp
          if (t < this.headingOverrideUntil) aim = this.headingPoint(pos, this.cmdHeading)
          else {
            const o = this.obstacleAhead()
            if (o) aim = avoidancePoint(pos, wp, o)
          }
          await this.sendTarget(aim, this.cruiseAlt)
          break
        }
        case 'inspect': {
          const wp = this.activeWaypoint
          await this.sendTarget(wp, this.cruiseAlt, bearing(wp, wp.asset))
          if (t >= this.inspectUntil) {
            this.wpReached++
            if (this.targetWp < this.mission.waypoints.length - 1) {
              this.targetWp++
              this.phase = 'enroute'
              this.legStart = pos
            } else {
              const r = await this.mav.setMode('RTL')
              this.phase = 'rtb'
              this.legStart = pos
              this.emit('auto', { tool: 'return_to_base', reason: 'All assets inspected. RTL to Pad A.', op: opFromCommand(r) })
            }
          }
          break
        }
        case 'hold':
          if (this.holdPos) await this.sendTarget(this.holdPos, this.cruiseAlt)
          break
        case 'rtb': {
          const descending = (this.gpi?.vz ?? 0) > 30 // cm/s, positive down
          if (mode === 'LAND' || (dist(pos, this.mission.base) < 6 && descending)) this.phase = 'landing'
          break
        }
        case 'landing':
          break
      }
      if ((this.phase === 'landing' || this.phase === 'rtb') && !flying && this.relAlt < 1) this.phase = 'landed'
    } finally {
      this.ticking = false
    }
  }

  /** Executes an agent command. Returns the MAVLink exchanges it took. */
  async apply(cmd: Command): Promise<MavOp[]> {
    this.cmd = cmd
    const ops: MavOp[] = []
    const pos = this.ekfPos
    switch (cmd.tool) {
      case 'set_heading':
        if (typeof cmd.heading === 'number' && Number.isFinite(cmd.heading) && (this.phase === 'enroute' || this.phase === 'hold')) {
          this.phase = 'enroute'
          this.cmdHeading = norm(cmd.heading)
          this.headingOverrideUntil = this.t + 8
          const op = await this.sendTarget(this.headingPoint(pos, this.cmdHeading), this.cruiseAlt, undefined, true)
          if (op) ops.push(op)
        }
        break
      case 'set_altitude':
        if (typeof cmd.altitude === 'number' && Number.isFinite(cmd.altitude)) {
          this.cruiseAlt = Math.max(20, Math.min(120, cmd.altitude))
          const aim = this.phase === 'hold' && this.holdPos ? this.holdPos : this.phase === 'inspect' || this.phase === 'enroute' ? this.activeWaypoint : pos
          const op = await this.sendTarget(aim, this.cruiseAlt, undefined, true)
          if (op) ops.push(op)
        }
        break
      case 'hold':
        if (this.phase === 'enroute') {
          this.phase = 'hold'
          this.holdPos = pos
          const op = await this.sendTarget(pos, this.cruiseAlt, undefined, true)
          if (op) ops.push(op)
        }
        break
      case 'return_to_base':
        if (this.phase !== 'landed' && this.phase !== 'ground' && this.phase !== 'landing' && this.phase !== 'rtb') {
          const r = await this.mav.setMode('RTL')
          ops.push(opFromCommand(r))
          if (r.ok) {
            this.phase = 'rtb'
            this.legStart = pos
          }
        }
        break
      case 'continue':
        if (this.phase === 'hold') this.phase = 'enroute'
        break
    }
    return ops
  }

  /** Stop fusing GNSS: switch the EKF to source set 2 (visual-inertial odometry). */
  async rejectGnss(): Promise<MavOp> {
    const r = await this.mav.setEkfSourceSet(2)
    if (r.ok) this.navSource = 'VIO'
    return opFromCommand(r)
  }

  snapshot(): Snapshot {
    const wp = this.activeWaypoint
    const gps = this.mav.last.GPS_RAW_INT
    const sys = this.mav.last.SYS_STATUS
    const hud = this.mav.last.VFR_HUD
    const wind = this.mav.last.WIND
    const ekf = this.mav.last.EKF_STATUS_REPORT
    const g = this.gpi
    const windTo = wind ? { x: round(-Math.sin((wind.direction * Math.PI) / 180) * wind.speed), y: round(-Math.cos((wind.direction * Math.PI) / 180) * wind.speed) } : { x: 0, y: 0 }
    const ekfPos = this.ekfPos
    const gnss = this.gnssPos
    const truth = this.truePos
    const r0 = (v: Vec) => ({ x: Math.round(v.x), y: Math.round(v.y) })
    return {
      t: round(this.t),
      tick: this.tick,
      phase: this.phase,
      pos: r0(truth),
      gpsPos: r0(gnss),
      inertialPos: r0(ekfPos),
      alt: round(this.relAlt),
      vs: round(-(g?.vz ?? 0) / 100),
      heading: Math.round(norm((g?.hdg ?? 0) / 100)),
      speed: round(hud?.groundspeed ?? 0),
      battery: sys && sys.batteryRemaining >= 0 ? sys.batteryRemaining : 100,
      voltage: round((sys?.voltageBattery ?? 0) / 1000),
      sats: gps?.satellitesVisible ?? 0,
      hdop: round((gps?.eph ?? 0) / 100, 2),
      wind: windTo,
      targetWp: this.targetWp,
      wpReached: this.wpReached,
      progress: round(this.progress, 2),
      divergence: round(this.divergence),
      faultActive: this.faultActive,
      faultDetected: this.faultDetected,
      distToBase: Math.round(dist(ekfPos, this.mission.base)),
      distToTarget: Math.round(dist(ekfPos, this.target)),
      inspect:
        this.phase === 'inspect' && wp
          ? { asset: wp.asset.id, name: wp.asset.name, remaining: Math.max(0, round(this.inspectUntil - this.t)) }
          : null,
      cmd: this.cmd,
      navSource: this.navSource,
      ekfPosRatio: round(ekf?.posHorizVariance ?? 0, 2),
      ekfGpsGlitch: !!ekf && (ekf.flags & ESTIMATOR_GPS_GLITCH) !== 0,
      apMode: this.mav.mode,
      armed: this.mav.armed,
      link: { connected: this.mav.connected, rate: this.mav.rate },
      preflight: this.phase === 'ground' ? this.preflight : null,
      lat: g ? round(g.lat / 1e7, 7) : 0,
      lon: g ? round(g.lon / 1e7, 7) : 0,
    }
  }
}
