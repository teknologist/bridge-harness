export type Agent = {
  agentId: string
  displayName: string
  project?: string
  host?: string
  task?: string
  rooms: string[]
  aliases: string[]
  lastSeen: number
}

export type Probe = {
  selfId?: string
  natsUrl?: string
  connected: boolean
  error?: string
  helperPid?: number
  helperPpid?: number
  startedAt?: number
  lastTickAt?: number
  ticks: number
  starts: number
  lastExit?: string
  dms: number
  wake: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'bridge-pane': { roster: Shaped<Record<string, Agent>>; probe: Shaped<Probe> }
  }
}
