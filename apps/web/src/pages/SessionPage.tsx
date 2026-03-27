import {
  CircleAlert,
  Camera,
  CameraOff,
  Check,
  Copy,
  ExternalLink,
  Eye,
  Link2,
  LoaderCircle,
  Mail,
  MessageCircle,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  QrCode,
  Send,
  Settings2,
  Share2,
  X,
} from "lucide-react"
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { getIceServers, getSessionInfo, getWebSocketUrl, humanizeError } from "@/lib/api"
import { cn, shortSessionId } from "@/lib/utils"
import type {
  ConnectionStage,
  ConnectionPath,
  IceServerConfig,
  MediaState,
  ParticipantRole,
  SessionInfoResponse,
  WsMessage,
} from "@/lib/types"

type DeviceOption = {
  deviceId: string
  label: string
}

type DeviceLists = {
  audioInputs: DeviceOption[]
  videoInputs: DeviceOption[]
  audioOutputs: DeviceOption[]
}

type HtmlMediaElementWithSinkId = HTMLVideoElement & {
  setSinkId?: (sinkId: string) => Promise<void>
}

type ConnectionPathDetails = {
  path: ConnectionPath
  localCandidateType: string | null
  remoteCandidateType: string | null
}

type TransportStatsWithSelectedPair = RTCStats & {
  selectedCandidatePairId?: string
}

type CandidatePairStatsLike = RTCStats & {
  localCandidateId?: string
  remoteCandidateId?: string
  nominated?: boolean
  selected?: boolean
  state?: string
}

type CandidateStatsLike = RTCStats & {
  candidateType?: string
}

type InviteActionFeedback = {
  tone: "success" | "error" | "info"
  message: string
}

const defaultMediaState: MediaState = { audioEnabled: true, videoEnabled: true }

const stageCopy: Record<ConnectionStage, { label: string; badge: "amber" | "blue" | "green" | "rose" | "slate" }> = {
  loading: { label: "Открываем звонок", badge: "slate" },
  preparing: { label: "Проверяем камеру и звук", badge: "blue" },
  waiting: { label: "Ждем собеседника", badge: "amber" },
  connecting: { label: "Подключаем собеседника", badge: "blue" },
  connected: { label: "Можно разговаривать", badge: "green" },
  reconnecting: { label: "Возвращаем звонок", badge: "amber" },
  ended: { label: "Звонок завершен", badge: "slate" },
  failed: { label: "Связь недоступна", badge: "rose" },
}

const roleCopy: Record<ParticipantRole, string> = {
  host: "Вы начали звонок",
  guest: "Вы подключились по приглашению",
}

const connectionPathCopy: Record<ConnectionPath, string> = {
  unknown: "Определяем",
  direct: "Напрямую",
  relay: "Через запасной канал",
}

function extractTurnCredentialExpiry(iceServers: IceServerConfig[]) {
  const expirationCandidates = iceServers
    .filter((server) => server.urls.some((url) => url.startsWith("turn:")))
    .map((server) => server.username?.split(":", 1)[0] ?? "")
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value > 0)

  if (expirationCandidates.length === 0) {
    return null
  }

  return Math.min(...expirationCandidates) * 1_000
}

function isConstraintError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  const name = "name" in error ? String((error as { name?: unknown }).name) : ""

  return (
    name === "OverconstrainedError" ||
    message.includes("invalid constraint") ||
    message.includes("overconstrained")
  )
}

function getMediaEnvironmentIssue() {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "На этой странице камера и микрофон не работают. Откройте приглашение заново в обычном браузере и попробуйте еще раз."
  }

  if (!navigator.mediaDevices) {
    return "На этой странице браузер не может включить камеру и микрофон. Откройте ссылку в обычном браузере и попробуйте снова."
  }

  if (typeof navigator.mediaDevices.getUserMedia !== "function") {
    return "Этот браузер не может включить камеру и микрофон для звонка. Откройте приглашение в Chrome, Safari или другом обычном браузере."
  }

  return null
}

function buildMediaConstraints(options: {
  videoDeviceId?: string
  audioDeviceId?: string
  mode?: "exact" | "ideal" | "default"
  width?: number
  height?: number
  audio?: boolean
  video?: boolean
}): MediaStreamConstraints {
  const {
    videoDeviceId,
    audioDeviceId,
    mode = "default",
    width,
    height,
    audio = true,
    video = true,
  } = options

  let videoConstraints: MediaTrackConstraints | boolean = false
  if (video) {
    if (mode === "default" && !width && !height) {
      videoConstraints = true
    } else {
      const nextVideoConstraints: MediaTrackConstraints = {}
      if (videoDeviceId) {
        nextVideoConstraints.deviceId = mode === "exact" ? { exact: videoDeviceId } : { ideal: videoDeviceId }
      }
      if (width) {
        nextVideoConstraints.width = { ideal: width }
      }
      if (height) {
        nextVideoConstraints.height = { ideal: height }
      }
      videoConstraints = Object.keys(nextVideoConstraints).length > 0 ? nextVideoConstraints : true
    }
  }

  let audioConstraints: MediaTrackConstraints | boolean = false
  if (audio) {
    if (mode === "default" || !audioDeviceId) {
      audioConstraints = true
    } else {
      audioConstraints = {
        deviceId: mode === "exact" ? { exact: audioDeviceId } : { ideal: audioDeviceId },
      }
    }
  }

  return {
    video: videoConstraints,
    audio: audioConstraints,
  }
}

function uniqDevices(devices: DeviceOption[]) {
  return devices.filter((device, index, array) => array.findIndex((item) => item.deviceId === device.deviceId) === index)
}

function fallbackDevicesFromStream(stream: MediaStream | null): DeviceLists {
  const audioInputs = stream?.getAudioTracks().map((track, index) => ({
    deviceId: track.getSettings().deviceId ?? `current-audio-${index}`,
    label: track.label || `Текущий микрофон ${index + 1}`,
  })) ?? []

  const videoInputs = stream?.getVideoTracks().map((track, index) => ({
    deviceId: track.getSettings().deviceId ?? `current-video-${index}`,
    label: track.label || `Текущая камера ${index + 1}`,
  })) ?? []

  return {
    audioInputs,
    videoInputs,
    audioOutputs: [],
  }
}

const focusableDialogSelector = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableDialogSelector)).filter(
    (element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0,
  )
}

function buildInviteCopy(shareUrl: string) {
  const title = "Приглашение на видеозвонок"
  const text = "Вас приглашают на видеозвонок. Откройте ссылку, чтобы присоединиться."

  return {
    title,
    subject: title,
    text,
    message: `${text}\n\n${shareUrl}`,
    shareUrl,
  }
}

function buildSmsHref(message: string) {
  return `sms:?&body=${encodeURIComponent(message)}`
}

function isIosDevice() {
  if (typeof navigator === "undefined") {
    return false
  }

  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1)
}

function canUseNativeShare(data: ShareData) {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return false
  }

  if (typeof navigator.canShare === "function") {
    try {
      return navigator.canShare(data)
    } catch {
      return false
    }
  }

  return true
}

function isShareAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

async function writeTextToClipboard(value: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard API недоступен в текущем окружении.")
  }

  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  textarea.style.pointerEvents = "none"
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()

  const copied = document.execCommand("copy")
  document.body.removeChild(textarea)

  if (!copied) {
    throw new Error("Не удалось скопировать текст.")
  }
}

export function SessionPage() {
  const navigate = useNavigate()
  const { sessionId } = useParams<{ sessionId: string }>()
  const location = useLocation()
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search])
  const joinToken = searchParams.get("joinToken") ?? ""
  const iceTransportPolicy = searchParams.get("iceTransport") === "relay" ? "relay" : "all"
  const supportMode = searchParams.get("support") === "1" || searchParams.get("debug") === "1"

  const [sessionInfo, setSessionInfo] = useState<SessionInfoResponse | null>(null)
  const [connectionStage, setConnectionStage] = useState<ConnectionStage>("loading")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [statusNote, setStatusNote] = useState<string | null>(null)
  const [copyLinkLabel, setCopyLinkLabel] = useState("Скопировать ссылку")
  const [isInvitePanelVisible, setIsInvitePanelVisible] = useState(false)
  const [inviteActionFeedback, setInviteActionFeedback] = useState<InviteActionFeedback | null>(null)
  const [inviteQrCodeUrl, setInviteQrCodeUrl] = useState<string | null>(null)
  const [inviteQrCodeError, setInviteQrCodeError] = useState<string | null>(null)
  const [devices, setDevices] = useState<DeviceLists>({ audioInputs: [], videoInputs: [], audioOutputs: [] })
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState("")
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState("")
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState("")
  const [localMediaState, setLocalMediaState] = useState<MediaState>(defaultMediaState)
  const [remoteMediaState, setRemoteMediaState] = useState<MediaState>(defaultMediaState)
  const [role, setRole] = useState<ParticipantRole | null>(null)
  const [remoteConnected, setRemoteConnected] = useState(false)
  const [supportsAudioOutputSelection, setSupportsAudioOutputSelection] = useState(false)
  const [isLocalPreviewVisible, setIsLocalPreviewVisible] = useState(true)
  const [isSettingsVisible, setIsSettingsVisible] = useState(false)
  const [mediaAccessIssue, setMediaAccessIssue] = useState<string | null>(null)
  const [connectionPath, setConnectionPath] = useState<ConnectionPath>("unknown")

  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream>(new MediaStream())
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  const webSocketRef = useRef<WebSocket | null>(null)
  const roleRef = useRef<ParticipantRole | null>(null)
  const localMediaStateRef = useRef<MediaState>(defaultMediaState)
  const selectedVideoDeviceIdRef = useRef("")
  const selectedAudioDeviceIdRef = useRef("")
  const selectedAudioOutputIdRef = useRef("")
  const sessionInfoRef = useRef<SessionInfoResponse | null>(null)
  const iceServersRef = useRef<RTCIceServer[]>([])
  const leavingRef = useRef(false)
  const connectionStageRef = useRef<ConnectionStage>("loading")
  const reconnectTimeoutRef = useRef<number | null>(null)
  const connectionPathTimeoutRef = useRef<number | null>(null)
  const iceRefreshTimeoutRef = useRef<number | null>(null)
  const copyLinkResetTimeoutRef = useRef<number | null>(null)
  const inviteFeedbackResetTimeoutRef = useRef<number | null>(null)
  const inviteDialogRef = useRef<HTMLDivElement>(null)
  const previousFocusedElementRef = useRef<HTMLElement | null>(null)
  const reconnectAttemptRef = useRef(0)
  const reconnectEnabledRef = useRef(true)
  const turnCredentialExpiryRef = useRef<number | null>(null)

  function attachLocalStream(stream: MediaStream | null) {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream
    }
  }

  function attachRemoteStream(stream: MediaStream) {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }
  }

  function clearConnectionPathTimer() {
    if (connectionPathTimeoutRef.current !== null) {
      window.clearTimeout(connectionPathTimeoutRef.current)
      connectionPathTimeoutRef.current = null
    }
  }

  function clearIceRefreshTimer() {
    if (iceRefreshTimeoutRef.current !== null) {
      window.clearTimeout(iceRefreshTimeoutRef.current)
      iceRefreshTimeoutRef.current = null
    }
  }

  function clearCopyLinkResetTimer() {
    if (copyLinkResetTimeoutRef.current !== null) {
      window.clearTimeout(copyLinkResetTimeoutRef.current)
      copyLinkResetTimeoutRef.current = null
    }
  }

  function clearInviteFeedbackResetTimer() {
    if (inviteFeedbackResetTimeoutRef.current !== null) {
      window.clearTimeout(inviteFeedbackResetTimeoutRef.current)
      inviteFeedbackResetTimeoutRef.current = null
    }
  }

  function patchSessionInfo(patch: Partial<SessionInfoResponse>) {
    if (!sessionInfoRef.current) {
      return
    }

    const nextSessionInfo = { ...sessionInfoRef.current, ...patch }
    sessionInfoRef.current = nextSessionInfo
    setSessionInfo(nextSessionInfo)
  }

  function hasReusablePeerConnection(peerConnection: RTCPeerConnection | null = peerConnectionRef.current) {
    if (!peerConnection) {
      return false
    }

    if (peerConnection.connectionState === "connected" || peerConnection.connectionState === "connecting") {
      return true
    }

    if (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed") {
      return true
    }

    return remoteStreamRef.current.getTracks().length > 0
  }

  function scheduleIceServerRefresh(currentSessionId: string, currentJoinToken: string, expiresAtMs: number | null) {
    clearIceRefreshTimer()
    turnCredentialExpiryRef.current = expiresAtMs

    if (expiresAtMs === null) {
      return
    }

    const remainingMs = expiresAtMs - Date.now()
    const bufferMs = Math.min(60_000, Math.max(5_000, Math.floor(Math.max(remainingMs, 1_000) * 0.1)))
    const delayMs = Math.max(1_000, remainingMs - bufferMs)

    iceRefreshTimeoutRef.current = window.setTimeout(() => {
      void refreshIceServersForSession(currentSessionId, currentJoinToken, "scheduled", true)
    }, delayMs)
  }

  function applyIceServers(
    nextIceServers: IceServerConfig[],
    currentSessionId: string,
    currentJoinToken: string,
    reason: string,
  ) {
    const nextRtcIceServers = nextIceServers.map(toRtcIceServer)
    iceServersRef.current = nextRtcIceServers
    scheduleIceServerRefresh(currentSessionId, currentJoinToken, extractTurnCredentialExpiry(nextIceServers))

    const peerConnection = peerConnectionRef.current
    if (peerConnection) {
      try {
        peerConnection.setConfiguration({
          ...peerConnection.getConfiguration(),
          iceServers: nextRtcIceServers,
        })
      } catch (error) {
        console.warn("Unable to refresh ICE server configuration on the current peer connection", { reason, error })
      }
    }
  }

  async function refreshIceServersForSession(
    currentSessionId: string,
    currentJoinToken: string,
    reason: string,
    failSilently = false,
  ) {
    try {
      const iceServers = await getIceServers(currentSessionId, currentJoinToken)
      if (leavingRef.current) {
        return
      }

      applyIceServers(iceServers.iceServers, currentSessionId, currentJoinToken, reason)
      console.info("Refreshed ICE server configuration", {
        reason,
        turnEnabled: iceServers.iceServers.some((server) => server.urls.some((url) => url.startsWith("turn:"))),
      })
    } catch (error) {
      console.warn("Unable to refresh ICE server configuration", { reason, error })
      if (failSilently && !leavingRef.current) {
        clearIceRefreshTimer()
        iceRefreshTimeoutRef.current = window.setTimeout(() => {
          void refreshIceServersForSession(currentSessionId, currentJoinToken, `${reason}-retry`, true)
        }, 10_000)
        return
      }

      throw error
    }
  }

  async function ensureFreshIceServers(currentSessionId: string, currentJoinToken: string, reason: string) {
    const expiresAtMs = turnCredentialExpiryRef.current
    if (expiresAtMs === null) {
      return
    }

    if (expiresAtMs - Date.now() > 60_000) {
      return
    }

    await refreshIceServersForSession(currentSessionId, currentJoinToken, `${reason}-preemptive-refresh`)
  }

  async function describeConnectionPath(peerConnection: RTCPeerConnection): Promise<ConnectionPathDetails> {
    const stats = await peerConnection.getStats()
    let selectedPair: RTCStats | null = null

    stats.forEach((report) => {
      if (selectedPair || report.type !== "transport") {
        return
      }

      const transport = report as TransportStatsWithSelectedPair
      if (transport.selectedCandidatePairId) {
        selectedPair = stats.get(transport.selectedCandidatePairId) ?? null
      }
    })

    stats.forEach((report) => {
      if (selectedPair || report.type !== "candidate-pair") {
        return
      }

      const pair = report as CandidatePairStatsLike
      if (pair.selected || (pair.state === "succeeded" && pair.nominated)) {
        selectedPair = report
      }
    })

    if (!selectedPair) {
      return { path: "unknown", localCandidateType: null, remoteCandidateType: null }
    }

    const pair = selectedPair as CandidatePairStatsLike
    if (!pair.localCandidateId && !pair.remoteCandidateId) {
      return { path: "unknown", localCandidateType: null, remoteCandidateType: null }
    }
    const localCandidate = pair.localCandidateId ? (stats.get(pair.localCandidateId) as CandidateStatsLike | undefined) : undefined
    const remoteCandidate = pair.remoteCandidateId ? (stats.get(pair.remoteCandidateId) as CandidateStatsLike | undefined) : undefined
    const localCandidateType = localCandidate?.candidateType ?? null
    const remoteCandidateType = remoteCandidate?.candidateType ?? null
    const path: ConnectionPath =
      localCandidateType === "relay" || remoteCandidateType === "relay"
        ? "relay"
        : localCandidateType || remoteCandidateType
          ? "direct"
          : "unknown"

    return {
      path,
      localCandidateType,
      remoteCandidateType,
    }
  }

  async function inspectConnectionPath(peerConnection: RTCPeerConnection, reason: string, attempt = 0) {
    try {
      const details = await describeConnectionPath(peerConnection)
      if (peerConnection !== peerConnectionRef.current) {
        return
      }

      if (details.path === "unknown") {
        const isConnected =
          peerConnection.connectionState === "connected" ||
          peerConnection.iceConnectionState === "connected" ||
          peerConnection.iceConnectionState === "completed"

        if (iceTransportPolicy === "relay" && isConnected) {
          setConnectionPath("relay")
          console.info("Marked WebRTC connection path as relay due to relay-only policy", {
            reason,
            attempt,
            connectionState: peerConnection.connectionState,
            iceConnectionState: peerConnection.iceConnectionState,
          })
          return
        }

        if (attempt < 4) {
          clearConnectionPathTimer()
          connectionPathTimeoutRef.current = window.setTimeout(() => {
            void inspectConnectionPath(peerConnection, `${reason}-retry`, attempt + 1)
          }, 750 * (attempt + 1))
          return
        }
      }

      clearConnectionPathTimer()
      setConnectionPath(details.path)
      console.info("Resolved WebRTC connection path", {
        reason,
        path: details.path,
        localCandidateType: details.localCandidateType,
        remoteCandidateType: details.remoteCandidateType,
        connectionState: peerConnection.connectionState,
        iceConnectionState: peerConnection.iceConnectionState,
        iceTransportPolicy,
      })
    } catch (error) {
      console.warn("Unable to inspect WebRTC candidate pair", error)
      if (peerConnection === peerConnectionRef.current && attempt < 4) {
        clearConnectionPathTimer()
        connectionPathTimeoutRef.current = window.setTimeout(() => {
          void inspectConnectionPath(peerConnection, `${reason}-retry`, attempt + 1)
        }, 750 * (attempt + 1))
      }
    }
  }

  async function refreshDevices(stream: MediaStream | null = localStreamRef.current) {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDevices(fallbackDevicesFromStream(stream))
      return
    }

    let nextDevices: DeviceLists
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices()
      const fallbackDevices = fallbackDevicesFromStream(stream)
      nextDevices = {
        audioInputs: uniqDevices([
          ...allDevices
            .filter((device) => device.kind === "audioinput")
            .map((device, index) => ({
              deviceId: device.deviceId || `audioinput-${index}`,
              label: device.label || `Микрофон ${index + 1}`,
            })),
          ...fallbackDevices.audioInputs,
        ]),
        videoInputs: uniqDevices([
          ...allDevices
            .filter((device) => device.kind === "videoinput")
            .map((device, index) => ({
              deviceId: device.deviceId || `videoinput-${index}`,
              label: device.label || `Камера ${index + 1}`,
            })),
          ...fallbackDevices.videoInputs,
        ]),
        audioOutputs: uniqDevices(
          allDevices
            .filter((device) => device.kind === "audiooutput")
            .map((device, index) => ({
              deviceId: device.deviceId || `audiooutput-${index}`,
              label: device.label || `Выход ${index + 1}`,
            })),
        ),
      }
    } catch (error) {
      console.error("enumerateDevices failed", error)
      nextDevices = fallbackDevicesFromStream(stream)
    }

    setDevices(nextDevices)

    if (
      (!selectedVideoDeviceIdRef.current ||
        !nextDevices.videoInputs.some((device) => device.deviceId === selectedVideoDeviceIdRef.current)) &&
      nextDevices.videoInputs[0]
    ) {
      selectedVideoDeviceIdRef.current = nextDevices.videoInputs[0].deviceId
      setSelectedVideoDeviceId(nextDevices.videoInputs[0].deviceId)
    }

    if (
      (!selectedAudioDeviceIdRef.current ||
        !nextDevices.audioInputs.some((device) => device.deviceId === selectedAudioDeviceIdRef.current)) &&
      nextDevices.audioInputs[0]
    ) {
      selectedAudioDeviceIdRef.current = nextDevices.audioInputs[0].deviceId
      setSelectedAudioDeviceId(nextDevices.audioInputs[0].deviceId)
    }

    if (
      (!selectedAudioOutputIdRef.current ||
        !nextDevices.audioOutputs.some((device) => device.deviceId === selectedAudioOutputIdRef.current)) &&
      nextDevices.audioOutputs[0]
    ) {
      selectedAudioOutputIdRef.current = nextDevices.audioOutputs[0].deviceId
      setSelectedAudioOutputId(nextDevices.audioOutputs[0].deviceId)
    }
  }

  async function applyAudioOutputDevice(deviceId: string) {
    const videoElement = remoteVideoRef.current as HtmlMediaElementWithSinkId | null
    if (!videoElement || typeof videoElement.setSinkId !== "function" || !deviceId) {
      return
    }

    await videoElement.setSinkId(deviceId)
  }

  async function replaceTracks(previousStream: MediaStream | null, nextStream: MediaStream) {
    const peerConnection = peerConnectionRef.current
    if (!peerConnection) {
      previousStream?.getTracks().forEach((track) => track.stop())
      return
    }

    const senders = peerConnection.getSenders()
    const audioSender = senders.find((sender) => sender.track?.kind === "audio")
    const videoSender = senders.find((sender) => sender.track?.kind === "video")
    const nextAudioTrack = nextStream.getAudioTracks()[0] ?? null
    const nextVideoTrack = nextStream.getVideoTracks()[0] ?? null

    if (audioSender) {
      await audioSender.replaceTrack(nextAudioTrack)
    } else if (nextAudioTrack) {
      peerConnection.addTrack(nextAudioTrack, nextStream)
    }

    if (videoSender) {
      await videoSender.replaceTrack(nextVideoTrack)
    } else if (nextVideoTrack) {
      peerConnection.addTrack(nextVideoTrack, nextStream)
    }

    previousStream?.getTracks().forEach((track) => track.stop())
  }

  async function initializeLocalMedia(nextVideoDeviceId?: string, nextAudioDeviceId?: string) {
    const mediaEnvironmentIssue = getMediaEnvironmentIssue()
    if (mediaEnvironmentIssue) {
      throw new Error(mediaEnvironmentIssue)
    }

    setConnectionStage((current) => (current === "loading" ? "preparing" : current))
    const previousStream = localStreamRef.current
    const attempts: Array<{
      label: string
      constraints: MediaStreamConstraints
    }> = [
      {
        label: "exact-device-hd",
        constraints: buildMediaConstraints({
          videoDeviceId: nextVideoDeviceId,
          audioDeviceId: nextAudioDeviceId,
          mode: "exact",
          width: 1280,
          height: 720,
        }),
      },
      {
        label: "ideal-device-hd",
        constraints: buildMediaConstraints({
          videoDeviceId: nextVideoDeviceId,
          audioDeviceId: nextAudioDeviceId,
          mode: "ideal",
          width: 1280,
          height: 720,
        }),
      },
      {
        label: "default-hd",
        constraints: buildMediaConstraints({
          width: 1280,
          height: 720,
          mode: "default",
        }),
      },
      {
        label: "default-sd",
        constraints: buildMediaConstraints({
          width: 640,
          height: 480,
          mode: "default",
        }),
      },
      {
        label: "video-only-hd",
        constraints: buildMediaConstraints({
          width: 1280,
          height: 720,
          mode: "default",
          audio: false,
          video: true,
        }),
      },
      {
        label: "video-only-sd",
        constraints: buildMediaConstraints({
          width: 640,
          height: 480,
          mode: "default",
          audio: false,
          video: true,
        }),
      },
      {
        label: "audio-only",
        constraints: buildMediaConstraints({
          mode: "default",
          audio: true,
          video: false,
        }),
      },
    ]

    let nextStream: MediaStream | null = null
    let lastError: unknown = null

    for (const attempt of attempts) {
      try {
        nextStream = await navigator.mediaDevices.getUserMedia(attempt.constraints)
        break
      } catch (error) {
        console.error(`getUserMedia failed on attempt ${attempt.label}`, error, attempt.constraints)
        lastError = error
        if (!isConstraintError(error)) {
          throw error
        }
      }
    }

    if (!nextStream) {
      throw lastError instanceof Error ? lastError : new Error("Не удалось получить доступ к камере и микрофону.")
    }

    nextStream.getAudioTracks().forEach((track) => {
      track.enabled = localMediaStateRef.current.audioEnabled
      selectedAudioDeviceIdRef.current = track.getSettings().deviceId ?? nextAudioDeviceId ?? selectedAudioDeviceIdRef.current
    })
    nextStream.getVideoTracks().forEach((track) => {
      track.enabled = localMediaStateRef.current.videoEnabled
      selectedVideoDeviceIdRef.current = track.getSettings().deviceId ?? nextVideoDeviceId ?? selectedVideoDeviceIdRef.current
    })

    localStreamRef.current = nextStream
    attachLocalStream(nextStream)
    await replaceTracks(previousStream, nextStream)
    await refreshDevices(nextStream)
    setSelectedAudioDeviceId(selectedAudioDeviceIdRef.current)
    setSelectedVideoDeviceId(selectedVideoDeviceIdRef.current)
  }

  function sendSocketMessage(type: string, payload: Record<string, unknown> | MediaState = {}) {
    const socket = webSocketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return
    }

    socket.send(JSON.stringify({ type, payload }))
  }

  function clearRemoteStream() {
    remoteStreamRef.current.getTracks().forEach((track) => track.stop())
    remoteStreamRef.current = new MediaStream()
    attachRemoteStream(remoteStreamRef.current)
    setRemoteConnected(false)
    setRemoteMediaState(defaultMediaState)
    setConnectionPath("unknown")
    clearConnectionPathTimer()
  }

  async function resetPeerConnection(clearRemote = true) {
    const peerConnection = peerConnectionRef.current
    if (peerConnection) {
      peerConnection.onicecandidate = null
      peerConnection.ontrack = null
      peerConnection.onconnectionstatechange = null
      peerConnection.oniceconnectionstatechange = null
      peerConnection.close()
      peerConnectionRef.current = null
    }

    pendingCandidatesRef.current = []
    setConnectionPath("unknown")
    clearConnectionPathTimer()

    if (clearRemote) {
      clearRemoteStream()
    }
  }

  async function ensurePeerConnection() {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current
    }

    const peerConnection = new RTCPeerConnection({
      iceServers: iceServersRef.current,
      iceTransportPolicy,
    })

    remoteStreamRef.current = new MediaStream()
    attachRemoteStream(remoteStreamRef.current)

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.debug("Sending ICE candidate", { candidate: event.candidate.toJSON().candidate })
        sendSocketMessage("webrtc.ice_candidate", {
          candidate: event.candidate.toJSON(),
        })
      }
    }

    peerConnection.ontrack = (event) => {
      event.streams.forEach((stream) => {
        stream.getTracks().forEach((track) => {
          if (!remoteStreamRef.current.getTracks().some((existingTrack) => existingTrack.id === track.id)) {
            remoteStreamRef.current.addTrack(track)
          }
        })
      })
      attachRemoteStream(remoteStreamRef.current)
      setRemoteConnected(true)
      setConnectionStage("connected")
      if (iceTransportPolicy === "relay") {
        clearConnectionPathTimer()
        setConnectionPath("relay")
        console.info("Marked WebRTC connection path as relay after remote track attachment", {
          iceTransportPolicy,
          trackCount: remoteStreamRef.current.getTracks().length,
        })
      } else {
        void inspectConnectionPath(peerConnection, "track-attached")
      }
    }

    peerConnection.onconnectionstatechange = () => {
      console.info("Peer connection state changed", {
        connectionState: peerConnection.connectionState,
        iceConnectionState: peerConnection.iceConnectionState,
      })
      switch (peerConnection.connectionState) {
        case "connecting":
          setConnectionStage("connecting")
          break
        case "connected":
          setConnectionStage("connected")
          setRemoteConnected(true)
          setStatusNote(null)
          setErrorMessage(null)
          void inspectConnectionPath(peerConnection, "connectionstate-connected")
          break
        case "disconnected":
          setConnectionStage("connecting")
          setRemoteConnected(false)
          setStatusNote("Связь стала нестабильной. Пытаемся вернуть звук и видео без перезагрузки страницы.")
          break
        case "failed":
          setConnectionStage("failed")
          setStatusNote(null)
          setErrorMessage("Не удалось снова соединить звонок. Откройте ссылку еще раз.")
          break
        default:
          break
      }
    }

    peerConnection.oniceconnectionstatechange = () => {
      console.info("ICE connection state changed", {
        iceConnectionState: peerConnection.iceConnectionState,
        connectionState: peerConnection.connectionState,
      })
      if (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed") {
        void inspectConnectionPath(peerConnection, `ice-${peerConnection.iceConnectionState}`)
      }
    }

    localStreamRef.current?.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStreamRef.current!)
    })

    peerConnectionRef.current = peerConnection
    return peerConnection
  }

  async function flushPendingCandidates() {
    const peerConnection = peerConnectionRef.current
    if (!peerConnection || !peerConnection.remoteDescription) {
      return
    }

    while (pendingCandidatesRef.current.length > 0) {
      const candidate = pendingCandidatesRef.current.shift()
      if (candidate) {
        await peerConnection.addIceCandidate(candidate)
      }
    }
  }

  async function createOffer() {
    if (sessionId && joinToken) {
      await ensureFreshIceServers(sessionId, joinToken, "create-offer")
    }

    const peerConnection = await ensurePeerConnection()
    if (peerConnection.signalingState !== "stable") {
      return
    }

    console.info("Creating WebRTC offer", {
      role: roleRef.current,
      iceTransportPolicy,
    })
    setConnectionStage("connecting")
    const offer = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offer)
    sendSocketMessage("webrtc.offer", { sdp: offer.sdp })
  }

  async function handleIncomingOffer(payload: Record<string, unknown>) {
    if (sessionId && joinToken) {
      await ensureFreshIceServers(sessionId, joinToken, "incoming-offer")
    }

    await resetPeerConnection(false)
    const peerConnection = await ensurePeerConnection()
    setConnectionStage("connecting")

    await peerConnection.setRemoteDescription({
      type: "offer",
      sdp: String(payload.sdp ?? ""),
    })
    await flushPendingCandidates()

    const answer = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answer)
    sendSocketMessage("webrtc.answer", { sdp: answer.sdp })
  }

  async function handleIncomingAnswer(payload: Record<string, unknown>) {
    const peerConnection = await ensurePeerConnection()
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: String(payload.sdp ?? ""),
    })
    await flushPendingCandidates()
  }

  async function handleIncomingCandidate(payload: Record<string, unknown>) {
    const candidate = payload.candidate as RTCIceCandidateInit | undefined
    if (!candidate) {
      return
    }

    const peerConnection = await ensurePeerConnection()
    if (!peerConnection.remoteDescription) {
      pendingCandidatesRef.current.push(candidate)
      return
    }

    await peerConnection.addIceCandidate(candidate)
  }

  async function handleServerMessage(rawEvent: MessageEvent<string>) {
    const message = JSON.parse(rawEvent.data) as WsMessage<Record<string, unknown>>
    console.info("Received signaling event", { type: message.type })

    switch (message.type) {
      case "session.ready": {
        reconnectEnabledRef.current = true
        reconnectAttemptRef.current = 0
        clearReconnectTimer()
        const nextRole = String(message.payload.role) as ParticipantRole
        const resumed = Boolean(message.payload.resumed)
        roleRef.current = nextRole
        setRole(nextRole)
        const peerPresent = Boolean(message.payload.peerPresent)
        const shouldCreateOffer = Boolean(message.payload.shouldCreateOffer)
        const activeParticipants = Number(message.payload.activeParticipants)
        const canReusePeerConnection = hasReusablePeerConnection()
        setErrorMessage(null)
        setStatusNote(null)
        if (Number.isFinite(activeParticipants)) {
          patchSessionInfo({ activeParticipants })
        }

        if (resumed && peerPresent && canReusePeerConnection) {
          setRemoteConnected(
            remoteStreamRef.current.getTracks().length > 0 || peerConnectionRef.current?.connectionState === "connected",
          )
          setConnectionStage("connected")
          const peerConnection = peerConnectionRef.current
          if (peerConnection) {
            if (iceTransportPolicy === "relay") {
              setConnectionPath("relay")
            } else {
              void inspectConnectionPath(peerConnection, "signaling-resumed")
            }
          }
          break
        }

        if (peerPresent) {
          setConnectionStage("connecting")
        } else {
          setConnectionStage("waiting")
        }

        if (peerPresent && nextRole === "host" && !canReusePeerConnection && resumed) {
          await resetPeerConnection(true)
          await createOffer()
          break
        }

        if (peerPresent && nextRole === "guest" && !canReusePeerConnection && resumed) {
          await resetPeerConnection(true)
          sendSocketMessage("webrtc.restart_ice", {})
          break
        }

        if (shouldCreateOffer) {
          await createOffer()
        }
        break
      }
      case "participant.joined": {
        const activeParticipants = Number(message.payload.activeParticipants)
        if (Number.isFinite(activeParticipants)) {
          patchSessionInfo({ activeParticipants })
        }
        setStatusNote(null)
        setConnectionStage("connecting")
        if (roleRef.current === "host") {
          await resetPeerConnection(true)
          await createOffer()
        }
        break
      }
      case "participant.left": {
        const activeParticipants = Number(message.payload.activeParticipants)
        if (Number.isFinite(activeParticipants)) {
          patchSessionInfo({ activeParticipants })
        }
        await resetPeerConnection(true)
        setErrorMessage(null)
        setStatusNote("Собеседник вышел из звонка. Можно подождать здесь или отправить приглашение еще раз.")
        setConnectionStage("waiting")
        break
      }
      case "webrtc.offer": {
        await handleIncomingOffer(message.payload)
        break
      }
      case "webrtc.answer": {
        await handleIncomingAnswer(message.payload)
        break
      }
      case "webrtc.ice_candidate": {
        await handleIncomingCandidate(message.payload)
        break
      }
      case "webrtc.restart_ice": {
        if (roleRef.current === "host") {
          await resetPeerConnection(true)
          await createOffer()
        }
        break
      }
      case "media.state_changed": {
        setRemoteMediaState({
          audioEnabled: Boolean(message.payload.audioEnabled),
          videoEnabled: Boolean(message.payload.videoEnabled),
        })
        break
      }
      case "error": {
        const code = typeof message.payload.code === "string" ? message.payload.code : "unknown_error"
        const messageText =
          typeof message.payload.message === "string"
            ? message.payload.message
            : "Во время звонка произошла ошибка. Обновите страницу и попробуйте снова."
        const isTerminalSessionError = ["invalid_join_token", "session_not_found", "session_full", "session_ended"].includes(code)
        reconnectEnabledRef.current = !isTerminalSessionError
        if (isTerminalSessionError) {
          patchSessionInfo({
            canJoin: false,
            shareUrl: null,
            status: code === "session_ended" ? "ended" : sessionInfoRef.current?.status,
            message: messageText,
          })
        }
        setStatusNote(null)
        setErrorMessage(messageText)
        setConnectionStage(code === "session_ended" ? "ended" : "failed")
        break
      }
      default:
        break
    }
  }

  function scheduleSocketReconnect(currentSessionId: string, currentJoinToken: string) {
    if (leavingRef.current || !reconnectEnabledRef.current) {
      return
    }

    clearReconnectTimer()
    const nextAttempt = reconnectAttemptRef.current + 1
    reconnectAttemptRef.current = nextAttempt

    if (nextAttempt > 3) {
      setStatusNote(null)
      setConnectionStage("failed")
      setErrorMessage("Связь не восстановилась. Откройте ссылку еще раз, чтобы продолжить звонок.")
      return
    }

    const delayMs = Math.min(1_000 * nextAttempt, 4_000)
    setErrorMessage(null)
    setStatusNote(`Связь ненадолго прервалась. Возвращаем звонок (${nextAttempt}/3).`)
    setConnectionStage("reconnecting")
    console.warn("Scheduling signaling reconnect", { attempt: nextAttempt, delayMs })

    reconnectTimeoutRef.current = window.setTimeout(() => {
      openWebSocket(currentSessionId, currentJoinToken, true)
    }, delayMs)
  }

  function openWebSocket(currentSessionId: string, currentJoinToken: string, isReconnect = false) {
    reconnectEnabledRef.current = true
    clearReconnectTimer()
    console.info("Opening signaling socket", { isReconnect })
    const socket = new WebSocket(getWebSocketUrl())
    webSocketRef.current = socket

    socket.onopen = () => {
      console.info("Signaling socket open", { isReconnect })
      if (isReconnect) {
        setStatusNote("Связь вернулась. Проверяем, можно ли продолжить звонок.")
      }
      sendSocketMessage(isReconnect ? "session.resume" : "session.join", {
        sessionId: currentSessionId,
        joinToken: currentJoinToken,
      })
    }

    socket.onmessage = (event) => {
      void handleServerMessage(event)
    }

    socket.onclose = (event) => {
      console.info("Signaling socket closed", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      })
      if (webSocketRef.current === socket) {
        webSocketRef.current = null
      }
      if (!leavingRef.current && connectionStageRef.current !== "ended") {
        scheduleSocketReconnect(currentSessionId, currentJoinToken)
      }
    }

    socket.onerror = () => {
      console.warn("Signaling socket error")
    }
  }

  function broadcastLocalMediaState(nextState: MediaState) {
    sendSocketMessage("media.state_changed", nextState)
  }

  function openInvitePanel() {
    if (!isInviteAvailable) {
      return
    }

    clearInviteFeedbackResetTimer()
    setIsSettingsVisible(false)
    setInviteActionFeedback(null)
    setIsInvitePanelVisible(true)
  }

  function closeInvitePanel() {
    clearInviteFeedbackResetTimer()
    setInviteActionFeedback(null)
    setIsInvitePanelVisible(false)
  }

  async function tryNativeShare() {
    if (!nativeShareData || !canUseNativeShare(nativeShareData)) {
      return {
        shared: false,
        cancelled: false,
        errorMessage: null as string | null,
      }
    }

    try {
      await navigator.share(nativeShareData)
      return {
        shared: true,
        cancelled: false,
        errorMessage: null as string | null,
      }
    } catch (error) {
      if (isShareAbort(error)) {
        return {
          shared: false,
          cancelled: true,
          errorMessage: "Отправка отменена. Можно выбрать другой способ приглашения ниже.",
        }
      }

      console.warn("Native share failed", error)
      return {
        shared: false,
        cancelled: false,
        errorMessage: "Не удалось открыть системное меню отправки.",
      }
    }
  }

  async function handleShareInvite() {
    if (!inviteMeta || !isInviteAvailable) {
      return
    }

    setInviteActionFeedback(null)
    const shareAttempt = nativeShareAvailable
      ? await tryNativeShare()
      : { shared: false, cancelled: false, errorMessage: null as string | null }

    if (!shareAttempt.shared) {
      openInvitePanel()
      if (shareAttempt.errorMessage) {
        setInviteActionFeedback({
          tone: shareAttempt.cancelled ? "info" : "error",
          message: shareAttempt.cancelled
            ? shareAttempt.errorMessage
            : `${shareAttempt.errorMessage} Используйте быстрые каналы ниже.`,
        })
      }
    }
  }

  async function handleSmsInviteAction() {
    if (!inviteMeta || !isInviteAvailable || typeof window === "undefined") {
      return
    }

    if (!smsRequiresManualPaste) {
      window.location.assign(buildSmsHref(inviteMeta.message))
      return
    }

    try {
      await writeTextToClipboard(inviteMeta.message)
      setInviteActionFeedback({
        tone: "info",
        message: "iPhone открывает Messages без текста. Я скопировал приглашение в буфер, останется только вставить его в SMS.",
      })
    } catch (error) {
      setInviteActionFeedback({
        tone: "error",
        message: `iPhone не подставляет текст в SMS-ссылку, и скопировать приглашение не удалось: ${humanizeError(error)}`,
      })
    }

    window.location.assign("sms:")
  }

  async function handleNativeShareFromPanel() {
    if (!inviteMeta || !isInviteAvailable) {
      return
    }

    const shareAttempt = await tryNativeShare()
    if (!shareAttempt.shared) {
      setInviteActionFeedback({
        tone: shareAttempt.cancelled ? "info" : "error",
        message:
          shareAttempt.errorMessage ??
          (shareAttempt.cancelled
            ? "Отправка отменена. Можно выбрать другой способ приглашения ниже."
            : "Системное меню отправки недоступно. Используйте быстрые каналы ниже."),
      })
    }
  }

  async function handleCopyInviteLink() {
    if (!inviteMeta || !isInviteAvailable) {
      return
    }

    try {
      await writeTextToClipboard(inviteMeta.shareUrl)
      clearCopyLinkResetTimer()
      setCopyLinkLabel("Ссылка скопирована")
      copyLinkResetTimeoutRef.current = window.setTimeout(() => {
        setCopyLinkLabel("Скопировать ссылку")
        copyLinkResetTimeoutRef.current = null
      }, 1800)
      setInviteActionFeedback({
        tone: "success",
        message: "Ссылка для подключения скопирована.",
      })
    } catch (error) {
      clearCopyLinkResetTimer()
      setCopyLinkLabel("Не удалось")
      copyLinkResetTimeoutRef.current = window.setTimeout(() => {
        setCopyLinkLabel("Скопировать ссылку")
        copyLinkResetTimeoutRef.current = null
      }, 1800)
      setInviteActionFeedback({
        tone: "error",
        message: humanizeError(error),
      })
    }
  }

  async function handleCopyInviteText() {
    if (!inviteMeta || !isInviteAvailable) {
      return
    }

    try {
      await writeTextToClipboard(inviteMeta.message)
      setInviteActionFeedback({
        tone: "success",
        message: "Текст приглашения скопирован.",
      })
    } catch (error) {
      setInviteActionFeedback({
        tone: "error",
        message: humanizeError(error),
      })
    }
  }

  async function handleToggleAudio() {
    const track = localStreamRef.current?.getAudioTracks()[0]
    if (!track) {
      return
    }

    const nextState = !track.enabled
    track.enabled = nextState
    const mediaState = { ...localMediaStateRef.current, audioEnabled: nextState }
    localMediaStateRef.current = mediaState
    setLocalMediaState(mediaState)
    broadcastLocalMediaState(mediaState)
  }

  async function handleToggleVideo() {
    const track = localStreamRef.current?.getVideoTracks()[0]
    if (!track) {
      return
    }

    const nextState = !track.enabled
    track.enabled = nextState
    const mediaState = { ...localMediaStateRef.current, videoEnabled: nextState }
    localMediaStateRef.current = mediaState
    setLocalMediaState(mediaState)
    broadcastLocalMediaState(mediaState)
  }

  async function handleVideoDeviceChange(event: ChangeEvent<HTMLSelectElement>) {
    const previousDeviceId = selectedVideoDeviceIdRef.current
    const nextDeviceId = event.target.value
    selectedVideoDeviceIdRef.current = nextDeviceId
    setSelectedVideoDeviceId(nextDeviceId)

    try {
      setErrorMessage(null)
      await initializeLocalMedia(nextDeviceId, selectedAudioDeviceIdRef.current)
    } catch (error) {
      selectedVideoDeviceIdRef.current = previousDeviceId
      setSelectedVideoDeviceId(previousDeviceId)
      setErrorMessage(humanizeError(error))
    }
  }

  async function handleAudioDeviceChange(event: ChangeEvent<HTMLSelectElement>) {
    const previousDeviceId = selectedAudioDeviceIdRef.current
    const nextDeviceId = event.target.value
    selectedAudioDeviceIdRef.current = nextDeviceId
    setSelectedAudioDeviceId(nextDeviceId)

    try {
      setErrorMessage(null)
      await initializeLocalMedia(selectedVideoDeviceIdRef.current, nextDeviceId)
    } catch (error) {
      selectedAudioDeviceIdRef.current = previousDeviceId
      setSelectedAudioDeviceId(previousDeviceId)
      setErrorMessage(humanizeError(error))
    }
  }

  async function handleAudioOutputChange(event: ChangeEvent<HTMLSelectElement>) {
    const previousDeviceId = selectedAudioOutputIdRef.current
    const nextDeviceId = event.target.value
    selectedAudioOutputIdRef.current = nextDeviceId
    setSelectedAudioOutputId(nextDeviceId)

    try {
      setErrorMessage(null)
      await applyAudioOutputDevice(nextDeviceId)
    } catch (error) {
      selectedAudioOutputIdRef.current = previousDeviceId
      setSelectedAudioOutputId(previousDeviceId)
      setErrorMessage(humanizeError(error))
    }
  }

  async function cleanupSession() {
    leavingRef.current = true
    reconnectEnabledRef.current = false
    clearReconnectTimer()
    clearConnectionPathTimer()
    sendSocketMessage("session.leave", { sessionId })
    webSocketRef.current?.close()
    webSocketRef.current = null
    await resetPeerConnection(true)
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    attachLocalStream(null)
    setConnectionPath("unknown")
    clearIceRefreshTimer()
    turnCredentialExpiryRef.current = null
  }

  async function handleLeaveSession() {
    await cleanupSession()
    navigate("/")
  }

  useEffect(() => {
    setSupportsAudioOutputSelection(typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === "function")
  }, [])

  useEffect(() => {
    connectionStageRef.current = connectionStage
  }, [connectionStage])

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      if (!sessionId || !joinToken) {
        setConnectionStage("failed")
        setErrorMessage("Ссылка на звонок открыта не полностью. Откройте приглашение еще раз.")
        return
      }

      try {
        const session = await getSessionInfo(sessionId, joinToken)
        if (cancelled) {
          return
        }

        leavingRef.current = false
        reconnectEnabledRef.current = true
        reconnectAttemptRef.current = 0
        clearReconnectTimer()
        sessionInfoRef.current = session
        setSessionInfo(session)
        setRole(session.role)
        roleRef.current = session.role

        if (!session.canJoin || !session.role) {
          setStatusNote(null)
          setConnectionStage(session.status === "ended" || session.status === "expired" ? "ended" : "failed")
          setErrorMessage(session.message ?? "Этот звонок сейчас недоступен. Попросите отправить новое приглашение.")
          return
        }

        await refreshIceServersForSession(sessionId, joinToken, "bootstrap")
        if (cancelled) {
          return
        }

        const mediaEnvironmentIssue = getMediaEnvironmentIssue()
        if (mediaEnvironmentIssue) {
          const disabledMediaState = { audioEnabled: false, videoEnabled: false }
          localMediaStateRef.current = disabledMediaState
          setLocalMediaState(disabledMediaState)
          setMediaAccessIssue(mediaEnvironmentIssue)
          setErrorMessage(mediaEnvironmentIssue)
          attachLocalStream(null)
          await refreshDevices(null)
        } else {
          setMediaAccessIssue(null)
          await initializeLocalMedia()
          if (cancelled) {
            return
          }
        }

        if (supportMode && iceTransportPolicy === "relay") {
          setStatusNote("Режим проверки сети включен. При необходимости звонок пройдет через запасной маршрут.")
        } else {
          setStatusNote(null)
        }
        setConnectionStage("preparing")
        openWebSocket(sessionId, joinToken)
      } catch (error) {
        if (!cancelled) {
          setStatusNote(null)
          setConnectionStage("failed")
          const errorText = humanizeError(error)
          setErrorMessage(errorText)
        }
      }
    }

    void bootstrap()

    const handleDeviceChange = () => {
      void refreshDevices()
    }

    navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange)

    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange)
      clearReconnectTimer()
      clearIceRefreshTimer()
      clearCopyLinkResetTimer()
      clearInviteFeedbackResetTimer()
      void cleanupSession()
    }
  }, [iceTransportPolicy, joinToken, sessionId, supportMode])

  useEffect(() => {
    if (supportsAudioOutputSelection && selectedAudioOutputId) {
      void applyAudioOutputDevice(selectedAudioOutputId).catch((error: unknown) => {
        setErrorMessage(humanizeError(error))
      })
    }
  }, [selectedAudioOutputId, supportsAudioOutputSelection])

  const sessionLabel = sessionId ? shortSessionId(sessionId) : "----"
  const smsRequiresManualPaste = isIosDevice()
  const isInviteAvailable = Boolean(
    sessionInfo?.canJoin &&
      sessionInfo?.shareUrl &&
      sessionInfo.activeParticipants < sessionInfo.maxParticipants &&
      sessionInfo.status !== "ended" &&
      sessionInfo.status !== "expired",
  )
  const inviteMeta = useMemo(() => {
    if (!isInviteAvailable || !sessionInfo?.shareUrl) {
      return null
    }

    return buildInviteCopy(sessionInfo.shareUrl)
  }, [isInviteAvailable, sessionInfo?.shareUrl])
  const nativeShareData = inviteMeta
    ? {
        title: inviteMeta.title,
        text: inviteMeta.text,
        url: inviteMeta.shareUrl,
      }
    : null
  const inviteActions = useMemo(() => {
    if (!inviteMeta) {
      return []
    }

    return [
      {
        label: "WhatsApp",
        description: "Откроем чат с уже собранным текстом приглашения.",
        href: `https://wa.me/?text=${encodeURIComponent(inviteMeta.message)}`,
        icon: MessageCircle,
        external: true,
        accentClassName: "bg-emerald-400/15 text-emerald-200",
      },
      {
        label: "Telegram",
        description: "Откроем Telegram с готовой ссылкой и коротким приглашением.",
        href: `https://t.me/share/url?url=${encodeURIComponent(inviteMeta.shareUrl)}&text=${encodeURIComponent(inviteMeta.text)}`,
        icon: Send,
        external: true,
        accentClassName: "bg-sky-400/15 text-sky-200",
      },
      {
        label: "SMS",
        description: smsRequiresManualPaste
          ? "На iPhone откроем Messages и заранее скопируем текст приглашения в буфер."
          : "Откроем стандартное сообщение с готовым приглашением.",
        href: smsRequiresManualPaste ? null : buildSmsHref(inviteMeta.message),
        onClick: smsRequiresManualPaste ? () => void handleSmsInviteAction() : undefined,
        icon: MessageSquare,
        external: false,
        accentClassName: "bg-amber-300/15 text-amber-200",
      },
      {
        label: "E-mail",
        description: "Подставим тему письма и полный текст приглашения.",
        href: `mailto:?subject=${encodeURIComponent(inviteMeta.subject)}&body=${encodeURIComponent(inviteMeta.message)}`,
        icon: Mail,
        external: false,
        accentClassName: "bg-violet-300/15 text-violet-200",
      },
    ]
  }, [inviteMeta, smsRequiresManualPaste])
  const nativeShareAvailable = Boolean(isInviteAvailable && nativeShareData && canUseNativeShare(nativeShareData))

  useEffect(() => {
    clearInviteFeedbackResetTimer()

    if (!inviteActionFeedback || isInvitePanelVisible) {
      return
    }

    inviteFeedbackResetTimeoutRef.current = window.setTimeout(() => {
      setInviteActionFeedback(null)
      inviteFeedbackResetTimeoutRef.current = null
    }, 2200)

    return () => {
      clearInviteFeedbackResetTimer()
    }
  }, [inviteActionFeedback, isInvitePanelVisible])

  useEffect(() => {
    if (!isInvitePanelVisible) {
      return
    }

    const dialog = inviteDialogRef.current
    if (!dialog) {
      return
    }

    previousFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusDialog = window.requestAnimationFrame(() => {
      const focusableElements = getFocusableElements(dialog)
      ;(focusableElements[0] ?? dialog).focus()
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        closeInvitePanel()
        return
      }

      if (event.key !== "Tab") {
        return
      }

      const focusableElements = getFocusableElements(dialog)
      if (focusableElements.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const firstFocusable = focusableElements[0]
      const lastFocusable = focusableElements[focusableElements.length - 1]
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null

      if (event.shiftKey) {
        if (activeElement === firstFocusable || activeElement === dialog) {
          event.preventDefault()
          lastFocusable.focus()
        }
        return
      }

      if (activeElement === lastFocusable) {
        event.preventDefault()
        firstFocusable.focus()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusDialog)
      document.removeEventListener("keydown", handleKeyDown)
      previousFocusedElementRef.current?.focus()
    }
  }, [isInvitePanelVisible])

  useEffect(() => {
    if (!inviteMeta) {
      setInviteActionFeedback(null)
      setInviteQrCodeUrl(null)
      setInviteQrCodeError(null)
      setIsInvitePanelVisible(false)
      return
    }

    if (!isInvitePanelVisible) {
      setInviteQrCodeUrl(null)
      setInviteQrCodeError(null)
      return
    }

    let cancelled = false
    setInviteQrCodeUrl(null)
    setInviteQrCodeError(null)

    void import("qrcode")
      .then(({ toDataURL }) =>
        toDataURL(inviteMeta.shareUrl, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 320,
          color: {
            dark: "#0f172aff",
            light: "#ffffffff",
          },
        }),
      )
      .then((dataUrl) => {
        if (!cancelled) {
          setInviteQrCodeUrl(dataUrl)
        }
      })
      .catch((error: unknown) => {
        console.warn("QR code generation failed", error)
        if (!cancelled) {
          setInviteQrCodeError("Не удалось подготовить QR-код. Ниже остается ссылка для ручного открытия.")
        }
      })

    return () => {
      cancelled = true
    }
  }, [inviteMeta, isInvitePanelVisible])

  const stageMeta = stageCopy[connectionStage]
  const remoteWaitingTitle =
    connectionStage === "ended"
      ? "Звонок завершен"
      : connectionStage === "failed"
        ? "Подключиться не получилось"
        : connectionStage === "reconnecting"
      ? "Возвращаем звонок"
      : connectionStage === "connecting"
        ? "Подключаем собеседника"
        : "Ждем собеседника"
  const remoteWaitingDescription =
    connectionStage === "reconnecting"
      ? "Связь ненадолго прервалась. Пытаемся продолжить разговор без перезагрузки страницы."
      : connectionStage === "ended" || connectionStage === "failed"
        ? "По этой ссылке сейчас нельзя подключиться. Начните новый звонок или попросите отправить новое приглашение."
      : connectionStage === "connecting"
        ? "Подключаем звук и видео. Обычно это занимает всего несколько секунд."
        : "Отправьте приглашение удобным способом. Как только второй человек откроет ссылку, разговор начнется автоматически."
  const isRemoteVideoHidden = remoteConnected && !remoteMediaState.videoEnabled

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(14,165,233,0.16),transparent_30%),radial-gradient(circle_at_bottom,rgba(249,115,22,0.16),transparent_32%),linear-gradient(180deg,#020617_0%,#0f172a_100%)] p-2 sm:p-3 md:p-4">
      <div className="mx-auto flex min-h-[calc(100vh-1rem)] max-w-[2200px] items-center justify-center">
        <section
          className="relative w-full overflow-hidden rounded-[30px] border border-white/10 bg-slate-950 shadow-[0_40px_120px_rgba(2,6,23,0.65)]"
          style={{
            aspectRatio: "16 / 9",
            maxWidth: "min(100%, calc((100vh - 2rem) * 16 / 9))",
          }}
        >
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            data-testid="remote-video"
            className={cn("h-full w-full object-cover transition-opacity duration-300", !remoteConnected && "opacity-0")}
          />

          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-slate-950/55 via-transparent to-slate-950/80" />

          {!remoteConnected ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[radial-gradient(circle_at_top,rgba(14,165,233,0.22),transparent_32%),linear-gradient(180deg,#020617,#0f172a)] px-6 text-center text-white">
              <LoaderCircle className={cn("h-10 w-10", (connectionStage === "connecting" || connectionStage === "reconnecting") && "animate-spin")} />
              <div className="space-y-2">
                <p className="font-display text-2xl font-bold sm:text-3xl">{remoteWaitingTitle}</p>
                <p className="mx-auto max-w-xl text-sm leading-6 text-slate-300 sm:text-base">{remoteWaitingDescription}</p>
              </div>
            </div>
          ) : null}

          {isRemoteVideoHidden ? (
            <div className="absolute inset-0 flex items-center justify-center bg-slate-950/55 px-6 text-center text-white">
              <div className="space-y-2">
                <p className="font-display text-2xl font-bold sm:text-3xl">Видео собеседника скрыто</p>
                <p className="mx-auto max-w-lg text-sm leading-6 text-slate-300 sm:text-base">
                  Разговор продолжается, поэтому можно спокойно общаться только голосом.
                </p>
              </div>
            </div>
          ) : null}

          <div className="absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 sm:p-4 md:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="border border-white/10 bg-black/45 text-white backdrop-blur-xl" variant={stageMeta.badge}>
                <span data-testid="connection-stage">{stageMeta.label}</span>
              </Badge>
              {role ? (
                <span className="rounded-full border border-white/10 bg-black/45 px-3 py-1 text-xs font-medium text-slate-100 backdrop-blur-xl">
                  {roleCopy[role]}
                </span>
              ) : null}
              {supportMode ? (
                <span className="rounded-full border border-white/10 bg-black/45 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-100 backdrop-blur-xl">
                  код звонка {sessionLabel}
                </span>
              ) : null}
              {supportMode && connectionPath !== "unknown" ? (
                <span
                  className="rounded-full border border-emerald-300/20 bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-50 backdrop-blur-xl"
                  data-testid="connection-path"
                >
                  {connectionPathCopy[connectionPath]}
                </span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button
                className="gap-2 bg-orange-500 px-4 text-white shadow-[0_18px_40px_-24px_rgba(249,115,22,0.85)] hover:bg-orange-400"
                size="sm"
                onClick={() => void handleShareInvite()}
                disabled={!inviteMeta}
              >
                <Share2 className="h-4 w-4" />
                <span className="hidden sm:inline">Отправить приглашение</span>
                <span className="sm:hidden">Пригласить</span>
              </Button>

              <Button
                className="gap-2 border border-white/10 bg-black/45 px-4 text-white backdrop-blur-xl hover:bg-black/60"
                variant="outline"
                size="sm"
                onClick={() => void handleCopyInviteLink()}
                disabled={!inviteMeta}
                aria-label={copyLinkLabel}
                title={copyLinkLabel}
              >
                <Copy className="h-4 w-4" />
                <span className="hidden md:inline">{copyLinkLabel}</span>
              </Button>

              <Button
                className="h-9 w-9 border border-white/10 bg-black/45 p-0 text-white backdrop-blur-xl hover:bg-black/60"
                variant="outline"
                size="sm"
                onClick={openInvitePanel}
                disabled={!inviteMeta}
                aria-label="Показать QR-код и варианты отправки"
                title="QR-код и варианты отправки"
              >
                <QrCode className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {errorMessage ? (
            <div
              className="absolute left-1/2 top-20 z-20 w-[min(92%,54rem)] -translate-x-1/2 rounded-[22px] border border-rose-400/35 bg-rose-500/15 px-4 py-3 text-sm font-medium leading-6 text-rose-50 backdrop-blur-xl sm:top-24"
              data-testid="session-error"
            >
              {errorMessage}
            </div>
          ) : null}

          {!errorMessage && statusNote ? (
            <div
              className="absolute left-1/2 top-20 z-20 w-[min(92%,54rem)] -translate-x-1/2 rounded-[22px] border border-sky-300/35 bg-sky-500/15 px-4 py-3 text-sm font-medium leading-6 text-sky-50 backdrop-blur-xl sm:top-24"
              data-testid="session-note"
            >
              {statusNote}
            </div>
          ) : null}

          {!isInvitePanelVisible && inviteActionFeedback ? (
            <div
              className={cn(
                "absolute right-3 top-16 z-20 w-[min(92vw,24rem)] rounded-[22px] px-4 py-3 text-sm font-medium leading-6 backdrop-blur-xl sm:right-4 sm:top-20",
                inviteActionFeedback.tone === "success"
                  ? "border border-emerald-400/25 bg-emerald-500/15 text-emerald-50"
                  : inviteActionFeedback.tone === "info"
                    ? "border border-sky-300/35 bg-sky-500/15 text-sky-50"
                    : "border border-rose-400/30 bg-rose-500/15 text-rose-50",
              )}
              data-testid="invite-feedback-toast"
            >
              <div className="flex items-start gap-3">
                {inviteActionFeedback.tone === "success" ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0" />
                ) : inviteActionFeedback.tone === "info" ? (
                  <Share2 className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                )}
                <span>{inviteActionFeedback.message}</span>
              </div>
            </div>
          ) : null}

          {remoteConnected && (!remoteMediaState.audioEnabled || !remoteMediaState.videoEnabled) ? (
            <div className="absolute bottom-24 left-3 z-20 flex flex-wrap gap-2 sm:left-6 sm:bottom-6">
              {!remoteMediaState.audioEnabled ? (
                <span
                  className="rounded-full border border-white/10 bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-xl"
                  data-testid="remote-audio-muted"
                >
                  У собеседника выключен микрофон
                </span>
              ) : null}
              {!remoteMediaState.videoEnabled ? (
                <span className="rounded-full border border-white/10 bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-xl">
                  Собеседник скрыл видео
                </span>
              ) : null}
            </div>
          ) : null}

          {isLocalPreviewVisible ? (
            <div
              className="absolute bottom-24 right-3 z-20 overflow-hidden rounded-[24px] border border-white/10 bg-slate-900/80 shadow-2xl backdrop-blur-xl sm:right-6 sm:bottom-24"
              style={{ width: "clamp(120px, 22vw, 260px)" }}
            >
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                data-testid="local-video"
                className="aspect-video w-full object-cover [transform:scaleX(-1)]"
              />
              {!localMediaState.videoEnabled ? (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/75 px-4 text-center text-xs font-semibold text-white sm:text-sm">
                  Камера выключена
                </div>
              ) : null}

              <div className="absolute left-3 top-3">
                <span className="rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white backdrop-blur-xl">
                  Вы
                </span>
              </div>

              <Button
                className="absolute right-3 top-3 h-8 w-8 border border-white/10 bg-black/45 p-0 text-white backdrop-blur-xl hover:bg-black/60"
                variant="outline"
                size="sm"
                onClick={() => setIsLocalPreviewVisible(false)}
                aria-label="Скрыть собственное видео"
                title="Скрыть собственное видео"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <Button
              className="absolute bottom-24 right-3 z-20 gap-2 border border-white/10 bg-black/45 px-4 text-white backdrop-blur-xl hover:bg-black/60 sm:right-6"
              variant="outline"
              size="sm"
              onClick={() => setIsLocalPreviewVisible(true)}
            >
              <Eye className="h-4 w-4" />
              <span className="hidden sm:inline">Показать себя</span>
              <span className="sm:hidden">Вы</span>
            </Button>
          )}

          {isSettingsVisible ? (
            <Card className="absolute bottom-24 left-1/2 z-20 w-[min(92vw,760px)] -translate-x-1/2 rounded-[28px] border border-white/10 bg-slate-950/80 text-white backdrop-blur-2xl">
              <CardContent className="space-y-5 p-4 pt-4 sm:p-5 sm:pt-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-white">Устройства</p>
                    <p className="text-xs leading-5 text-slate-300">
                      Можно поменять камеру, микрофон и устройство вывода звука, не выходя из звонка.
                    </p>
                  </div>
                  <Button
                    className="h-8 w-8 border border-white/10 bg-black/35 p-0 text-white hover:bg-black/55"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsSettingsVisible(false)}
                    aria-label="Закрыть настройки"
                    title="Закрыть настройки"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label className="text-slate-200" htmlFor="camera-select">
                      Камера
                    </Label>
                    <Select
                      id="camera-select"
                      className="border-white/10 bg-white/95"
                      value={selectedVideoDeviceId}
                      onChange={handleVideoDeviceChange}
                      disabled={devices.videoInputs.length === 0}
                    >
                      {devices.videoInputs.length > 0 ? (
                        devices.videoInputs.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Камера ${index + 1}`}
                          </option>
                        ))
                      ) : (
                        <option value="">Нет доступных камер</option>
                      )}
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-slate-200" htmlFor="microphone-select">
                      Микрофон
                    </Label>
                    <Select
                      id="microphone-select"
                      className="border-white/10 bg-white/95"
                      value={selectedAudioDeviceId}
                      onChange={handleAudioDeviceChange}
                      disabled={devices.audioInputs.length === 0}
                    >
                      {devices.audioInputs.length > 0 ? (
                        devices.audioInputs.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Микрофон ${index + 1}`}
                          </option>
                        ))
                      ) : (
                        <option value="">Нет доступных микрофонов</option>
                      )}
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-slate-200" htmlFor="speaker-select">
                      Куда выводить звук
                    </Label>
                    <Select
                      id="speaker-select"
                      className="border-white/10 bg-white/95"
                      value={selectedAudioOutputId}
                      onChange={handleAudioOutputChange}
                      disabled={!supportsAudioOutputSelection || devices.audioOutputs.length === 0}
                    >
                      {devices.audioOutputs.length > 0 ? (
                        devices.audioOutputs.map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Выход ${index + 1}`}
                          </option>
                        ))
                      ) : (
                        <option value="">Устройство по умолчанию</option>
                      )}
                    </Select>
                  </div>
                </div>

                <p className="text-xs leading-5 text-slate-300">
                  {supportsAudioOutputSelection
                    ? "Если браузер разрешает переключение, голос собеседника пойдет на выбранное устройство."
                    : "Если переключение здесь не сработает, звук останется на устройстве, выбранном в системе."}
                </p>

                {supportMode ? (
                  <div className="rounded-[24px] border border-amber-300/20 bg-amber-400/10 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-200">Режим помощи</p>
                    <div className="mt-3 grid gap-2 text-sm leading-6 text-slate-100 sm:grid-cols-3">
                      <p>Код звонка: {sessionLabel}</p>
                      <p>Как вы вошли: {role ? roleCopy[role] : "Определяем"}</p>
                      <p>Путь связи: {connectionPathCopy[connectionPath]}</p>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-slate-300">
                      Этот блок нужен для поддержки и скрыт в обычном режиме.
                    </p>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {isInvitePanelVisible && inviteMeta ? (
            <div className="fixed inset-0 z-40 flex items-start justify-center bg-slate-950/78 p-4 pt-20 backdrop-blur-sm sm:pt-24">
              <div
                className="absolute inset-0"
                onClick={closeInvitePanel}
                aria-hidden="true"
              />

              <div
                ref={inviteDialogRef}
                className="relative z-10 w-full max-w-5xl"
                role="dialog"
                aria-modal="true"
                aria-labelledby="invite-dialog-title"
                aria-describedby="invite-dialog-description"
                tabIndex={-1}
              >
                <Card className="max-h-[calc(100vh-6rem)] overflow-auto rounded-[30px] border border-white/10 bg-slate-950/92 text-white shadow-[0_40px_120px_rgba(2,6,23,0.7)]">
                  <CardContent className="grid gap-5 p-4 pt-4 sm:p-5 sm:pt-5 lg:grid-cols-[minmax(0,1.08fr)_minmax(280px,0.92fr)]">
                  <div className="space-y-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-white" id="invite-dialog-title">
                          Отправить приглашение
                        </p>
                        <p className="max-w-xl text-xs leading-5 text-slate-300" id="invite-dialog-description">
                          Выберите быстрый канал или скопируйте готовый текст. Получатель увидит нормальное приглашение,
                          а не голую ссылку.
                        </p>
                      </div>
                      <Button
                        className="h-8 w-8 border border-white/10 bg-black/35 p-0 text-white hover:bg-black/55"
                        variant="outline"
                        size="sm"
                        onClick={closeInvitePanel}
                        aria-label="Закрыть панель приглашения"
                        title="Закрыть панель приглашения"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>

                    <div className="rounded-[28px] border border-sky-400/15 bg-sky-400/10 p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-200">Текст приглашения</p>
                      <p className="mt-3 text-sm leading-6 text-slate-100">{inviteMeta.text}</p>
                      <p className="mt-3 rounded-[20px] border border-white/10 bg-black/25 px-4 py-3 text-xs leading-6 text-slate-300">
                        {inviteMeta.shareUrl}
                      </p>
                    </div>

                    {inviteActionFeedback ? (
                      <div
                        className={cn(
                          "flex items-start gap-3 rounded-[24px] px-4 py-3 text-sm font-medium leading-6",
                          inviteActionFeedback.tone === "success"
                            ? "border border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
                            : inviteActionFeedback.tone === "info"
                              ? "border border-sky-300/35 bg-sky-500/10 text-sky-100"
                              : "border border-rose-400/25 bg-rose-500/10 text-rose-100",
                        )}
                      >
                        {inviteActionFeedback.tone === "success" ? (
                          <Check className="mt-0.5 h-4 w-4 shrink-0" />
                        ) : inviteActionFeedback.tone === "info" ? (
                          <Share2 className="mt-0.5 h-4 w-4 shrink-0" />
                        ) : (
                          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                        )}
                        <span>{inviteActionFeedback.message}</span>
                      </div>
                    ) : (
                      <div className="rounded-[24px] border border-white/10 bg-white/5 px-4 py-3 text-sm leading-6 text-slate-300">
                        Можно отправить системным шарингом, через мессенджер, по SMS или показать QR-код на втором устройстве.
                      </div>
                    )}

                    {nativeShareAvailable ? (
                      <Button className="w-full gap-2" onClick={() => void handleNativeShareFromPanel()}>
                        <Share2 className="h-4 w-4" />
                        Открыть системное меню отправки
                      </Button>
                    ) : null}

                    <div className="grid gap-3 sm:grid-cols-2">
                      {inviteActions.map((action) => (
                        action.href ? (
                          <a
                            key={action.label}
                            className="group rounded-[26px] border border-white/10 bg-white/6 p-4 transition hover:border-white/20 hover:bg-white/10"
                            href={action.href}
                            target={action.external ? "_blank" : undefined}
                            rel={action.external ? "noreferrer" : undefined}
                          >
                            <div className="flex items-start gap-3">
                              <div
                                className={cn(
                                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10",
                                  action.accentClassName,
                                )}
                              >
                                <action.icon className="h-5 w-5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-sm font-semibold text-white">{action.label}</p>
                                  {action.external ? (
                                    <ExternalLink className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:text-slate-300" />
                                  ) : null}
                                </div>
                                <p className="mt-1 text-xs leading-5 text-slate-300">{action.description}</p>
                              </div>
                            </div>
                          </a>
                        ) : (
                          <button
                            key={action.label}
                            className="group rounded-[26px] border border-white/10 bg-white/6 p-4 text-left transition hover:border-white/20 hover:bg-white/10"
                            type="button"
                            onClick={action.onClick}
                          >
                            <div className="flex items-start gap-3">
                              <div
                                className={cn(
                                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10",
                                  action.accentClassName,
                                )}
                              >
                                <action.icon className="h-5 w-5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-white">{action.label}</p>
                                <p className="mt-1 text-xs leading-5 text-slate-300">{action.description}</p>
                              </div>
                            </div>
                          </button>
                        )
                      ))}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <Button className="gap-2" variant="outline" onClick={() => void handleCopyInviteText()}>
                        <Copy className="h-4 w-4" />
                        Скопировать текст
                      </Button>
                      <Button className="gap-2" variant="outline" onClick={() => void handleCopyInviteLink()}>
                        <Link2 className="h-4 w-4" />
                        Скопировать ссылку
                      </Button>
                    </div>
                  </div>

                    <div className="space-y-4">
                      <div className="rounded-[30px] border border-white/10 bg-white/95 p-4 text-slate-950 shadow-[0_24px_70px_-42px_rgba(15,23,42,0.55)]">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">QR для второго устройства</p>
                          <p className="mt-2 text-sm leading-6 text-slate-600">
                            Покажите этот экран рядом со вторым телефоном или планшетом, чтобы подключиться без ручного ввода ссылки.
                          </p>
                        </div>
                        <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                          без ввода ссылки
                        </span>
                      </div>

                      <div className="mt-4 rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
                        {inviteQrCodeUrl ? (
                          <img
                            src={inviteQrCodeUrl}
                            alt="QR-код приглашения на видеозвонок"
                            className="mx-auto aspect-square w-full max-w-[260px] rounded-[20px]"
                          />
                        ) : inviteQrCodeError ? (
                          <div className="flex min-h-[260px] items-center justify-center rounded-[20px] bg-slate-100 px-6 text-center text-sm leading-6 text-slate-600">
                            {inviteQrCodeError}
                          </div>
                        ) : (
                          <div className="flex min-h-[260px] items-center justify-center rounded-[20px] bg-slate-100">
                            <LoaderCircle className="h-8 w-8 animate-spin text-slate-400" />
                          </div>
                        )}
                      </div>

                      <p className="mt-4 text-xs leading-5 text-slate-500">
                        Если QR неудобен, ниже остается та же ссылка для ручного открытия в браузере.
                      </p>
                      <p className="mt-3 break-all rounded-[20px] bg-slate-100 px-4 py-3 text-xs leading-6 text-slate-700">
                        {inviteMeta.shareUrl}
                      </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : null}

          <div className="absolute inset-x-0 bottom-0 z-20 flex justify-center p-3 sm:p-4 md:p-5">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/50 p-2 shadow-2xl backdrop-blur-2xl">
              <Button
                className={cn(
                  "h-12 w-12 p-0",
                  localMediaState.audioEnabled
                    ? "bg-white text-slate-950 hover:bg-slate-100"
                    : "border border-white/10 bg-black/35 text-white hover:bg-black/55",
                )}
                variant={localMediaState.audioEnabled ? "secondary" : "outline"}
                onClick={handleToggleAudio}
                disabled={Boolean(mediaAccessIssue)}
                aria-label={localMediaState.audioEnabled ? "Выключить микрофон" : "Включить микрофон"}
                title={localMediaState.audioEnabled ? "Выключить микрофон" : "Включить микрофон"}
              >
                {localMediaState.audioEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
              </Button>

              <Button
                className={cn(
                  "h-12 w-12 p-0",
                  localMediaState.videoEnabled
                    ? "bg-white text-slate-950 hover:bg-slate-100"
                    : "border border-white/10 bg-black/35 text-white hover:bg-black/55",
                )}
                variant={localMediaState.videoEnabled ? "secondary" : "outline"}
                onClick={handleToggleVideo}
                disabled={Boolean(mediaAccessIssue)}
                aria-label={localMediaState.videoEnabled ? "Выключить камеру" : "Включить камеру"}
                title={localMediaState.videoEnabled ? "Выключить камеру" : "Включить камеру"}
              >
                {localMediaState.videoEnabled ? <Camera className="h-5 w-5" /> : <CameraOff className="h-5 w-5" />}
              </Button>

              <Button
                className={cn(
                  "h-12 w-12 p-0",
                  isSettingsVisible
                    ? "bg-orange-500 text-white hover:bg-orange-600"
                    : "border border-white/10 bg-black/35 text-white hover:bg-black/55",
                )}
                variant={isSettingsVisible ? "default" : "outline"}
                onClick={() => setIsSettingsVisible((current) => !current)}
                disabled={Boolean(mediaAccessIssue)}
                aria-label={isSettingsVisible ? "Закрыть настройки" : "Показать настройки"}
                title={isSettingsVisible ? "Закрыть настройки" : "Показать настройки"}
              >
                <Settings2 className="h-5 w-5" />
              </Button>

              <Button
                className="h-12 w-12 bg-rose-500 p-0 text-white hover:bg-rose-600"
                variant="destructive"
                onClick={handleLeaveSession}
                aria-label="Выйти из звонка"
                title="Выйти из звонка"
              >
                <PhoneOff className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

function toRtcIceServer(server: IceServerConfig): RTCIceServer {
  return {
    urls: server.urls,
    username: server.username ?? undefined,
    credential: server.credential ?? undefined,
  }
}
