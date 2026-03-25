import type { CreateSessionResponse, IceServersResponse, SessionInfoResponse } from "@/lib/types"

const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/$/, "") ?? ""
const configuredWsBaseUrl = import.meta.env.VITE_WS_BASE_URL?.trim().replace(/\/$/, "") ?? ""

function resolveBrowserOrigin() {
  if (typeof window === "undefined") {
    return "http://localhost:3000"
  }

  return window.location.origin
}

function resolveApiBaseUrl() {
  return configuredApiBaseUrl || resolveBrowserOrigin()
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `HTTP ${response.status}`)
  }

  return (await response.json()) as T
}

export async function createSession() {
  const response = await fetch(`${resolveApiBaseUrl()}/api/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  })

  return parseJson<CreateSessionResponse>(response)
}

export async function getSessionInfo(sessionId: string, joinToken: string) {
  const response = await fetch(
    `${resolveApiBaseUrl()}/api/sessions/${encodeURIComponent(sessionId)}?joinToken=${encodeURIComponent(joinToken)}`,
  )

  return parseJson<SessionInfoResponse>(response)
}

export async function getIceServers() {
  const response = await fetch(`${resolveApiBaseUrl()}/api/ice-servers`)
  return parseJson<IceServersResponse>(response)
}

export function getWebSocketUrl() {
  if (configuredWsBaseUrl) {
    return `${configuredWsBaseUrl}/ws`
  }

  if (typeof window === "undefined") {
    return "ws://localhost:8080/ws"
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/ws`
}

export function humanizeError(error: unknown) {
  if (error instanceof Error && error.message) {
    if (/^(load failed|failed to fetch)$/i.test(error.message.trim())) {
      return "Не удалось связаться с сервером приложения. Проверь адрес страницы и доступность API."
    }

    return error.message
  }

  return "Произошла непредвиденная ошибка."
}
