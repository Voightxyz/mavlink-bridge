/**
 * Sends events to Voight's HTTP API (POST /v1/events), one at a time, in
 * order. Without an API key (or with VOIGHT_DRY_RUN=1) it prints them
 * instead, so the simulation runs with no credentials at all.
 */

export interface VoightEvent {
  type: 'reasoning' | 'tool' | 'tx' | 'decision' | 'action' | 'error'
  timestamp?: string
  input?: Record<string, unknown>
  reasoning?: string
  toolsConsidered?: string[]
  toolExecuted?: string
  outcome?: 'pending' | 'success' | 'failed'
  durationMs?: number
  errorMessage?: string
  model?: string
  metadata?: Record<string, unknown>
}

export interface VoightOptions {
  apiKey: string | null
  endpoint: string
  agentId: string
  dryRun: boolean
  onSent?: (status: 'sent' | 'dry' | 'failed', event: VoightEvent, info?: string) => void
}

type Payload = VoightEvent & { agentId: string; timestamp: string }

export class VoightClient {
  private queue: Promise<void> = Promise.resolve()
  sent = 0
  failed = 0

  constructor(private opts: VoightOptions) {}

  get mode(): 'live' | 'dry' {
    return this.opts.dryRun || !this.opts.apiKey ? 'dry' : 'live'
  }

  emit(event: VoightEvent): void {
    const payload: Payload = { agentId: this.opts.agentId, timestamp: new Date().toISOString(), ...event }
    this.queue = this.queue.then(() => this.send(payload)).catch(() => {})
  }

  flush(): Promise<void> {
    return this.queue
  }

  private async post(payload: Payload): Promise<Response> {
    return fetch(`${this.opts.endpoint.replace(/\/$/, '')}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    })
  }

  private async send(payload: Payload): Promise<void> {
    if (this.mode === 'dry') {
      this.sent++
      this.opts.onSent?.('dry', payload)
      return
    }
    try {
      let res = await this.post(payload)
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1500))
        res = await this.post(payload)
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
      }
      this.sent++
      this.opts.onSent?.('sent', payload)
    } catch (err) {
      this.failed++
      this.opts.onSent?.('failed', payload, (err as Error).message)
    }
  }
}
