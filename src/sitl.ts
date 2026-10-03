/**
 * Starts ArduCopter SITL (built natively from ArduPilot) as a child process:
 * the stock quad physics model, ArduPilot's copter defaults plus
 * sitl/voight.parm, a simulated VIO camera on SERIAL5, MAVLink on tcp:5760.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface SitlOptions {
  ardupilotDir: string
  speedup: number
  home: string // lat,lon,alt,heading
  repoDir: string
}

export function sitlBinary(ardupilotDir: string) {
  return join(ardupilotDir, 'build', 'sitl', 'bin', 'arducopter')
}

export function defaultArdupilotDir() {
  const dir = (process.env.ARDUPILOT_DIR || '').trim().replace(/^~(?=$|\/)/, homedir())
  return resolve(dir || join(homedir(), 'ardupilot'))
}

export function startSitl(o: SitlOptions): ChildProcess {
  const bin = sitlBinary(o.ardupilotDir)
  if (!existsSync(bin)) {
    throw new Error(`ArduCopter SITL binary not found at ${bin}. Build it first (see README), or set ARDUPILOT_DIR.`)
  }
  const runDir = join(o.repoDir, '.sitl')
  mkdirSync(runDir, { recursive: true })
  const defaults = [join(o.ardupilotDir, 'Tools', 'autotest', 'default_params', 'copter.parm'), join(o.repoDir, 'sitl', 'voight.parm')].join(',')
  const args = ['--model', 'quad', '--speedup', String(o.speedup), '--wipe', '--defaults', defaults, '--serial5=sim:vicon:', '--home', o.home, '-I0']
  const child = spawn(bin, args, { cwd: runDir, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = createWriteStream(join(runDir, 'sitl.log'))
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  const stop = () => {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.on('exit', stop)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      stop()
      process.exit(0)
    })
  }
  return child
}
