package com.example.calls

import kotlinx.coroutines.runBlocking
import java.time.Duration
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import java.time.Instant

class SessionRegistryTest {
    private val clock = MutableClock(Instant.parse("2026-03-25T00:00:00Z"))
    private val config = AppConfig(
        port = 8080,
        publicAppUrl = "http://localhost:3000",
        allowedOrigins = listOf("http://localhost:3000"),
        stunUrl = "stun:stun.l.google.com:19302",
        turnUrl = null,
        turnPort = 3478,
        turnTransport = "udp",
        turnAuthSecret = "webrtc-secret",
        turnCredentialTtl = Duration.ofMinutes(60),
        signalingReconnectGrace = Duration.ofMillis(250),
        waitingForPeerGrace = Duration.ofSeconds(5),
        emptySessionGrace = Duration.ofSeconds(5),
        endedSessionRetention = Duration.ofSeconds(5),
        sessionMaxAge = Duration.ofHours(24),
        sessionStorePath = null,
    )

    @Test
    fun `createSession returns host and share urls`() = runBlocking {
        val registry = SessionRegistry(config, clock)

        val created = registry.createSession()

        assertTrue(created.hostUrl.contains(created.sessionId))
        assertTrue(created.shareUrl.contains(created.sessionId))
        assertEquals(SessionStatus.WAITING_FOR_PEER, created.status)
    }

    @Test
    fun `getSessionInfo rejects invalid join token`() = runBlocking {
        val registry = SessionRegistry(config, clock)
        val created = registry.createSession()

        val sessionInfo = registry.getSessionInfo(created.sessionId, "bad-token")

        assertNotNull(sessionInfo)
        assertFalse(sessionInfo.canJoin)
        assertEquals("Ссылка для входа больше не подходит. Попросите отправить приглашение еще раз.", sessionInfo.message)
        assertNull(sessionInfo.shareUrl)
    }

    @Test
    fun `cleanup expires unused sessions and removes them after retention`() = runBlocking {
        val registry = SessionRegistry(config, clock)
        val created = registry.createSession()

        clock.advanceSeconds(6)
        registry.cleanup()
        val endedInfo = registry.getSessionInfo(created.sessionId, created.hostJoinToken)
        assertNotNull(endedInfo)
        assertEquals(SessionStatus.EXPIRED, endedInfo.status)

        clock.advanceSeconds(6)
        registry.cleanup()
        val removedInfo = registry.getSessionInfo(created.sessionId, created.hostJoinToken)
        assertEquals(null, removedInfo)
    }

    @Test
    fun `restored overdue invite is immediately expired before cleanup runs`() = runBlocking {
        val store = InMemorySessionStateStore(
            initialSessions = listOf(
                StoredSessionRecord(
                    sessionId = "session_expired_on_restore",
                    createdAt = "2026-03-24T23:59:50Z",
                    hostUrl = "http://localhost:3000/session/session_expired_on_restore?joinToken=host-token",
                    shareUrl = "http://localhost:3000/session/session_expired_on_restore?joinToken=guest-token",
                    participants = listOf(
                        StoredParticipantRecord(
                            participantId = "participant_host",
                            role = ParticipantRole.HOST,
                            joinToken = "host-token",
                        ),
                        StoredParticipantRecord(
                            participantId = "participant_guest",
                            role = ParticipantRole.GUEST,
                            joinToken = "guest-token",
                        ),
                    ),
                    status = SessionStatus.WAITING_FOR_PEER,
                    lastActivityAt = "2026-03-24T23:59:50Z",
                    emptySince = "2026-03-24T23:59:50Z",
                ),
            ),
        )

        val registry = SessionRegistry.withStore(config, clock, store)

        val sessionInfo = registry.getSessionInfo("session_expired_on_restore", "host-token")
        assertNotNull(sessionInfo)
        assertEquals(SessionStatus.EXPIRED, sessionInfo.status)
        assertFalse(sessionInfo.canJoin)
        assertEquals("Это приглашение устарело. Попросите отправить новую ссылку.", sessionInfo.message)
    }

    @Test
    fun `cleanup expires a session that never reached webrtc answer`() = runBlocking {
        val store = InMemorySessionStateStore(
            initialSessions = listOf(
                StoredSessionRecord(
                    sessionId = "session_connecting_only",
                    createdAt = "2026-03-24T23:59:50Z",
                    hostUrl = "http://localhost:3000/session/session_connecting_only?joinToken=host-token",
                    shareUrl = "http://localhost:3000/session/session_connecting_only?joinToken=guest-token",
                    participants = listOf(
                        StoredParticipantRecord(
                            participantId = "participant_host",
                            role = ParticipantRole.HOST,
                            joinToken = "host-token",
                            connectedAt = "2026-03-24T23:59:53Z",
                            disconnectedAt = "2026-03-24T23:59:59Z",
                        ),
                        StoredParticipantRecord(
                            participantId = "participant_guest",
                            role = ParticipantRole.GUEST,
                            joinToken = "guest-token",
                            connectedAt = "2026-03-24T23:59:54Z",
                            disconnectedAt = "2026-03-24T23:59:59Z",
                        ),
                    ),
                    status = SessionStatus.CONNECTING,
                    lastActivityAt = "2026-03-24T23:59:59Z",
                    emptySince = "2026-03-24T23:59:59Z",
                    callEstablishedAt = null,
                ),
            ),
        )
        val registry = SessionRegistry.withStore(config, clock, store)

        clock.advanceSeconds(6)
        registry.cleanup()

        val sessionInfo = registry.getSessionInfo("session_connecting_only", "host-token")
        assertNotNull(sessionInfo)
        assertEquals(SessionStatus.EXPIRED, sessionInfo.status)
        assertFalse(sessionInfo.canJoin)
        assertEquals("Это приглашение устарело. Попросите отправить новую ссылку.", sessionInfo.message)
    }

    @Test
    fun `cleanup ends a previously established call after rejoin window`() = runBlocking {
        val store = InMemorySessionStateStore(
            initialSessions = listOf(
                StoredSessionRecord(
                    sessionId = "session_test",
                    createdAt = "2026-03-24T23:59:50Z",
                    hostUrl = "http://localhost:3000/session/session_test?joinToken=host-token",
                    shareUrl = "http://localhost:3000/session/session_test?joinToken=guest-token",
                    participants = listOf(
                        StoredParticipantRecord(
                            participantId = "participant_host",
                            role = ParticipantRole.HOST,
                            joinToken = "host-token",
                            connectedAt = "2026-03-24T23:59:53Z",
                            disconnectedAt = "2026-03-24T23:59:59Z",
                        ),
                        StoredParticipantRecord(
                            participantId = "participant_guest",
                            role = ParticipantRole.GUEST,
                            joinToken = "guest-token",
                            connectedAt = "2026-03-24T23:59:54Z",
                            disconnectedAt = "2026-03-24T23:59:59Z",
                        ),
                    ),
                    status = SessionStatus.WAITING_FOR_PEER,
                    lastActivityAt = "2026-03-24T23:59:59Z",
                    emptySince = "2026-03-24T23:59:59Z",
                    callEstablishedAt = "2026-03-24T23:59:54Z",
                ),
            ),
        )
        val registry = SessionRegistry.withStore(config, clock, store)

        clock.advanceSeconds(6)
        registry.cleanup()

        val sessionInfo = registry.getSessionInfo("session_test", "host-token")
        assertNotNull(sessionInfo)
        assertEquals(SessionStatus.ENDED, sessionInfo.status)
        assertFalse(sessionInfo.canJoin)
        assertEquals("Этот звонок уже завершен. Попросите отправить новую ссылку.", sessionInfo.message)
    }

    @Test
    fun `restores waiting session from durable store`() = runBlocking {
        val store = InMemorySessionStateStore()
        val firstRegistry = SessionRegistry.withStore(config, clock, store)
        val created = firstRegistry.createSession()

        val restoredRegistry = SessionRegistry.withStore(config, clock, store)
        val restoredInfo = restoredRegistry.getSessionInfo(created.sessionId, created.hostJoinToken)

        assertNotNull(restoredInfo)
        assertEquals(SessionStatus.WAITING_FOR_PEER, restoredInfo.status)
        assertTrue(restoredInfo.canJoin)
        assertEquals(created.shareUrl, restoredInfo.shareUrl)
    }
}
