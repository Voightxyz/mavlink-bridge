/**
 * MAVLink 2 link to an ArduPilot vehicle over TCP (SITL serves SERIAL0 on
 * tcp:5760). Decodes every packet with the ArduPilot dialect, keeps the
 * latest copy of each message, and sends commands that wait for their
 * COMMAND_ACK, so every command in the trace carries the autopilot's answer.
 */

import { connect, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import {
  MavLinkPacketSplitter,
  MavLinkPacketParser,
  MavLinkProtocolV2,
  send,
  minimal,
  standard,
  common,
  ardupilotmega,
  type MavLinkPacket,
  type MavLinkData,
} from 'node-mavlink'

const REGISTRY = { ...minimal.REGISTRY, ...standard.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY } as Record<number, any>

export const MAV_CMD = {
  DO_SET_MODE: 176,
  COMPONENT_ARM_DISARM: 400,
  NAV_TAKEOFF: 22,
  SET_MESSAGE_INTERVAL: 511,
  SET_EKF_SOURCE_SET: 42007,
  BATTERY_RESET: 42651,
  REQUEST_MESSAGE: 512,
} as const

export const MAV_CMD_NAME: Record<number, string> = {
  176: 'MAV_CMD_DO_SET_MODE',
  400: 'MAV_CMD_COMPONENT_ARM_DISARM',
  22: 'MAV_CMD_NAV_TAKEOFF',
  511: 'MAV_CMD_SET_MESSAGE_INTERVAL',
  42007: 'MAV_CMD_SET_EKF_SOURCE_SET',
  42651: 'MAV_CMD_BATTERY_RESET',
  512: 'MAV_CMD_REQUEST_MESSAGE',
}

const MAV_RESULT = ['ACCEPTED', 'TEMPORARILY_REJECTED', 'DENIED', 'UNSUPPORTED', 'FAILED', 'IN_PROGRESS', 'CANCELLED']
export const ackName = (r: number) => (r < 0 ? 'NO_ACK' : MAV_RESULT[r] ?? `RESULT_${r}`)

/** ArduCopter custom modes used here. */
export const COPTER_MODE: Record<string, number> = { STABILIZE: 0, ALT_HOLD: 2, AUTO: 3, GUIDED: 4, LOITER: 5, RTL: 6, LAND: 9, BRAKE: 17, SMART_RTL: 21 }
export const COPTER_MODE_NAME: Record<number, string> = Object.fromEntries(Object.entries(COPTER_MODE).map(([k, v]) => [v, k]))

export interface CommandResult {
  command: string
  params: number[]
  result: string
  ok: boolean
  ms: number
}

export class Mav extends EventEmitter {
  private sock: Socket | null = null
  private protocol = new MavLinkProtocolV2(255, 190) // ground station: sysid 255, MAV_COMP_ID_MISSIONPLANNER
  readonly target = { sys: 1, comp: 1 }
  connected = false
  /** Latest copy of each message by MAVLink name (GLOBAL_POSITION_INT, GPS_RAW_INT, ...). */
  readonly last: Record<string, any> = {}
  private rxCount = 0
  rate = 0

  constructor(
    private host: string,
    private port: number,
  ) {
    super()
    setInterval(() => {
      this.rate = this.rxCount
      this.rxCount = 0
    }, 1000).unref()
  }

  start() {
    this.open()
  }

  private open() {
    const s = connect({ host: this.host, port: this.port })
    this.sock = s
    s.on('connect', () => {
      this.connected = true
      this.emit('connected')
    })
    const retry = () => {
      if (this.sock !== s) return
      this.connected = false
      this.sock = null
      setTimeout(() => this.open(), 1000)
    }
    s.on('error', () => {})
    s.on('close', retry)
    s.pipe(new MavLinkPacketSplitter())
      .pipe(new MavLinkPacketParser())
      .on('data', (p: MavLinkPacket) => {
        this.rxCount++
        const clazz = REGISTRY[p.header.msgid]
        if (!clazz || p.header.sysid !== this.target.sys) return
        const data = p.protocol.data(p.payload, clazz)
        const name = clazz.MSG_NAME as string
        // Autopilot heartbeats only (the simulated VIO companion also sends some).
        if (name === 'HEARTBEAT' && p.header.compid !== this.target.comp) return
        this.last[name] = data
        this.emit('msg', name, data)
      })
  }

  async send(msg: MavLinkData) {
    if (!this.sock || !this.connected) throw new Error('MAVLink link down')
    await send(this.sock, msg, this.protocol)
  }

  /** COMMAND_LONG, resolved with the matching COMMAND_ACK (or NO_ACK after the timeout). */
  async command(cmd: number, params: number[] = [], timeoutMs = 3000): Promise<CommandResult> {
    const m = new common.CommandLong()
    m.targetSystem = this.target.sys
    m.targetComponent = this.target.comp
    m.command = cmd as any
    m.confirmation = 0
    const p = [...params, 0, 0, 0, 0, 0, 0, 0].slice(0, 7)
    m._param1 = p[0]; m._param2 = p[1]; m._param3 = p[2]; m._param4 = p[3]; m._param5 = p[4]; m._param6 = p[5]; m._param7 = p[6]
    const started = Date.now()
    const ack = new Promise<number>((resolve) => {
      const onMsg = (name: string, data: any) => {
        if (name === 'COMMAND_ACK' && data.command === cmd) {
          this.off('msg', onMsg)
          clearTimeout(timer)
          resolve(data.result)
        }
      }
      const timer = setTimeout(() => {
        this.off('msg', onMsg)
        resolve(-1)
      }, timeoutMs)
      this.on('msg', onMsg)
    })
    await this.send(m)
    const result = await ack
    return { command: MAV_CMD_NAME[cmd] ?? String(cmd), params: params.slice(), result: ackName(result), ok: result === 0, ms: Date.now() - started }
  }

  setMode(mode: keyof typeof COPTER_MODE | string) {
    return this.command(MAV_CMD.DO_SET_MODE, [1 /* MAV_MODE_FLAG_CUSTOM_MODE_ENABLED */, COPTER_MODE[mode]])
  }

  arm() {
    return this.command(MAV_CMD.COMPONENT_ARM_DISARM, [1])
  }

  takeoff(altM: number) {
    return this.command(MAV_CMD.NAV_TAKEOFF, [0, 0, 0, 0, 0, 0, altM])
  }

  setEkfSourceSet(set: 1 | 2 | 3) {
    return this.command(MAV_CMD.SET_EKF_SOURCE_SET, [set])
  }

  /** Battery 1 back to a full pack (SITL keeps integrating consumed mAh across flights). */
  resetBattery() {
    return this.command(MAV_CMD.BATTERY_RESET, [1, 100], 1500)
  }

  requestMessage(msgId: number) {
    return this.command(MAV_CMD.REQUEST_MESSAGE, [msgId], 1500)
  }

  async interval(msgId: number, hz: number) {
    return this.command(MAV_CMD.SET_MESSAGE_INTERVAL, [msgId, Math.round(1e6 / hz)], 1500)
  }

  async setParam(name: string, value: number) {
    const m = new common.ParamSet()
    m.targetSystem = this.target.sys
    m.targetComponent = this.target.comp
    m.paramId = name
    m.paramValue = value
    m.paramType = 9 as any // MAV_PARAM_TYPE_REAL32
    await this.send(m)
  }

  /** GUIDED position target in the home-relative altitude frame. Yaw in degrees (0 = north); omit to let the autopilot face the direction of travel. */
  async positionTarget(lat: number, lon: number, altM: number, yawDeg?: number) {
    const m = new common.SetPositionTargetGlobalInt()
    m.timeBootMs = 0
    m.targetSystem = this.target.sys
    m.targetComponent = this.target.comp
    m.coordinateFrame = 6 as any // MAV_FRAME_GLOBAL_RELATIVE_ALT_INT
    // Use position (and yaw when given); ignore velocity, acceleration and yaw rate.
    m.typeMask = (yawDeg === undefined ? 0b0000_1111_1111_1000 : 0b0000_1011_1111_1000) as any
    m.latInt = Math.round(lat * 1e7)
    m.lonInt = Math.round(lon * 1e7)
    m.alt = altM
    m.vx = 0; m.vy = 0; m.vz = 0; m.afx = 0; m.afy = 0; m.afz = 0
    m.yaw = yawDeg === undefined ? 0 : (yawDeg * Math.PI) / 180
    m.yawRate = 0
    await this.send(m)
  }

  get armed(): boolean {
    const hb = this.last.HEARTBEAT
    return !!hb && (hb.baseMode & 128) !== 0 // MAV_MODE_FLAG_SAFETY_ARMED
  }

  get mode(): string {
    const hb = this.last.HEARTBEAT
    return hb ? COPTER_MODE_NAME[hb.customMode] ?? `MODE_${hb.customMode}` : 'UNKNOWN'
  }
}
