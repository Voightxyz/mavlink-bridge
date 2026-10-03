/**
 * Test harness, not part of the vehicle: a GNSS spoofing attack staged in
 * the simulator. It walks the simulated receiver's reported position away
 * from the truth with ArduPilot's SIM_GPS1_GLTCH_X/Y parameters (degrees of
 * latitude and longitude). The receiver keeps a healthy 3D fix; the
 * velocity it reports stays true. ArduPilot's EKF sees the position
 * innovations grow, and the agent has to work out what is going on.
 */

import type { Mav } from './mav.js'
import type { Frame } from './site.js'

export class GnssSpoofer {
  active = false
  offsetM = 0
  private startT = 0
  private lastSentM = -1

  constructor(
    private mav: Mav,
    private rateMs = 4, // metres per simulated second
    private maxM = 140,
    private dirDeg = 30, // direction of the walk, 0 = north (30 = north-north-east)
  ) {}

  start(tSim: number) {
    this.active = true
    this.startT = tSim
    this.offsetM = 0
    this.lastSentM = -1
  }

  /** Call every tick with the simulated mission time. */
  async update(tSim: number, frame: Frame) {
    if (!this.active) return
    this.offsetM = Math.min(this.maxM, Math.max(0, (tSim - this.startT) * this.rateMs))
    if (Math.abs(this.offsetM - this.lastSentM) < 0.4) return
    this.lastSentM = this.offsetM
    const r = (this.dirDeg * Math.PI) / 180
    const { dLat, dLon } = frame.offsetDeg(Math.cos(r) * this.offsetM, Math.sin(r) * this.offsetM)
    await this.mav.setParam('SIM_GPS1_GLTCH_X', dLat)
    await this.mav.setParam('SIM_GPS1_GLTCH_Y', dLon)
  }

  async stop() {
    this.active = false
    this.offsetM = 0
    this.lastSentM = -1
    await this.mav.setParam('SIM_GPS1_GLTCH_X', 0).catch(() => {})
    await this.mav.setParam('SIM_GPS1_GLTCH_Y', 0).catch(() => {})
  }
}
