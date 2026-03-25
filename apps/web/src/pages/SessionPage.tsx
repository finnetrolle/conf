import { Camera, CameraOff, Copy, Eye, LoaderCircle, Mic, MicOff, PhoneOff, Settings2, X } from "lucide-react"
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

const defaultMediaState: MediaState = { audioEnabled: true, videoEnabled: true }

const stageCopy: Record<ConnectionStage, { label: string; badge: "amber" | "blue" | "green" | "rose" | "slate" }> = {
  loading: { label: "Загружаем сессию", badge: "slate" },
  preparing: { label: "Готовим камеру и микрофон", badge: "blue" },
  waiting: { label: "Ждем второго участника", badge: "amber" },
  connecting: { label: "Соединяем браузеры", badge: "blue" },
  connected: { label: "Соединение активно", badge: "green" },
  ended: { label: "Сессия завершена", badge: "slate" },
  failed: { label: "Нужно вмешательство", badge: "rose" },
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
    const secureUrl = `https://${window.location.host}${window.location.pathname}${window.location.search}`
    return `Страница открыта по небезопасному адресу ${window.location.origin}. На других устройствах браузер разрешает камеру и микрофон только по HTTPS или на localhost. Открой ${secureUrl} и подтверди локальный сертификат браузера.`
  }

  if (!navigator.mediaDevices) {
    return "В этом окружении браузер не предоставляет Web Media API. Обычно это происходит из-за HTTP вместо HTTPS или из-за ограничений самого браузера."
  }

  if (typeof navigator.mediaDevices.getUserMedia !== "function") {
    return "Браузер не поддерживает getUserMedia в текущем окружении. Обычно это происходит из-за HTTP вместо HTTPS."
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

export function SessionPage() {
  const navigate = useNavigate()
  const { sessionId } = useParams<{ sessionId: string }>()
  const location = useLocation()
  const joinToken = useMemo(() => new URLSearchParams(location.search).get("joinToken") ?? "", [location.search])

  const [sessionInfo, setSessionInfo] = useState<SessionInfoResponse | null>(null)
  const [connectionStage, setConnectionStage] = useState<ConnectionStage>("loading")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [copyLabel, setCopyLabel] = useState("Ссылка на сессию")
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

    try {
      await videoElement.setSinkId(deviceId)
    } catch (error) {
      setErrorMessage(humanizeError(error))
    }
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
    })

    remoteStreamRef.current = new MediaStream()
    attachRemoteStream(remoteStreamRef.current)

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
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
    }

    peerConnection.onconnectionstatechange = () => {
      switch (peerConnection.connectionState) {
        case "connecting":
          setConnectionStage("connecting")
          break
        case "connected":
          setConnectionStage("connected")
          setRemoteConnected(true)
          break
        case "disconnected":
          setConnectionStage("connecting")
          setRemoteConnected(false)
          break
        case "failed":
          setConnectionStage("failed")
          setErrorMessage("WebRTC-соединение не удалось стабилизировать. Попробуйте открыть ссылку заново.")
          break
        default:
          break
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
    const peerConnection = await ensurePeerConnection()
    if (peerConnection.signalingState !== "stable") {
      return
    }

    setConnectionStage("connecting")
    const offer = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offer)
    sendSocketMessage("webrtc.offer", { sdp: offer.sdp })
  }

  async function handleIncomingOffer(payload: Record<string, unknown>) {
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

    switch (message.type) {
      case "session.ready": {
        const nextRole = String(message.payload.role) as ParticipantRole
        roleRef.current = nextRole
        setRole(nextRole)
        const shouldCreateOffer = Boolean(message.payload.shouldCreateOffer)
        const peerPresent = Boolean(message.payload.peerPresent)

        if (peerPresent) {
          setConnectionStage(shouldCreateOffer ? "connecting" : "waiting")
        } else {
          setConnectionStage("waiting")
        }

        if (shouldCreateOffer) {
          await createOffer()
        }
        break
      }
      case "participant.joined": {
        setConnectionStage("connecting")
        if (roleRef.current === "host") {
          await resetPeerConnection(true)
          await createOffer()
        }
        break
      }
      case "participant.left": {
        await resetPeerConnection(true)
        setConnectionStage("waiting")
        break
      }
      case "session.ended": {
        await resetPeerConnection(true)
        setConnectionStage("ended")
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
      case "media.state_changed": {
        setRemoteMediaState({
          audioEnabled: Boolean(message.payload.audioEnabled),
          videoEnabled: Boolean(message.payload.videoEnabled),
        })
        break
      }
      case "error": {
        const messageText = typeof message.payload.message === "string" ? message.payload.message : "Не удалось обработать signaling-событие."
        setErrorMessage(messageText)
        setConnectionStage("failed")
        break
      }
      default:
        break
    }
  }

  function openWebSocket(currentSessionId: string, currentJoinToken: string) {
    const socket = new WebSocket(getWebSocketUrl())
    webSocketRef.current = socket

    socket.onopen = () => {
      sendSocketMessage("session.join", {
        sessionId: currentSessionId,
        joinToken: currentJoinToken,
      })
    }

    socket.onmessage = (event) => {
      void handleServerMessage(event)
    }

    socket.onclose = () => {
      if (!leavingRef.current && connectionStage !== "ended") {
        setConnectionStage((current) => (current === "connected" ? "connecting" : current))
      }
    }

    socket.onerror = () => {
      setConnectionStage("failed")
      setErrorMessage("Сигналинг-сокет оборвался. Попробуйте открыть ссылку заново.")
    }
  }

  function broadcastLocalMediaState(nextState: MediaState) {
    sendSocketMessage("media.state_changed", nextState)
  }

  async function handleCopyLink() {
    if (!sessionInfoRef.current?.shareUrl) {
      return
    }

    const parsedShareUrl = new URL(sessionInfoRef.current.shareUrl, window.location.origin)
    const shareUrl = `${window.location.origin}${parsedShareUrl.pathname}${parsedShareUrl.search}`
    await navigator.clipboard.writeText(shareUrl)
    setCopyLabel("Ссылка скопирована")
    window.setTimeout(() => setCopyLabel("Ссылка на сессию"), 1600)
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
    const nextDeviceId = event.target.value
    selectedVideoDeviceIdRef.current = nextDeviceId
    setSelectedVideoDeviceId(nextDeviceId)
    await initializeLocalMedia(nextDeviceId, selectedAudioDeviceIdRef.current)
  }

  async function handleAudioDeviceChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextDeviceId = event.target.value
    selectedAudioDeviceIdRef.current = nextDeviceId
    setSelectedAudioDeviceId(nextDeviceId)
    await initializeLocalMedia(selectedVideoDeviceIdRef.current, nextDeviceId)
  }

  async function handleAudioOutputChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextDeviceId = event.target.value
    selectedAudioOutputIdRef.current = nextDeviceId
    setSelectedAudioOutputId(nextDeviceId)
    await applyAudioOutputDevice(nextDeviceId)
  }

  async function cleanupSession() {
    leavingRef.current = true
    sendSocketMessage("session.leave", { sessionId })
    webSocketRef.current?.close()
    webSocketRef.current = null
    await resetPeerConnection(true)
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    attachLocalStream(null)
  }

  async function handleLeaveSession() {
    await cleanupSession()
    navigate("/")
  }

  useEffect(() => {
    setSupportsAudioOutputSelection(typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === "function")
  }, [])

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      if (!sessionId || !joinToken) {
        setConnectionStage("failed")
        setErrorMessage("Не хватает параметров ссылки для входа в сессию.")
        return
      }

      try {
        const [session, iceServers] = await Promise.all([getSessionInfo(sessionId, joinToken), getIceServers()])
        if (cancelled) {
          return
        }

        sessionInfoRef.current = session
        setSessionInfo(session)
        setRole(session.role)
        roleRef.current = session.role
        iceServersRef.current = iceServers.iceServers.map(toRtcIceServer)

        if (!session.canJoin || !session.role) {
          setConnectionStage(session.status === "ended" || session.status === "expired" ? "ended" : "failed")
          setErrorMessage(session.message ?? "Сессия недоступна для подключения.")
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

        setConnectionStage("preparing")
        openWebSocket(sessionId, joinToken)
      } catch (error) {
        if (!cancelled) {
          setConnectionStage("failed")
          const errorText = humanizeError(error)
          setErrorMessage(
            isConstraintError(error)
              ? `Браузер отклонил параметры доступа к устройствам: ${errorText}. Я переключил код на безопасные fallback-режимы, перезагрузи страницу и попробуй снова.`
              : errorText,
          )
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
      void cleanupSession()
    }
  }, [joinToken, sessionId])

  useEffect(() => {
    if (supportsAudioOutputSelection && selectedAudioOutputId) {
      void applyAudioOutputDevice(selectedAudioOutputId)
    }
  }, [selectedAudioOutputId, supportsAudioOutputSelection])

  const stageMeta = stageCopy[connectionStage]
  const sessionLabel = sessionId ? shortSessionId(sessionId) : "unknown"
  const remoteWaitingTitle = connectionStage === "connecting" ? "Подключаем собеседника" : "Ожидаем собеседника"
  const remoteWaitingDescription =
    connectionStage === "connecting"
      ? "Браузеры уже обмениваются сигналами. Видео появится здесь сразу после установки WebRTC-соединения."
      : "Как только второй участник откроет ссылку, это окно переключится в полноэкранный режим разговора."
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
            className={cn("h-full w-full object-cover transition-opacity duration-300", !remoteConnected && "opacity-0")}
          />

          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-slate-950/55 via-transparent to-slate-950/80" />

          {!remoteConnected ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[radial-gradient(circle_at_top,rgba(14,165,233,0.22),transparent_32%),linear-gradient(180deg,#020617,#0f172a)] px-6 text-center text-white">
              <LoaderCircle className={cn("h-10 w-10", connectionStage === "connecting" && "animate-spin")} />
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
                  Соединение остается активным, поэтому вы можете продолжать разговор по аудио.
                </p>
              </div>
            </div>
          ) : null}

          <div className="absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 sm:p-4 md:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="border border-white/10 bg-black/45 text-white backdrop-blur-xl" variant={stageMeta.badge}>
                {stageMeta.label}
              </Badge>
              <span className="rounded-full border border-white/10 bg-black/45 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-100 backdrop-blur-xl">
                session {sessionLabel}
              </span>
              {role ? (
                <span className="rounded-full border border-white/10 bg-black/45 px-3 py-1 text-xs font-medium text-slate-100 backdrop-blur-xl">
                  {role === "host" ? "Создатель" : "Гость"}
                </span>
              ) : null}
            </div>

            <Button
              className="gap-2 border border-white/10 bg-black/45 px-4 text-white backdrop-blur-xl hover:bg-black/60"
              variant="outline"
              size="sm"
              onClick={handleCopyLink}
              disabled={!sessionInfo?.shareUrl}
            >
              <Copy className="h-4 w-4" />
              <span className="hidden sm:inline">{copyLabel}</span>
              <span className="sm:hidden">Ссылка</span>
            </Button>
          </div>

          {errorMessage ? (
            <div className="absolute left-1/2 top-20 z-20 w-[min(92%,54rem)] -translate-x-1/2 rounded-[22px] border border-rose-400/35 bg-rose-500/15 px-4 py-3 text-sm font-medium leading-6 text-rose-50 backdrop-blur-xl sm:top-24">
              {errorMessage}
            </div>
          ) : null}

          {remoteConnected && (!remoteMediaState.audioEnabled || !remoteMediaState.videoEnabled) ? (
            <div className="absolute bottom-24 left-3 z-20 flex flex-wrap gap-2 sm:left-6 sm:bottom-6">
              {!remoteMediaState.audioEnabled ? (
                <span className="rounded-full border border-white/10 bg-black/45 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-xl">
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
              <video ref={localVideoRef} autoPlay muted playsInline className="aspect-video w-full object-cover [transform:scaleX(-1)]" />
              {!localMediaState.videoEnabled ? (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/75 px-4 text-center text-xs font-semibold text-white sm:text-sm">
                  Камера выключена
                </div>
              ) : null}

              <div className="absolute left-3 top-3">
                <span className="rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white backdrop-blur-xl">
                  Ты
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
              <span className="sm:hidden">Ты</span>
            </Button>
          )}

          {isSettingsVisible ? (
            <Card className="absolute bottom-24 left-1/2 z-20 w-[min(92vw,760px)] -translate-x-1/2 rounded-[28px] border border-white/10 bg-slate-950/80 text-white backdrop-blur-2xl">
              <CardContent className="space-y-5 p-4 pt-4 sm:p-5 sm:pt-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-white">Устройства</p>
                    <p className="text-xs leading-5 text-slate-300">
                      Переключай камеру, микрофон и аудиовыход, не выходя из звонка.
                    </p>
                  </div>
                  <Button
                    className="h-8 w-8 border border-white/10 bg-black/35 p-0 text-white hover:bg-black/55"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsSettingsVisible(false)}
                    aria-label="Скрыть настройки"
                    title="Скрыть настройки"
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
                      Аудиовыход
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
                        <option value="">Текущий системный вывод</option>
                      )}
                    </Select>
                  </div>
                </div>

                <p className="text-xs leading-5 text-slate-300">
                  {supportsAudioOutputSelection
                    ? "Если браузер поддерживает setSinkId, выбранный выход применится к удаленному аудио."
                    : "Этот браузер не поддерживает переключение аудиовыхода через Web API."}
                </p>
              </CardContent>
            </Card>
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
                aria-label={isSettingsVisible ? "Скрыть настройки" : "Показать настройки"}
                title={isSettingsVisible ? "Скрыть настройки" : "Показать настройки"}
              >
                <Settings2 className="h-5 w-5" />
              </Button>

              <Button
                className="h-12 w-12 bg-rose-500 p-0 text-white hover:bg-rose-600"
                variant="destructive"
                onClick={handleLeaveSession}
                aria-label="Покинуть сессию"
                title="Покинуть сессию"
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
