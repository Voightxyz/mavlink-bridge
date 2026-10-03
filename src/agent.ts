/**
 * The flight agent. Every DECISION_EVERY seconds it reads the MAVLink
 * telemetry and the mission, and returns one tool call. An LLM (any
 * OpenAI-compatible endpoint) makes the call; a deterministic autopilot
 * computes the safe recommendation in parallel and overrides the model when
 * it would break a safety rule. Without a model key, or if the model fails,
 * the rule-based autopilot flies alone, so the demo never stalls.
 */

import type { Command, Snapshot, Vehicle } from './vehicle.js'

export interface Decision {
  cmd: Command
  reasoning: string
  model: string
  source: 'llm' | 'autopilot'
  overridden: boolean
  toolsConsidered: string[]
  durationMs: number
  tokens?: { input: number; output: number }
  error?: string
}

export const TOOLS = [
  { name: 'set_heading', description: 'Steer to a compass heading in degrees for 8 s (0 = north, 90 = east).', params: { heading: 'number' } },
  { name: 'set_altitude', description: 'Climb or descend to an altitude in metres AGL (20 to 120).', params: { altitude: 'number' } },
  { name: 'hold', description: 'Hold position (loiter).', params: {} },
  { name: 'return_to_base', description: 'Abort the mission: autopilot RTL to Pad A and land.', params: {} },
  { name: 'continue', description: 'Keep flying the mission plan.', params: {} },
] as const

export const SAFETY = {
  minBattery: 25,
  gpsDivergenceM: 20,
}

/** Deterministic, rule-based recommendation. Also the safety floor. */
export function autopilot(v: Vehicle, snap: Snapshot): { cmd: Command; reasoning: string } {
  const home = v.mission.home
  if (snap.phase === 'rtb' || snap.phase === 'landing' || snap.phase === 'landed') {
    return { cmd: { tool: 'continue' }, reasoning: `RTL in progress on ${snap.navSource}. Navigating to ${home}.` }
  }
  if (snap.faultDetected || snap.divergence > SAFETY.gpsDivergenceM) {
    return {
      cmd: { tool: 'return_to_base' },
      reasoning: `GNSS/EKF divergence ${snap.divergence} m exceeds ${SAFETY.gpsDivergenceM} m. GNSS rejected, navigating on VIO. RTL.`,
    }
  }
  if (snap.battery < SAFETY.minBattery) {
    return { cmd: { tool: 'return_to_base' }, reasoning: `Battery ${snap.battery}% below ${SAFETY.minBattery}% reserve. RTL.` }
  }
  if (snap.phase === 'inspect' && snap.inspect) {
    return { cmd: { tool: 'continue' }, reasoning: `On station at ${snap.inspect.asset}. Inspection pass, holding position.` }
  }
  const obstacle = v.obstacleAhead()
  if (obstacle) {
    const h = v.avoidanceHeading(obstacle)
    return { cmd: { tool: 'set_heading', heading: h }, reasoning: `${obstacle.label} NFZ on track. Deviating to ${String(h).padStart(3, '0')}°.` }
  }
  const wp = v.mission.waypoints[snap.targetWp]
  return { cmd: { tool: 'continue' }, reasoning: `Track clear to ${wp?.id ?? 'target'} ${wp?.asset.id ?? ''}, ${snap.distToTarget} m. GNSS/EKF agree. Continue.`.replace(/\s+,/, ',') }
}

export function violates(cmd: Command, snap: Snapshot): string | null {
  const mustAbort = snap.faultDetected || snap.divergence > SAFETY.gpsDivergenceM || snap.battery < SAFETY.minBattery
  if (mustAbort && cmd.tool !== 'return_to_base' && snap.phase !== 'rtb' && snap.phase !== 'landing') {
    return 'navigation integrity or battery reserve requires RTL'
  }
  if (cmd.tool === 'set_altitude' && typeof cmd.altitude === 'number' && (cmd.altitude < 20 || cmd.altitude > 120) && (snap.phase === 'enroute' || snap.phase === 'inspect')) {
    return 'altitude outside the 20 to 120 m envelope'
  }
  return null
}

/** Keep model rationale short and operational, the way an operator log reads. */
export function tidyRationale(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim()
  t = t.replace(/^(okay|ok|alright|sure)[,.!]?\s*/i, '').replace(/^(operator )?log:\s*/i, '')
  t = t.replace(/\b(I will|I'll|I am going to|Let me)\b/gi, '').replace(/\s{2,}/g, ' ').trim()
  t = t.replace(/—|–/g, ',')
  const sentences = t.match(/[^.!?]+[.!?]?/g) ?? [t]
  let out = ''
  for (const s of sentences) {
    if ((out + s).length > 160) break
    out += s
  }
  out = (out || t.slice(0, 157) + '…').trim()
  return out.charAt(0).toUpperCase() + out.slice(1)
}

export interface AgentOptions {
  apiKey: string | null
  model: string
  /** OpenAI-compatible chat completions base URL (OpenRouter, Z.ai, ...). */
  baseUrl?: string
  timeoutMs?: number
}

export const DEFAULT_LLM_BASE_URL = 'https://openrouter.ai/api/v1'

export async function decide(v: Vehicle, snap: Snapshot, opts: AgentOptions): Promise<Decision> {
  const started = Date.now()
  const ap = autopilot(v, snap)
  const considered = TOOLS.map((t) => t.name)

  if (!opts.apiKey) {
    return { cmd: ap.cmd, reasoning: ap.reasoning, model: 'autopilot', source: 'autopilot', overridden: false, toolsConsidered: considered, durationMs: Date.now() - started }
  }
  // Returning or landing: ArduPilot flies RTL on its own. No model call.
  if (snap.phase === 'rtb' || snap.phase === 'landing' || snap.phase === 'landed') {
    return { cmd: ap.cmd, reasoning: ap.reasoning, model: opts.model, source: 'autopilot', overridden: false, toolsConsidered: considered, durationMs: Date.now() - started }
  }

  try {
    const llm = await callModel(v, snap, opts)
    llm.reasoning = llm.reasoning ? tidyRationale(llm.reasoning) : llm.cmd.tool === ap.cmd.tool ? ap.reasoning : `Model selects ${llm.cmd.tool.replace(/_/g, ' ')}.`
    const violation = violates(llm.cmd, snap)
    if (violation) {
      return {
        cmd: ap.cmd,
        reasoning: `Safety override: ${violation}. ${ap.reasoning}`,
        model: opts.model,
        source: 'llm',
        overridden: true,
        toolsConsidered: considered,
        durationMs: Date.now() - started,
        tokens: llm.tokens,
      }
    }
    return { cmd: llm.cmd, reasoning: llm.reasoning, model: opts.model, source: 'llm', overridden: false, toolsConsidered: considered, durationMs: Date.now() - started, tokens: llm.tokens }
  } catch (err) {
    return {
      cmd: ap.cmd,
      reasoning: ap.reasoning,
      model: opts.model,
      source: 'autopilot',
      overridden: false,
      toolsConsidered: considered,
      durationMs: Date.now() - started,
      error: `model call failed, autopilot took over: ${(err as Error).message}`,
    }
  }
}

function telemetryText(v: Vehicle, snap: Snapshot): string {
  const wp = v.mission.waypoints[snap.targetWp]
  const obstacle = v.obstacleAhead()
  return [
    `T+${snap.t}s ArduPilot mode=${snap.apMode} mission_phase=${snap.phase} progress=${Math.round(snap.progress * 100)}%`,
    `navigation source=${snap.navSource}; gnss=(${snap.gpsPos.x}, ${snap.gpsPos.y}) sats=${snap.sats} hdop=${snap.hdop}; ekf=(${snap.inertialPos.x}, ${snap.inertialPos.y}); gnss_ekf_divergence=${snap.divergence} m; ekf_gnss_innovation_ratio=${snap.ekfPosRatio}${snap.ekfGpsGlitch ? ' (EKF flags GPS glitch)' : ''}`,
    `alt=${snap.alt} m AGL hdg=${snap.heading} deg gs=${snap.speed} m/s battery=${snap.battery}% (${snap.voltage} V) wind=(${snap.wind.x}, ${snap.wind.y}) m/s`,
    snap.inspect
      ? `on station at ${snap.inspect.asset} ${snap.inspect.name}, inspection pass ${snap.inspect.remaining} s remaining`
      : `next=${snap.phase === 'rtb' ? 'HOME' : `${wp?.id} ${wp?.asset.id}`} at ${snap.distToTarget} m, bearing ${v.directHeading()} deg; home at ${snap.distToBase} m`,
    snap.faultDetected
      ? `INTEGRITY ALERT: the integrity monitor rejected GNSS (GNSS/EKF divergence above ${SAFETY.gpsDivergenceM} m, now ${snap.divergence} m). EKF navigating on ${snap.navSource === 'VIO' ? 'visual-inertial odometry (source set 2)' : 'its own estimate'}. Mission rule: return to launch.`
      : null,
    obstacle ? `ALERT: ${obstacle.label} no-fly zone (radius ${obstacle.r} m, ${obstacle.heightM} m AGL) on track; avoidance heading ${v.avoidanceHeading(obstacle)} deg` : 'No obstacle on track.',
  ]
    .filter(Boolean)
    .join('\n')
}

async function callModel(v: Vehicle, snap: Snapshot, opts: AgentOptions): Promise<{ cmd: Command; reasoning: string; tokens?: { input: number; output: number } }> {
  const m = v.mission
  const system = [
    `You are the autonomous flight agent of inspection quadcopter ${m.vehicle}, flying on an ArduPilot autopilot over MAVLink. Mission ${m.id}: ${m.description}`,
    `Waypoints: ${m.waypoints.map((w) => `${w.id} ${w.asset.id} (${w.x}, ${w.y})`).join(', ')}. Home ${m.home} (${m.base.x}, ${m.base.y}). Cruise ${m.cruiseAlt} m AGL.`,
    `Rules: keep ${SAFETY.minBattery}% battery reserve; never enter a no-fly zone; if the GNSS position and the EKF estimate diverge by more than ${SAFETY.gpsDivergenceM} m, GNSS is rejected (navigation switches to visual-inertial odometry) and the aircraft must return to launch immediately.`,
    'The mission executive flies the waypoints and the inspection passes on its own. Use continue when nothing needs to change, set_heading only for a temporary deviation, set_altitude to change cruise height, hold to loiter, return_to_base to abort and return to launch.',
    'Call exactly one tool per turn. In the content field write the rationale as a terse operator log entry: at most 16 words, present tense, no filler, no first person. Example: "Track clear to WP2 TK-3. GNSS/EKF agree within 2 m. Continue."',
  ].join('\n')

  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Telemetry:\n${telemetryText(v, snap)}\n\nDecide the next action.` },
    ],
    tools: TOOLS.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(t.params).map(([k, type]) => [k, { type }])),
          required: Object.keys(t.params),
        },
      },
    })),
    tool_choice: 'auto',
    max_tokens: 300,
    temperature: 0.2,
  } as Record<string, unknown>

  const base = (opts.baseUrl ?? DEFAULT_LLM_BASE_URL).replace(/\/$/, '')
  // GLM thinks by default: slower, and the visible text turns into analysis. GLM-5.x
  // cannot switch thinking off but accepts a low effort; GLM-4.x can switch it off.
  if (/glm-5/i.test(opts.model)) body.reasoning_effort = 'low'
  else if (/glm-4/i.test(opts.model)) body.thinking = { type: 'disabled' }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://voight.xyz',
      'X-Title': 'Voight MAVLink bridge',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
  })
  if (!res.ok) throw new Error(`model endpoint ${res.status}`)
  const json = (await res.json()) as any
  const msg = json.choices?.[0]?.message
  const call = msg?.tool_calls?.[0]
  // Only the visible answer is a rationale; a reasoning trace never becomes the log line.
  const content = typeof msg?.content === 'string' ? msg.content.trim() : ''
  if (!call) {
    if (!content) return { cmd: { tool: 'continue' }, reasoning: '', tokens: tokensOf(json) }
    const named = (['return_to_base', 'set_altitude', 'set_heading', 'hold'] as const).find((t) => content.toLowerCase().includes(t))
    if (named === 'return_to_base' || named === 'hold') return { cmd: { tool: named }, reasoning: content, tokens: tokensOf(json) }
    const alt = named === 'set_altitude' ? Number((content.match(/(\d{2,3})\s*m/) ?? [])[1]) : NaN
    if (named === 'set_altitude' && Number.isFinite(alt)) return { cmd: { tool: 'set_altitude', altitude: alt }, reasoning: content, tokens: tokensOf(json) }
    const hdg = named === 'set_heading' ? Number((content.match(/(\d{1,3})\s*(?:deg|°)/) ?? [])[1]) : NaN
    if (named === 'set_heading' && Number.isFinite(hdg)) return { cmd: { tool: 'set_heading', heading: hdg }, reasoning: content, tokens: tokensOf(json) }
    return { cmd: { tool: 'continue' }, reasoning: content, tokens: tokensOf(json) }
  }
  let args: any = {}
  try {
    args = JSON.parse(call.function?.arguments || '{}')
  } catch {
    args = {}
  }
  const name = call.function?.name as Command['tool']
  const cmd: Command =
    name === 'set_heading' ? { tool: 'set_heading', heading: Number(args.heading) }
    : name === 'set_altitude' ? { tool: 'set_altitude', altitude: Number(args.altitude) }
    : name === 'hold' ? { tool: 'hold' }
    : name === 'return_to_base' ? { tool: 'return_to_base' }
    : { tool: 'continue' }
  return { cmd, reasoning: content, tokens: tokensOf(json) }
}

function tokensOf(json: any): { input: number; output: number } | undefined {
  const usage = json?.usage
  return usage ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 } : undefined
}
