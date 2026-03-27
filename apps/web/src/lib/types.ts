export type SessionStatus = "waiting_for_peer" | "connecting" | "active" | "ended" | "expired"
export type ParticipantRole = "host" | "guest"
export type ConnectionStage = "loading" | "preparing" | "waiting" | "connecting" | "connected" | "reconnecting" | "ended" | "expired" | "failed"
export type ConnectionPath = "unknown" | "direct" | "relay"

export interface CreateSessionResponse {
  sessionId: string
  status: SessionStatus
  hostUrl: string
  shareUrl: string
  hostJoinToken: string
}

export interface SessionInfoResponse {
  sessionId: string
  status: SessionStatus
  role: ParticipantRole | null
  canJoin: boolean
  activeParticipants: number
  maxParticipants: number
  shareUrl: string | null
  message?: string | null
}

export interface IceServerConfig {
  urls: string[]
  username?: string | null
  credential?: string | null
}

export interface IceServersResponse {
  iceServers: IceServerConfig[]
}

export interface WsMessage<T = Record<string, unknown>> {
  type: string
  payload: T
}

export interface MediaState {
  audioEnabled: boolean
  videoEnabled: boolean
}
