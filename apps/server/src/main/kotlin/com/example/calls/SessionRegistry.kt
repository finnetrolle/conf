package com.example.calls

import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.websocket.CloseReason
import io.ktor.websocket.close
import io.ktor.websocket.send
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.SecureRandom
import java.time.Clock
import java.time.Instant
import java.util.Base64

class SessionRegistry(
    private val config: AppConfig,
    private val clock: Clock = Clock.systemUTC(),
) {
    private val mutex = Mutex()
    private val sessions = linkedMapOf<String, SessionRecord>()
    private val random = SecureRandom()

    suspend fun createSession(publicAppUrl: String = config.publicAppUrl): CreateSessionResponse = mutex.withLock {
        val sessionId = randomId(prefix = "session")
        val hostJoinToken = randomToken()
        val guestJoinToken = randomToken()
        val createdAt = now()
        val normalizedPublicAppUrl = publicAppUrl.removeSuffix("/")
        val hostUrl = "$normalizedPublicAppUrl/session/$sessionId?joinToken=$hostJoinToken"
        val shareUrl = "$normalizedPublicAppUrl/session/$sessionId?joinToken=$guestJoinToken"

        val session = SessionRecord(
            sessionId = sessionId,
            createdAt = createdAt,
            hostUrl = hostUrl,
            shareUrl = shareUrl,
            participants = mutableMapOf(
                ParticipantRole.HOST to ParticipantRecord(
                    participantId = randomId("participant"),
                    role = ParticipantRole.HOST,
                    joinToken = hostJoinToken,
                ),
                ParticipantRole.GUEST to ParticipantRecord(
                    participantId = randomId("participant"),
                    role = ParticipantRole.GUEST,
                    joinToken = guestJoinToken,
                ),
            ),
            status = SessionStatus.WAITING_FOR_PEER,
            lastActivityAt = createdAt,
            emptySince = createdAt,
        )

        sessions[sessionId] = session

        CreateSessionResponse(
            sessionId = sessionId,
            status = session.status,
            hostUrl = hostUrl,
            shareUrl = shareUrl,
            hostJoinToken = hostJoinToken,
        )
    }

    suspend fun getSessionInfo(sessionId: String, joinToken: String?): SessionInfoResponse? =
        mutex.withLock {
            val session = sessions[sessionId] ?: return@withLock null
            val role = roleForToken(session, joinToken)
            val canJoin = role != null && session.canAccept(role)
            val message = when {
                role == null -> "Join token is invalid for this session."
                session.status == SessionStatus.ENDED || session.status == SessionStatus.EXPIRED ->
                    "This session has already ended."
                !session.canAccept(role) -> "This session is already full."
                else -> null
            }

            SessionInfoResponse(
                sessionId = sessionId,
                status = session.status,
                role = role,
                canJoin = canJoin,
                activeParticipants = session.activeParticipantCount(),
                maxParticipants = 2,
                shareUrl = session.shareUrl,
                message = message,
            )
        }

    internal suspend fun join(
        sessionId: String,
        joinToken: String,
        socket: DefaultWebSocketServerSession,
    ): JoinResult {
        val joinResult = mutex.withLock {
            val session = sessions[sessionId]
                ?: return@withLock JoinResult.Failure("session_not_found", "Session was not found.")

            if (session.status == SessionStatus.ENDED || session.status == SessionStatus.EXPIRED) {
                return@withLock JoinResult.Failure("session_ended", "Session has already ended.")
            }

            val role = roleForToken(session, joinToken)
                ?: return@withLock JoinResult.Failure("invalid_join_token", "Join token is invalid for this session.")
            if (!session.canAccept(role)) {
                return@withLock JoinResult.Failure("session_full", "Session is already full.")
            }

            val participant = session.participants.getValue(role)
            val previousSocket = participant.socket
            participant.socket = socket
            participant.connectedAt = now()
            participant.disconnectedAt = null
            session.emptySince = null
            session.lastActivityAt = now()

            val peer = session.peerOf(role)
            session.status = if (peer.isActive()) SessionStatus.CONNECTING else SessionStatus.WAITING_FOR_PEER

            val outbound = buildList {
                add(
                    OutboundMessage(
                        socket = socket,
                        message = serverMessage(
                            type = "session.ready",
                            payload = buildJsonObject {
                                put("sessionId", sessionId)
                                put("participantId", participant.participantId)
                                put("role", role.name.lowercase())
                                put("peerPresent", peer.isActive())
                                put("shouldCreateOffer", role == ParticipantRole.HOST && peer.isActive())
                                put("activeParticipants", session.activeParticipantCount())
                            },
                        ),
                    ),
                )

                if (peer.isActive()) {
                    add(
                        OutboundMessage(
                            socket = peer.socket!!,
                            message = serverMessage(
                                type = "participant.joined",
                                payload = buildJsonObject {
                                    put("participantId", participant.participantId)
                                    put("role", role.name.lowercase())
                                },
                            ),
                        ),
                    )
                }
            }

            JoinResult.Success(
                role = role,
                participantId = participant.participantId,
                shouldCreateOffer = role == ParticipantRole.HOST && peer.isActive(),
                outboundMessages = outbound,
                previousSocket = previousSocket?.takeIf { it != socket },
            )
        }

        if (joinResult is JoinResult.Success) {
            joinResult.outboundMessages.sendAll()
            joinResult.previousSocket?.close(
                CloseReason(
                    CloseReason.Codes.NORMAL,
                    "Socket replaced by a newer connection.",
                ),
            )
        }

        return joinResult
    }

    internal suspend fun forward(
        sessionId: String,
        joinToken: String,
        type: String,
        payload: JsonObject,
    ): ForwardResult {
        val outboundMessages = mutex.withLock {
            val session = sessions[sessionId] ?: return@withLock emptyList()
            val senderRole = roleForToken(session, joinToken) ?: return@withLock emptyList()
            val sender = session.participants.getValue(senderRole)
            val recipient = session.peerOf(senderRole)

            session.lastActivityAt = now()
            if (type == "webrtc.answer") {
                session.status = SessionStatus.ACTIVE
            }
            if (type == "media.state_changed") {
                sender.audioEnabled = payload["audioEnabled"]?.toString()?.trim('"')?.toBooleanStrictOrNull() ?: sender.audioEnabled
                sender.videoEnabled = payload["videoEnabled"]?.toString()?.trim('"')?.toBooleanStrictOrNull() ?: sender.videoEnabled
            }

            if (!recipient.isActive()) {
                return@withLock emptyList()
            }

            listOf(
                OutboundMessage(
                    socket = recipient.socket!!,
                    message = serverMessage(
                        type = type,
                        payload = buildJsonObject {
                            put("fromParticipantId", sender.participantId)
                            put("fromRole", sender.role.name.lowercase())
                            payload.forEach { (key, value) -> put(key, value) }
                        },
                    ),
                ),
            )
        }

        outboundMessages.sendAll()
        return ForwardResult(outboundMessages)
    }

    internal suspend fun leave(
        sessionId: String,
        joinToken: String,
        socket: DefaultWebSocketServerSession? = null,
    ) {
        val outboundMessages = mutex.withLock<List<OutboundMessage>> {
            val session = sessions[sessionId] ?: return@withLock emptyList()
            val role = roleForToken(session, joinToken) ?: return@withLock emptyList()
            val participant = session.participants.getValue(role)
            if (socket != null && participant.socket != socket) {
                return@withLock emptyList()
            }
            if (participant.socket == null) {
                return@withLock emptyList()
            }

            participant.socket = null
            participant.disconnectedAt = now()
            session.lastActivityAt = now()

            val peer = session.peerOf(role)
            session.status = SessionStatus.WAITING_FOR_PEER
            if (session.activeParticipantCount() == 0) {
                session.emptySince = now()
            }

            buildList {
                if (peer.isActive()) {
                    add(
                        OutboundMessage(
                            socket = peer.socket!!,
                            message = serverMessage(
                                type = "participant.left",
                                payload = buildJsonObject {
                                    put("participantId", participant.participantId)
                                    put("role", participant.role.name.lowercase())
                                },
                            ),
                        ),
                    )
                }
            }
        }

        outboundMessages.sendAll()
    }

    suspend fun cleanup() {
        mutex.withLock {
            val now = now()
            val iterator = sessions.iterator()
            while (iterator.hasNext()) {
                val (_, session) = iterator.next()

                if (session.endedAt != null && now.isAfter(session.endedAt!!.plus(config.endedSessionRetention))) {
                    iterator.remove()
                    continue
                }

                val sessionExpired = now.isAfter(session.createdAt.plus(config.sessionMaxAge))
                val emptyTooLong = session.emptySince?.let { now.isAfter(it.plus(config.emptySessionGrace)) } ?: false
                if ((sessionExpired || emptyTooLong) && session.activeParticipantCount() == 0) {
                    session.status = if (sessionExpired) SessionStatus.EXPIRED else SessionStatus.ENDED
                    session.endedAt = now
                }
            }
        }
    }

    suspend fun totalSessions(): Int = mutex.withLock { sessions.size }

    private fun roleForToken(session: SessionRecord, joinToken: String?): ParticipantRole? =
        session.participants.entries.firstOrNull { it.value.joinToken == joinToken }?.key

    private fun SessionRecord.activeParticipantCount(): Int =
        participants.values.count { it.isActive() }

    private fun SessionRecord.canAccept(role: ParticipantRole): Boolean {
        if (status == SessionStatus.ENDED || status == SessionStatus.EXPIRED) {
            return false
        }
        val participant = participants.getValue(role)
        return participant.isActive() || activeParticipantCount() < 2
    }

    private fun SessionRecord.peerOf(role: ParticipantRole): ParticipantRecord =
        participants.getValue(if (role == ParticipantRole.HOST) ParticipantRole.GUEST else ParticipantRole.HOST)

    private fun ParticipantRecord.isActive(): Boolean = socket != null

    private fun serverMessage(type: String, payload: JsonObject = JsonObject(emptyMap())): ServerWsMessage =
        ServerWsMessage(type = type, payload = payload)

    private fun randomId(prefix: String): String = "${prefix}_${randomToken(9)}"

    private fun randomToken(size: Int = 18): String {
        val bytes = ByteArray(size)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    private fun now(): Instant = Instant.now(clock)
}

private suspend fun List<OutboundMessage>.sendAll() {
    forEach { outbound ->
        outbound.socket.send(JsonSupport.json.encodeToString(ServerWsMessage.serializer(), outbound.message))
    }
}
