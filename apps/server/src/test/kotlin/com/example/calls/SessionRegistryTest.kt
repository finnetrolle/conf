package com.example.calls

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import java.time.Instant

class SessionRegistryTest {
    private val clock = MutableClock(Instant.parse("2026-03-25T00:00:00Z"))
    private val config = AppConfig(
        port = 8080,
        publicAppUrl = "http://localhost:3000",
        allowedOrigins = listOf("http://localhost:3000"),
        stunUrl = "stun:stun.l.google.com:19302",
        turnUrl = "turn:localhost:3478?transport=udp",
        turnUsername = "webrtc",
        turnPassword = "webrtc-secret",
        emptySessionGrace = java.time.Duration.ofSeconds(5),
        endedSessionRetention = java.time.Duration.ofSeconds(5),
        sessionMaxAge = java.time.Duration.ofHours(24),
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
        assertEquals("Join token is invalid for this session.", sessionInfo.message)
    }

    @Test
    fun `cleanup ends and removes empty sessions after grace windows`() = runBlocking {
        val registry = SessionRegistry(config, clock)
        val created = registry.createSession()

        clock.advanceSeconds(6)
        registry.cleanup()
        val endedInfo = registry.getSessionInfo(created.sessionId, created.hostJoinToken)
        assertNotNull(endedInfo)
        assertEquals(SessionStatus.ENDED, endedInfo.status)

        clock.advanceSeconds(6)
        registry.cleanup()
        val removedInfo = registry.getSessionInfo(created.sessionId, created.hostJoinToken)
        assertEquals(null, removedInfo)
    }
}
