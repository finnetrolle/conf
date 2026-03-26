import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8080"
const wsUrl = process.env.SMOKE_WS_URL ?? "ws://127.0.0.1:8080/ws"
const requestTimeoutMs = 5_000

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
}

async function waitForHealth(timeoutMs = 30_000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/health`)
      if (response.ok) {
        return
      }
    } catch {}

    await delay(500)
  }

  throw new Error(`Server at ${baseUrl} did not become healthy within ${timeoutMs}ms`)
}

function json(value) {
  return JSON.stringify(value)
}

function parseJoinToken(url) {
  return new URL(url).searchParams.get("joinToken")
}

function waitForOpen(socket, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error("WebSocket open timed out")), timeoutMs)

    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeoutId)
        resolve()
      },
      { once: true },
    )

    socket.addEventListener(
      "error",
      (event) => {
        clearTimeout(timeoutId)
        reject(new Error(`WebSocket open failed: ${event.type}`))
      },
      { once: true },
    )
  })
}

function nextMessage(socket, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), timeoutMs)

    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeoutId)
        resolve(JSON.parse(String(event.data)))
      },
      { once: true },
    )

    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timeoutId)
        reject(new Error("WebSocket closed before receiving message"))
      },
      { once: true },
    )
  })
}

async function main() {
  console.log(`waiting for health at ${baseUrl}`)
  await waitForHealth()
  console.log("health endpoint is ready")

  const createResponse = await fetchWithTimeout(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  })
  assert.equal(createResponse.status, 201, "create session should return 201")
  const created = await createResponse.json()
  console.log(`created session ${created.sessionId}`)

  assert.ok(created.sessionId)
  assert.ok(created.hostJoinToken)
  assert.ok(created.shareUrl)

  const guestJoinToken = parseJoinToken(created.shareUrl)
  assert.ok(guestJoinToken, "shareUrl should include joinToken")

  const invalidInfoResponse = await fetchWithTimeout(`${baseUrl}/api/sessions/${created.sessionId}?joinToken=bad-token`)
  assert.equal(invalidInfoResponse.status, 200)
  const invalidInfo = await invalidInfoResponse.json()
  assert.equal(invalidInfo.shareUrl, null, "shareUrl must not leak for invalid token")
  assert.equal(invalidInfo.canJoin, false)

  const hostInfoResponse = await fetchWithTimeout(
    `${baseUrl}/api/sessions/${created.sessionId}?joinToken=${encodeURIComponent(created.hostJoinToken)}`,
  )
  assert.equal(hostInfoResponse.status, 200)
  const hostInfo = await hostInfoResponse.json()
  assert.equal(hostInfo.role, "host")
  assert.ok(hostInfo.shareUrl)

  const invalidIceResponse = await fetchWithTimeout(
    `${baseUrl}/api/ice-servers?sessionId=${created.sessionId}&joinToken=bad-token`,
  )
  assert.equal(invalidIceResponse.status, 403, "ICE endpoint should reject invalid token")

  const iceResponse = await fetchWithTimeout(
    `${baseUrl}/api/ice-servers?sessionId=${created.sessionId}&joinToken=${encodeURIComponent(created.hostJoinToken)}`,
  )
  assert.equal(iceResponse.status, 200, "ICE endpoint should allow valid token")
  const ice = await iceResponse.json()
  assert.ok(Array.isArray(ice.iceServers) && ice.iceServers.length >= 1)
  const turnServer = ice.iceServers.find((server) => server.urls.some((url) => String(url).startsWith("turn:")))
  assert.ok(turnServer, "TURN server should be present")
  assert.ok(turnServer.username, "TURN server should include username")
  assert.ok(turnServer.credential, "TURN server should include credential")
  console.log("validated session info and ICE config")

  const hostSocket = new WebSocket(wsUrl)
  await waitForOpen(hostSocket)
  console.log("host websocket connected")
  hostSocket.send(
    json({
      type: "session.join",
      payload: {
        sessionId: created.sessionId,
        joinToken: created.hostJoinToken,
      },
    }),
  )

  const hostReady = await nextMessage(hostSocket)
  assert.equal(hostReady.type, "session.ready")
  assert.equal(hostReady.payload.role, "host")
  assert.equal(hostReady.payload.peerPresent, false)

  const guestSocket = new WebSocket(wsUrl)
  await waitForOpen(guestSocket)
  console.log("guest websocket connected")
  guestSocket.send(
    json({
      type: "session.join",
      payload: {
        sessionId: created.sessionId,
        joinToken: guestJoinToken,
      },
    }),
  )

  const guestReady = await nextMessage(guestSocket)
  assert.equal(guestReady.type, "session.ready")
  assert.equal(guestReady.payload.role, "guest")

  const participantJoined = await nextMessage(hostSocket)
  assert.equal(participantJoined.type, "participant.joined")
  assert.equal(participantJoined.payload.role, "guest")
  console.log("host and guest joined session")

  hostSocket.send(
    json({
      type: "webrtc.offer",
      payload: { sdp: "test-offer" },
    }),
  )
  const forwardedOffer = await nextMessage(guestSocket)
  assert.equal(forwardedOffer.type, "webrtc.offer")
  assert.equal(forwardedOffer.payload.sdp, "test-offer")
  assert.equal(forwardedOffer.payload.fromRole, "host")
  console.log("offer forwarding works")

  guestSocket.send(
    json({
      type: "media.state_changed",
      payload: { audioEnabled: false, videoEnabled: true },
    }),
  )
  const mediaState = await nextMessage(hostSocket)
  assert.equal(mediaState.type, "media.state_changed")
  assert.equal(mediaState.payload.audioEnabled, false)
  assert.equal(mediaState.payload.videoEnabled, true)
  assert.equal(mediaState.payload.fromRole, "guest")
  console.log("media state forwarding works")

  guestSocket.send(
    json({
      type: "session.leave",
      payload: { sessionId: created.sessionId },
    }),
  )
  const participantLeft = await nextMessage(hostSocket)
  assert.equal(participantLeft.type, "participant.left")
  assert.equal(participantLeft.payload.role, "guest")
  console.log("leave flow works")

  hostSocket.send(
    json({
      type: "session.leave",
      payload: { sessionId: created.sessionId },
    }),
  )

  await delay(100)
  hostSocket.close()
  guestSocket.close()
  console.log("backend smoke test passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
