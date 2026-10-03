/**
 * Runs one inspection mission on ArduPilot over MAVLink: starts ArduCopter
 * SITL, connects on tcp:5760, arms and takes off, lets the agent decide
 * every DECISION_EVERY seconds, stages a GNSS spoofing attack at FAULT_AT,
 * and sends a Voight event for every decision, MAVLink command (with the
 * autopilot's acknowledgement), inspection pass, fault and outcome.
 * Open http://localhost:PORT for the 3D ground-station view.
 */

import { readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Mav } from './mav.js'
import { Vehicle, type MavOp, type Phase, type Snapshot } from './vehicle.js'
import { GnssSpoofer } from './spoof.js'
import { decide, autopilot, violates, isStale, type Decision, SAFETY, DEFAULT_LLM_BASE_URL } from './agent.js'
import { VoightClient, type VoightEvent } from './voight.js'
import { startServer } from './server.js'
import { startSitl, defaultArdupilotDir } from './sitl.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

// .env (no dependency): KEY=VALUE lines, no quotes needed.
if (existsSync(join(REPO, '.env'))) {
  for (const line of readFileSync(join(REPO, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '')
  }
}

const env = (k: string, d = '') => (process.env[k] ?? d).trim()
const PORT = Number(env('PORT', '4200'))
const FAULT_AT = Number(env('FAULT_AT', '0.6'))
const FAULT = env('FAULT', 'gnss_spoof') // gnss_spoof | none
const DECISION_EVERY = Number(env('DECISION_EVERY', '2'))
const SPEEDUP = Math.max(1, Number(env('SITL_SPEEDUP', '3')))
const SITL_MODE = env('SITL', 'spawn') // spawn | external
const SITL_HOME = env('SITL_HOME', '-35.363261,149.165230,584,353') // ArduPilot's standard SITL field
const MAV_HOST = env('MAVLINK_HOST', '127.0.0.1')
const MAV_PORT = Number(env('MAVLINK_PORT', '5760'))
const MODEL = env('AGENT_MODEL', 'anthropic/claude-sonnet-5.5')
const LLM_BASE_URL = env('LLM_BASE_URL', DEFAULT_LLM_BASE_URL)
const LLM_KEY = env('LLM_API_KEY') || env('OPENROUTER_API_KEY') || null
const DRY = env('VOIGHT_DRY_RUN') === '1' || !env('VOIGHT_API_KEY')

if (SITL_MODE === 'spawn') {
  startSitl({ ardupilotDir: defaultArdupilotDir(), speedup: SPEEDUP, home: SITL_HOME, repoDir: REPO })
  console.log(`ArduCopter SITL starting (×${SPEEDUP}), log in .sitl/sitl.log`)
}

/** What the HUD shows in its "Voight trace" panel: one row per event actually sent. */
type StreamRow = {
  t: number
  type: VoightEvent['type']
  tool?: string
  outcome?: string
  ms?: number
  model?: string
  args?: Record<string, unknown>
  asset?: string
  summary?: string
  status: 'sent' | 'dry' | 'failed'
}

let stream: StreamRow[] = []
const voight = new VoightClient({
  apiKey: env('VOIGHT_API_KEY') || null,
  endpoint: env('VOIGHT_ENDPOINT', 'https://api.voight.xyz'),
  agentId: env('VOIGHT_AGENT_ID', 'drone-mavlink'),
  dryRun: DRY,
  onSent: (status, ev, info) => {
    const meta = (ev.metadata ?? {}) as Record<string, any>
    stream.push({
      t: meta.telemetry?.t ?? vehicle.t,
      type: ev.type,
      tool: ev.toolExecuted,
      outcome: ev.outcome,
      ms: ev.durationMs,
      model: ev.model,
      args: meta.args,
      asset: meta.asset?.id,
      summary: ev.type === 'error' ? ev.errorMessage?.split(':')[0] : undefined,
      status,
    })
    if (stream.length > 40) stream = stream.slice(-40)
    const tag = status === 'sent' ? 'voight' : status === 'dry' ? 'voight:dry' : 'voight:FAILED'
    console.log(`[${tag}] ${ev.type}${ev.toolExecuted ? ' ' + ev.toolExecuted : ''}${ev.outcome ? ' ' + ev.outcome : ''}${info ? ' ' + info : ''}`)
  },
})

const mav = new Mav(MAV_HOST, MAV_PORT)
const vehicle = new Vehicle(mav)
const spoofer = new GnssSpoofer(mav)
let firmware = ''

let traceId = randomUUID()
let sessionId = randomUUID()
let lastDecision: Decision | null = null
let decisionSeq = 0
let deciding = false
let lastDecisionAt = -Infinity
let faultEventSent = false
let finished = false
let launched = false
let wall = 0
let prevPhase: Phase = 'ground'
let inspectStart: { t: number; wpReached: number } | null = null

mav.on('msg', (name: string, d: any) => {
  if (name === 'AUTOPILOT_VERSION' && !firmware) {
    const v = Number(d.flightSwVersion)
    firmware = `ArduCopter V${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}`
  }
  if (name === 'STATUSTEXT') {
    const m = String(d.text ?? '').match(/^(ArduCopter V[\d.]+)/)
    if (m) firmware = m[1]
  }
})

// Telemetry the bridge asks for, in simulated Hz (the link runs SPEEDUP times faster).
const STREAMS: [number, number][] = [
  [33, 10], // GLOBAL_POSITION_INT
  [24, 5], // GPS_RAW_INT
  [193, 5], // EKF_STATUS_REPORT
  [164, 10], // SIMSTATE (simulator truth, for drawing only)
  [74, 5], // VFR_HUD
  [1, 2], // SYS_STATUS
  [168, 1], // WIND
  [242, 0.5], // HOME_POSITION
]
mav.on('connected', async () => {
  console.log(`MAVLink connected on tcp:${MAV_PORT}`)
  for (let attempt = 0; attempt < 30; attempt++) {
    const r = await mav.interval(33, 10).catch(() => null)
    if (r?.ok) break
    await new Promise((res) => setTimeout(res, 1000))
  }
  for (const [id, hz] of STREAMS) await mav.interval(id, hz).catch(() => null)
  await mav.requestMessage(148).catch(() => null) // AUTOPILOT_VERSION
})
mav.start()

function telemetry(snap: Snapshot) {
  const wp = vehicle.mission.waypoints[snap.targetWp]
  return {
    t: snap.t,
    autopilotMode: snap.apMode,
    phase: snap.phase,
    navSource: snap.navSource,
    gnss: { ...snap.gpsPos, sats: snap.sats, hdop: snap.hdop },
    ekf: snap.inertialPos,
    gnssEkfDivergenceM: snap.divergence,
    ekfGnssInnovationRatio: snap.ekfPosRatio,
    ekfGpsGlitchFlag: snap.ekfGpsGlitch,
    lat: snap.lat,
    lon: snap.lon,
    altitudeAglM: snap.alt,
    verticalSpeedMs: snap.vs,
    headingDeg: snap.heading,
    groundSpeedMs: snap.speed,
    batteryPct: snap.battery,
    batteryV: snap.voltage,
    windMs: snap.wind,
    activeWaypoint: snap.phase === 'rtb' || snap.phase === 'landing' ? 'HOME' : `${wp?.id} ${wp?.asset.id}`,
    assetsInspected: snap.wpReached,
    progress: snap.progress,
  }
}

function baseMeta(snap: Snapshot, extra: Record<string, unknown> = {}) {
  return {
    traceId,
    sessionId,
    missionId: vehicle.mission.id,
    mission: vehicle.mission.name,
    vehicle: vehicle.mission.vehicle,
    system: 'drone',
    autopilot: firmware || 'ArduCopter',
    simulator: `ArduPilot SITL ×${SPEEDUP}`,
    link: `MAVLink 2 tcp:${MAV_PORT}`,
    bridge: 'mavlink-bridge/0.1',
    privacyLevel: 'standard',
    telemetry: telemetry(snap),
    ...extra,
  }
}

function state() {
  const snap = vehicle.snapshot()
  return {
    mission: vehicle.mission,
    snap,
    lastDecision,
    decisionSeq,
    stream: stream.slice(-14),
    voight: { mode: voight.mode, sent: voight.sent, failed: voight.failed },
    model: LLM_KEY ? MODEL : 'autopilot',
    decisionEvery: DECISION_EVERY,
    timeScale: SPEEDUP,
    traceId,
    finished,
    autopilot: { firmware, statusLog: vehicle.statusLog.slice(-6) },
  }
}

/** Action event for a command the vehicle executed, with the MAVLink exchange and the autopilot's answer. */
function emitAction(snap: Snapshot, tool: string, ops: MavOp[], extra: { reasoning?: string; parentSpanId?: string; args?: Record<string, unknown>; source?: string; decision?: number; start?: boolean } = {}) {
  const ok = ops.every((o) => o.ok)
  const acks = ops.filter((o) => o.result).map((o) => `${o.command} ${o.result}`)
  voight.emit({
    type: 'action',
    toolExecuted: tool,
    input: { prompt: tool, context: { ...(extra.args ?? {}), mavlink: ops.map((o) => o.command ?? o.message) } },
    reasoning: extra.reasoning ?? (acks.length ? acks.join('. ') + '.' : undefined),
    outcome: ok ? 'success' : 'failed',
    durationMs: ops.reduce((a, o) => a + (o.ms ?? 0), 0) || undefined,
    errorMessage: ok ? undefined : `Autopilot rejected ${ops.filter((o) => !o.ok).map((o) => `${o.command}: ${o.result}`).join(', ')}`,
    model: lastDecision?.model,
    metadata: baseMeta(snap, {
      spanId: randomUUID(),
      parentSpanId: extra.parentSpanId,
      decision: extra.decision,
      source: extra.source,
      args: extra.args ?? {},
      mavlink: ops,
      ...(extra.start ? { start: true } : {}),
    }),
  })
}

async function tickDecision(snap: Snapshot) {
  if (deciding) return
  deciding = true
  const seq = ++decisionSeq
  const spanId = randomUUID()
  try {
    let d = await decide(vehicle, snap, { apiKey: LLM_KEY, model: MODEL, baseUrl: LLM_BASE_URL, timeoutMs: Number(env('LLM_TIMEOUT_MS', '15000')) })
    // The model answered on telemetry that is seconds old: re-check against the aircraft now.
    const now = vehicle.snapshot()
    // GNSS was rejected while the model was thinking: its answer is stale. A fresh decision follows at once.
    if (isStale(snap, now)) {
      console.log(`[agent] #${seq} dropped: made before the GNSS rejection`)
      decisionSeq--
      lastDecisionAt = -Infinity
      return
    }
    const late = violates(d.cmd, now)
    if (late) {
      const ap = autopilot(vehicle, now)
      d = { ...d, cmd: ap.cmd, overridden: true, reasoning: `Safety override: ${late}. ${ap.reasoning}` }
    }
    lastDecision = d
    const ops = await vehicle.apply(d.cmd).catch((err: Error) => [{ message: 'COMMAND_LONG', ok: false, result: err.message } as MavOp])
    const argText = d.cmd.tool === 'set_heading' ? `(${d.cmd.heading} deg)` : d.cmd.tool === 'set_altitude' ? `(${d.cmd.altitude} m)` : ''
    if (d.error) console.warn(`[agent] decision #${seq}: ${d.error}`)
    else console.log(`[agent] #${seq} ${d.cmd.tool}${argText} (${d.source}, ${d.durationMs} ms)${ops.length ? ' → ' + ops.map((o) => o.command ?? o.message).join(', ') : ''}  "${d.reasoning}"`)

    if (d.source === 'autopilot' && d.cmd.tool === 'continue' && (snap.phase === 'rtb' || snap.phase === 'landing')) return

    const args = d.cmd.tool === 'set_heading' ? { heading: d.cmd.heading } : d.cmd.tool === 'set_altitude' ? { altitude: d.cmd.altitude } : {}
    voight.emit({
      type: 'decision',
      input: { prompt: `Next action, mission ${vehicle.mission.id}`, context: { mode: snap.phase, telemetry: telemetry(snap) } },
      reasoning: d.reasoning,
      toolsConsidered: d.toolsConsidered,
      toolExecuted: d.cmd.tool,
      outcome: d.error ? 'failed' : 'success',
      durationMs: d.durationMs,
      errorMessage: d.error,
      model: d.model,
      metadata: baseMeta(snap, {
        spanId,
        decision: seq,
        source: d.source,
        overridden: d.overridden,
        tool: d.cmd.tool,
        args,
        ...(d.tokens ? { tokensBreakdown: { input: d.tokens.input, output: d.tokens.output } } : {}),
      }),
    })
    if (d.cmd.tool !== 'continue' && ops.length) emitAction(vehicle.snapshot(), d.cmd.tool, ops, { parentSpanId: spanId, args, decision: seq })
  } finally {
    deciding = false
  }
}

let faultHandling = false
async function faultCheck(snap: Snapshot) {
  if (faultEventSent || faultHandling || !snap.armed || snap.phase === 'ground' || snap.phase === 'takeoff') return
  if (snap.divergence <= SAFETY.gpsDivergenceM) return
  faultHandling = true
  faultEventSent = true
  vehicle.faultDetected = true
  const spanId = randomUUID()
  const apLog = vehicle.statusLog.filter((l) => /gps|ekf|glitch/i.test(l.text)).slice(-3).map((l) => l.text)
  voight.emit({
    type: 'error',
    // Stable message so every flight with this fault lands in the same issue; the numbers travel in reasoning and metadata.
    errorMessage: `GNSS integrity: receiver position diverged from the EKF estimate beyond ${SAFETY.gpsDivergenceM} m. GNSS rejected.`,
    reasoning: `T+${snap.t}s. GNSS/EKF divergence ${snap.divergence} m (limit ${SAFETY.gpsDivergenceM} m) while the receiver reports a 3D fix with ${snap.sats} satellites, HDOP ${snap.hdop}. EKF3 GNSS innovation ratio ${snap.ekfPosRatio}${apLog.length ? `. ArduPilot: "${apLog.join('", "')}"` : ''}.`,
    outcome: 'failed',
    model: lastDecision?.model,
    metadata: baseMeta(snap, { spanId, fault: 'gnss_spoofing', severity: 'high', check: 'gnss_vs_ekf', autopilotLog: apLog }),
  })
  // The integrity monitor acts at once, before the EKF's own timeout re-anchors it on the false position.
  const op = await vehicle.rejectGnss().catch((err: Error) => ({ message: 'COMMAND_LONG', command: 'MAV_CMD_SET_EKF_SOURCE_SET', ok: false, result: err.message }) as MavOp)
  emitAction(vehicle.snapshot(), 'reject_gnss', [op], {
    parentSpanId: spanId,
    source: 'integrity_monitor',
    args: { ekfSourceSet: 2, navigation: 'VIO' },
    reasoning: op.ok ? 'EKF3 switched to source set 2: visual-inertial odometry for position and velocity, barometer for height, compass for yaw. GNSS no longer fused.' : `Source switch failed: ${op.result}.`,
  })
  console.log(`[monitor] GNSS rejected at divergence ${snap.divergence} m → ${op.command} ${op.result}`)
  lastDecisionAt = -Infinity // the agent decides on the next tick
  faultHandling = false
}

function phaseEvents(snap: Snapshot) {
  if (prevPhase !== 'inspect' && snap.phase === 'inspect') inspectStart = { t: snap.t, wpReached: snap.wpReached }
  if (prevPhase === 'inspect' && snap.phase !== 'inspect' && inspectStart) {
    const wp = vehicle.mission.waypoints[inspectStart.wpReached]
    const done = snap.wpReached > inspectStart.wpReached
    const secs = Math.round((snap.t - inspectStart.t) * 10) / 10
    voight.emit({
      type: 'action',
      toolExecuted: 'inspect_asset',
      input: { prompt: 'inspect_asset', context: { asset: wp?.asset.id, name: wp?.asset.name } },
      reasoning: done ? `${wp?.asset.id} ${wp?.asset.name} inspected. ${secs} s on station, nose on the asset.` : `${wp?.asset.id} inspection interrupted after ${secs} s.`,
      outcome: done ? 'success' : 'failed',
      durationMs: Math.round(secs * 1000),
      model: lastDecision?.model,
      metadata: baseMeta(snap, { spanId: randomUUID(), asset: wp?.asset }),
    })
    inspectStart = null
  }
  prevPhase = snap.phase
}

vehicle.on('auto', (e: { tool: string; reason: string; op: MavOp }) => {
  emitAction(vehicle.snapshot(), e.tool, [e.op], { source: 'mission_executive', reasoning: e.reason })
})

function finish(snap: Snapshot) {
  finished = true
  const n = vehicle.mission.waypoints.length
  const aborted = vehicle.faultDetected
  const text = aborted
    ? `Mission aborted on GNSS spoofing. Landed at ${vehicle.mission.home} on VIO navigation, ${snap.distToBase} m from the pad. ${snap.wpReached}/${n} assets inspected. Battery ${snap.battery}%.`
    : `Mission complete. ${snap.wpReached}/${n} assets inspected. Landed at ${vehicle.mission.home}, ${snap.distToBase} m from the pad. Battery ${snap.battery}%.`
  voight.emit({
    type: 'decision',
    reasoning: text,
    toolExecuted: 'land',
    outcome: aborted ? 'failed' : 'success',
    errorMessage: aborted ? 'Mission aborted: GNSS spoofing' : undefined,
    model: lastDecision?.model,
    metadata: baseMeta(snap, { spanId: randomUUID(), final: true, aborted }),
  })
  void voight.flush().then(() => console.log(`\nMission ended. Events: ${voight.sent} sent, ${voight.failed} failed. Trace ${traceId}.`))
}

async function launch() {
  if (launched) return
  launched = true
  try {
    const ops = await vehicle.launch()
    const snap = vehicle.snapshot()
    emitAction(snap, 'takeoff', ops, {
      start: true,
      args: { cruiseAltitudeM: vehicle.mission.cruiseAlt, home: vehicle.mission.home },
      reasoning: `Armed in GUIDED, takeoff to ${vehicle.mission.cruiseAlt} m from ${vehicle.mission.home}. Mission ${vehicle.mission.id}: ${vehicle.mission.description}`,
    })
    console.log(`[mission] ${vehicle.mission.id} airborne. Trace ${traceId}`)
  } catch (err) {
    console.error(`[mission] launch failed: ${(err as Error).message}`)
    launched = false
  }
}

function restart(): boolean {
  if (mav.armed || !(vehicle.phase === 'landed' || vehicle.phase === 'ground')) return false
  void spoofer.stop()
  vehicle.reset()
  traceId = randomUUID()
  sessionId = randomUUID()
  lastDecision = null
  decisionSeq = 0
  deciding = false
  lastDecisionAt = -Infinity
  faultEventSent = false
  finished = false
  launched = false
  stream = []
  wall = 0
  prevPhase = 'ground'
  inspectStart = null
  setTimeout(() => void launch(), 2500)
  return true
}

const server = startServer(PORT, { state, restart })
console.log(`MAVLink bridge on http://localhost:${PORT}  |  Voight: ${voight.mode === 'live' ? 'live' : 'dry run'}  |  agent: ${LLM_KEY ? `${MODEL} via ${LLM_BASE_URL}` : 'rule-based (no LLM_API_KEY)'}`)
console.log('GET /restart starts a new mission (new trace) once the aircraft is on the ground.')

// First mission: as soon as the autopilot streams a position.
const waitFirst = setInterval(() => {
  if (mav.connected && mav.last.GLOBAL_POSITION_INT) {
    clearInterval(waitFirst)
    setTimeout(() => void launch(), 2500)
  }
}, 500)

setInterval(() => {
  if (finished) {
    server.broadcast(state())
    return
  }
  void vehicle.step()
  wall += 0.1
  const snap = vehicle.snapshot()
  if (FAULT === 'gnss_spoof' && !spoofer.active && !vehicle.faultActive && snap.phase === 'enroute' && snap.progress >= FAULT_AT && vehicle.frame) {
    vehicle.faultActive = true
    spoofer.start(snap.t)
    console.log(`[harness] GNSS spoofing starts at T+${snap.t}s (progress ${Math.round(snap.progress * 100)}%)`)
  }
  if (spoofer.active && vehicle.frame) void spoofer.update(snap.t, vehicle.frame)
  void faultCheck(snap)
  phaseEvents(snap)
  const cadence = snap.phase === 'rtb' || snap.phase === 'landing' ? Math.max(DECISION_EVERY, 10) : DECISION_EVERY
  // No decision while the integrity monitor is acting: the next one sees the rejected GNSS and the new nav source.
  if (!faultHandling && snap.phase !== 'ground' && snap.phase !== 'landed' && snap.phase !== 'aborted' && snap.phase !== 'takeoff' && wall - lastDecisionAt >= cadence) {
    lastDecisionAt = wall
    void tickDecision(vehicle.snapshot())
  }
  if (snap.phase === 'landed' && !finished) finish(snap)
  server.broadcast(state())
}, 100)
