// Host VM metrics read from the bind-mounted /proc (HOST_PROC=/host/proc).
// Swarm stack mode cannot use `pid: host`, so /proc is mounted read-only.

import { readFile } from 'node:fs/promises'
import { config, log } from './config'

export interface HostSample {
  cpuPct: number | null
  memUsedBytes: number
  memTotalBytes: number
  load1: number | null
  load5: number | null
  load15: number | null
}

interface CpuTotals {
  idle: number
  total: number
}

// Sum of all jiffies fields and the idle+iowait portion, from the aggregate
// "cpu" line of /proc/stat.
const readCpuTotals = async (): Promise<CpuTotals | null> => {
  try {
    const text = await readFile(`${config.hostProc}/stat`, 'utf8')
    const line = text.split('\n').find((l) => l.startsWith('cpu '))
    if (!line) return null
    const fields = line.trim().split(/\s+/).slice(1).map(Number)
    // user nice system idle iowait irq softirq steal guest guest_nice
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
      fields
    const idleAll = idle + iowait
    const total = user + nice + system + idle + iowait + irq + softirq + steal
    return { idle: idleAll, total }
  } catch (err) {
    log.debug('failed to read /proc/stat', { error: String(err) })
    return null
  }
}

const readMem = async (): Promise<{ used: number; total: number } | null> => {
  try {
    const text = await readFile(`${config.hostProc}/meminfo`, 'utf8')
    const values: Record<string, number> = {}
    for (const line of text.split('\n')) {
      const match = line.match(/^(\w+):\s+(\d+)\s*kB/)
      if (match) values[match[1]!] = Number(match[2]) * 1024
    }
    const total = values.MemTotal ?? 0
    const available = values.MemAvailable ?? values.MemFree ?? 0
    if (total <= 0) return null
    return { used: Math.max(0, total - available), total }
  } catch (err) {
    log.debug('failed to read /proc/meminfo', { error: String(err) })
    return null
  }
}

const readLoad = async (): Promise<[number | null, number | null, number | null]> => {
  try {
    const text = await readFile(`${config.hostProc}/loadavg`, 'utf8')
    const parts = text.trim().split(/\s+/)
    const parse = (v: string | undefined): number | null => {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    return [parse(parts[0]), parse(parts[1]), parse(parts[2])]
  } catch (err) {
    log.debug('failed to read /proc/loadavg', { error: String(err) })
    return [null, null, null]
  }
}

// Previous /proc/stat totals, for the CPU% delta. cpu_pct is null on the first
// tick (no baseline yet).
let prevCpu: CpuTotals | null = null

export const readHostSample = async (memTotalFallback: number): Promise<HostSample> => {
  const [cpu, mem, load] = await Promise.all([readCpuTotals(), readMem(), readLoad()])

  let cpuPct: number | null = null
  if (cpu) {
    if (prevCpu) {
      const totalDelta = cpu.total - prevCpu.total
      const idleDelta = cpu.idle - prevCpu.idle
      if (totalDelta > 0) {
        cpuPct = Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100))
      }
    }
    prevCpu = cpu
  }

  return {
    cpuPct,
    memUsedBytes: mem ? mem.used : 0,
    memTotalBytes: mem ? mem.total : memTotalFallback,
    load1: load[0],
    load5: load[1],
    load15: load[2],
  }
}
