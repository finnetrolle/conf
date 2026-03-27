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
  const rawBody = await response.text()

  if (!response.ok) {
    let errorMessage: string | null = null

    try {
      const parsed = JSON.parse(rawBody) as { message?: unknown }
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        errorMessage = parsed.message
      }
    } catch {}

    throw new Error(errorMessage || rawBody || `HTTP ${response.status}`)
  }

  return JSON.parse(rawBody) as T
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

export async function getIceServers(sessionId: string, joinToken: string) {
  const response = await fetch(
    `${resolveApiBaseUrl()}/api/ice-servers?sessionId=${encodeURIComponent(sessionId)}&joinToken=${encodeURIComponent(joinToken)}`,
  )
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
    const rawMessage = error.message.trim()
    const normalizedMessage = rawMessage.toLowerCase()
    const errorName = typeof error.name === "string" ? error.name : ""

    if (/^(load failed|failed to fetch)$/i.test(rawMessage)) {
      return "Не удалось связаться с сервисом звонков. Проверьте подключение к интернету и попробуйте еще раз."
    }

    if (/session was not found|session not found/i.test(rawMessage)) {
      return "Такой звонок не найден. Проверьте ссылку или попросите отправить новое приглашение."
    }

    if (/join token is invalid|missing joinToken|missing sessionId/i.test(rawMessage)) {
      return "Ссылка на звонок открыта не полностью или уже не подходит. Попросите отправить приглашение еще раз."
    }

    if (/session has already ended|session_ended/i.test(rawMessage)) {
      return "Этот звонок уже завершен. Попросите отправить новую ссылку."
    }

    if (/session is already full|session_full/i.test(rawMessage)) {
      return "В звонке уже два человека. Дождитесь, пока кто-то выйдет, или начните новый звонок."
    }

    if (/ice configuration is unavailable|unsupported event type/i.test(rawMessage)) {
      return "Во время звонка произошла ошибка. Обновите страницу и попробуйте снова."
    }

    if (errorName === "NotAllowedError" || /permission|denied|notallowed/i.test(normalizedMessage)) {
      return "Браузер не получил доступ к камере или микрофону. Разрешите доступ и попробуйте снова."
    }

    if (errorName === "NotFoundError" || /requested device not found|device not found/i.test(normalizedMessage)) {
      return "Камера или микрофон не найдены. Подключите устройство и попробуйте снова."
    }

    if (errorName === "NotReadableError" || /device in use|notreadable|could not start video source|track start/i.test(normalizedMessage)) {
      return "Камера или микрофон сейчас заняты другим приложением. Закройте его и попробуйте снова."
    }

    if (errorName === "OverconstrainedError" || /invalid constraint|overconstrained/i.test(normalizedMessage)) {
      return "Не удалось подобрать подходящие настройки камеры или микрофона. Обновите страницу и попробуйте снова."
    }

    if (errorName === "AbortError") {
      return "Подключение камеры или микрофона прервалось. Попробуйте снова."
    }

    if (errorName === "SecurityError") {
      return "Браузер заблокировал доступ к камере или микрофону на этой странице. Откройте приглашение в обычном браузере и попробуйте снова."
    }

    return rawMessage
  }

  return "Что-то пошло не так. Попробуйте еще раз."
}
