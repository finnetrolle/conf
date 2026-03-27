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
import org.slf4j.LoggerFactory
import java.security.SecureRandom
import java.time.Clock
import java.time.Instant
import java.util.Base64

class SessionRegistry private constructor(
    private val config: AppConfig,
    private val clock: Clock,
    private val sessionStore: SessionStateStore,
) {
    private val logger = LoggerFactory.getLogger(SessionRegistry::class.java)
    private val mutex = Mutex()
    private val sessions = linkedMapOf<String, SessionRecord>()
    private val random = SecureRandom()

    constructor(
        config: AppConfig,
        clock: Clock = Clock.systemUTC(),
    ) : this(
        config = config,
        clock = clock,
        sessionStore = SessionStateStore.fromConfig(config),
    )

    internal companion object {
        fun withStore(
            config: AppConfig,
            clock: Clock = Clock.systemUTC(),
            sessionStore: SessionStateStore,
        ): SessionRegistry = SessionRegistry(
            config = config,
            clock = clock,
            sessionStore = sessionStore,
        )
    }

    init {
        restorePersistedSessions()
    }

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
        persistLocked()
        logger.info(
            "Created session {} with publicAppUrl={} activeSessions={}",
            sessionId,
            normalizedPublicAppUrl,
            sessions.size,
        )

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
                role == null -> "Ссылка для входа больше не подходит. Попросите отправить приглашение еще раз."
                session.status == SessionStatus.ENDED ->
                    "Этот звонок уже завершен. Попросите отправить новую ссылку."
                session.status == SessionStatus.EXPIRED ->
                    "Это приглашение устарело. Попросите отправить новую ссылку."
                !session.canAccept(role) -> "В звонке уже два человека. Дождитесь, пока кто-то выйдет, или начните новый звонок."
                else -> null
            }

            SessionInfoResponse(
                sessionId = sessionId,
                status = session.status,
                role = role,
                canJoin = canJoin,
                activeParticipants = session.activeParticipantCount(),
                maxParticipants = 2,
                shareUrl = session.shareUrl.takeIf { role != null && !session.isTerminal() },
                message = message,
            )
        }

    internal suspend fun join(
        sessionId: String,
        joinToken: String,
        socket: DefaultWebSocketServerSession,
        resumeRequested: Boolean = false,
    ): JoinResult {
        val joinResult = mutex.withLock {
            val session = sessions[sessionId]
                ?: return@withLock JoinResult.Failure("session_not_found", "Такой звонок не найден. Проверьте ссылку или попросите новое приглашение.").also {
                    logger.warn("Join rejected: session {} was not found", sessionId)
                }

            if (session.status == SessionStatus.ENDED) {
                return@withLock JoinResult.Failure("session_ended", "Этот звонок уже завершен. Попросите отправить новую ссылку.").also {
                    logger.warn("Join rejected: session {} already ended with status={}", sessionId, session.status)
                }
            }
            if (session.status == SessionStatus.EXPIRED) {
                return@withLock JoinResult.Failure("session_expired", "Это приглашение устарело. Попросите отправить новую ссылку.").also {
                    logger.warn("Join rejected: session {} already expired", sessionId)
                }
            }

            val role = roleForToken(session, joinToken)
                ?: return@withLock JoinResult.Failure("invalid_join_token", "Ссылка для входа больше не подходит. Попросите отправить приглашение еще раз.").also {
                    logger.warn("Join rejected: invalid token for session {}", sessionId)
                }
            if (!session.canAccept(role)) {
                return@withLock JoinResult.Failure("session_full", "В звонке уже два человека. Дождитесь, пока кто-то выйдет, или начните новый звонок.").also {
                    logger.warn("Join rejected: session {} is full for role={}", sessionId, role)
                }
            }

            val participant = session.participants.getValue(role)
            val previousSocket = participant.socket
            val gracefulResume = resumeRequested &&
                previousSocket == null &&
                participant.reconnectGraceUntil?.isAfter(now()) == true
            participant.socket = socket
            participant.connectedAt = now()
            participant.disconnectedAt = null
            participant.reconnectGraceUntil = null
            session.emptySince = null
            session.lastActivityAt = now()

            val peer = session.peerOf(role)
            session.status = when {
                !peer.isActive() -> SessionStatus.WAITING_FOR_PEER
                gracefulResume -> SessionStatus.ACTIVE
                else -> SessionStatus.CONNECTING
            }
            persistLocked()
            logger.info(
                "Participant joined session={} role={} activeParticipants={} status={} gracefulResume={}",
                sessionId,
                role.name.lowercase(),
                session.activeParticipantCount(),
                session.status,
                gracefulResume,
            )

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
                                put("shouldCreateOffer", role == ParticipantRole.HOST && peer.isActive() && !gracefulResume)
                                put("resumed", gracefulResume)
                                put("activeParticipants", session.activeParticipantCount())
                            },
                        ),
                    ),
                )

                if (peer.isActive() && !gracefulResume) {
                    add(
                        OutboundMessage(
                            socket = peer.socket!!,
                            message = serverMessage(
                                type = "participant.joined",
                                payload = buildJsonObject {
                                    put("participantId", participant.participantId)
                                    put("role", role.name.lowercase())
                                    put("activeParticipants", session.activeParticipantCount())
                                },
                            ),
                        ),
                    )
                }
            }

            JoinResult.Success(
                role = role,
                participantId = participant.participantId,
                shouldCreateOffer = role == ParticipantRole.HOST && peer.isActive() && !gracefulResume,
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

    internal suspend fun markDisconnected(
        sessionId: String,
        joinToken: String,
        socket: DefaultWebSocketServerSession,
    ): Instant? = mutex.withLock {
        val session = sessions[sessionId] ?: return@withLock null
        val role = roleForToken(session, joinToken) ?: return@withLock null
        val participant = session.participants.getValue(role)
        if (participant.socket != socket) {
            return@withLock null
        }

        val disconnectedAt = now()
        val reconnectGraceUntil = disconnectedAt.plus(config.signalingReconnectGrace)
        participant.socket = null
        participant.disconnectedAt = disconnectedAt
        participant.reconnectGraceUntil = reconnectGraceUntil
        session.lastActivityAt = disconnectedAt
        if (session.activeParticipantCount() == 0) {
            session.emptySince = disconnectedAt
        }
        persistLocked()
        logger.info(
            "Participant signaling disconnected session={} role={} activeParticipants={} reconnectGraceUntil={}",
            sessionId,
            role.name.lowercase(),
            session.activeParticipantCount(),
            reconnectGraceUntil,
        )

        reconnectGraceUntil
    }

    internal suspend fun finalizeDisconnect(
        sessionId: String,
        joinToken: String,
        reconnectGraceUntil: Instant,
    ) {
        val outboundMessages = mutex.withLock<List<OutboundMessage>> {
            val session = sessions[sessionId] ?: return@withLock emptyList()
            val role = roleForToken(session, joinToken) ?: return@withLock emptyList()
            val participant = session.participants.getValue(role)

            if (participant.socket != null || participant.reconnectGraceUntil != reconnectGraceUntil) {
                return@withLock emptyList()
            }

            participant.reconnectGraceUntil = null
            session.lastActivityAt = now()
            session.status = SessionStatus.WAITING_FOR_PEER
            persistLocked()

            val peer = session.peerOf(role)
            logger.info(
                "Reconnect grace expired for session={} role={} activeParticipants={} status={}",
                sessionId,
                role.name.lowercase(),
                session.activeParticipantCount(),
                session.status,
            )

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
                                    put("activeParticipants", session.activeParticipantCount())
                                },
                            ),
                        ),
                    )
                }
            }
        }

        outboundMessages.sendAll()
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
                if (session.callEstablishedAt == null) {
                    session.callEstablishedAt = now()
                }
            }
            if (type == "media.state_changed") {
                sender.audioEnabled = payload["audioEnabled"]?.toString()?.trim('"')?.toBooleanStrictOrNull() ?: sender.audioEnabled
                sender.videoEnabled = payload["videoEnabled"]?.toString()?.trim('"')?.toBooleanStrictOrNull() ?: sender.videoEnabled
            }
            if (type == "webrtc.answer" || type == "media.state_changed") {
                persistLocked()
            }

            if (!recipient.isActive()) {
                logger.info(
                    "Dropping signal type={} for session={} fromRole={} because peer is offline",
                    type,
                    sessionId,
                    senderRole.name.lowercase(),
                )
                return@withLock emptyList()
            }

            when (type) {
                "webrtc.ice_candidate" -> logger.info(
                    "Forwarding ICE candidate for session={} fromRole={} toRole={} candidateType={}",
                    sessionId,
                    senderRole.name.lowercase(),
                    recipient.role.name.lowercase(),
                    payload["candidate"]?.toString()?.let(::candidateTypeOf) ?: "unknown",
                )

                else -> logger.info(
                    "Forwarding signal type={} for session={} fromRole={} toRole={} status={}",
                    type,
                    sessionId,
                    senderRole.name.lowercase(),
                    recipient.role.name.lowercase(),
                    session.status,
                )
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
            participant.reconnectGraceUntil = null
            session.lastActivityAt = now()

            val peer = session.peerOf(role)
            session.status = SessionStatus.WAITING_FOR_PEER
            if (session.activeParticipantCount() == 0) {
                session.emptySince = now()
            }
            persistLocked()
            logger.info(
                "Participant left session={} role={} activeParticipants={} status={} emptySince={}",
                sessionId,
                role.name.lowercase(),
                session.activeParticipantCount(),
                session.status,
                session.emptySince,
            )

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
                                    put("activeParticipants", session.activeParticipantCount())
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
            if (applyLifecyclePolicy(now())) {
                persistLocked()
            }
        }
    }

    suspend fun totalSessions(): Int = mutex.withLock { sessions.size }

    private fun roleForToken(session: SessionRecord, joinToken: String?): ParticipantRole? =
        session.participants.entries.firstOrNull { it.value.joinToken == joinToken }?.key

    private fun SessionRecord.activeParticipantCount(): Int =
        participants.values.count { it.isActive() }

    private fun SessionRecord.canAccept(role: ParticipantRole): Boolean {
        if (isTerminal()) {
            return false
        }
        val participant = participants.getValue(role)
        return participant.isActive() || activeParticipantCount() < 2
    }

    private fun SessionRecord.idleGrace() =
        if (callEstablishedAt == null) config.waitingForPeerGrace else config.emptySessionGrace

    private fun SessionRecord.terminalStatus() =
        if (callEstablishedAt == null) SessionStatus.EXPIRED else SessionStatus.ENDED

    private fun SessionRecord.isTerminal(): Boolean =
        status == SessionStatus.ENDED || status == SessionStatus.EXPIRED

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

    private fun restorePersistedSessions() {
        val restoredAt = now()
        val restoredSessions = sessionStore.load()
            .mapNotNull { storedSession -> storedSession.toSessionRecordOrNull(config, restoredAt, logger) }
        restoredSessions.forEach { session ->
            sessions[session.sessionId] = session
        }

        val lifecycleChanged = applyLifecyclePolicy(restoredAt)

        if (sessions.isNotEmpty()) {
            logger.info("Restored {} sessions from durable storage", sessions.size)
        }

        if (restoredSessions.isNotEmpty() || lifecycleChanged) {
            persistLocked()
        }
    }

    private fun persistLocked() {
        sessionStore.save(sessions.values.map(SessionRecord::toStoredSnapshot))
    }

    private fun applyLifecyclePolicy(referenceTime: Instant): Boolean {
        val iterator = sessions.iterator()
        var changed = false
        while (iterator.hasNext()) {
            val (_, session) = iterator.next()

            if (session.isTerminal()) {
                if (session.endedAt == null) {
                    session.endedAt = referenceTime
                    changed = true
                }

                if (referenceTime.isAfter(session.endedAt!!.plus(config.endedSessionRetention))) {
                    logger.info("Removing retained session {} with status={}", session.sessionId, session.status)
                    iterator.remove()
                    changed = true
                }
                continue
            }

            if (session.activeParticipantCount() > 0) {
                continue
            }

            val sessionExpired = referenceTime.isAfter(session.createdAt.plus(config.sessionMaxAge))
            val idleDeadline = session.emptySince?.plus(session.idleGrace())
            val idleTooLong = idleDeadline?.let(referenceTime::isAfter) ?: false
            if (sessionExpired || idleTooLong) {
                session.status = session.terminalStatus()
                session.endedAt = referenceTime
                session.lastActivityAt = referenceTime
                session.participants.values.forEach { participant ->
                    participant.reconnectGraceUntil = null
                }
                changed = true
                logger.info(
                    "Marked session {} as {} sessionExpired={} idleTooLong={} callEstablished={}",
                    session.sessionId,
                    session.status,
                    sessionExpired,
                    idleTooLong,
                    session.callEstablishedAt != null,
                )
            }
        }

        return changed
    }

    private fun candidateTypeOf(candidateJson: String): String {
        val candidate = candidateJson.substringAfter("\"candidate\":\"", missingDelimiterValue = candidateJson)
            .substringBefore('"')
            .replace("\\\\", "\\")
        val parts = candidate.split(' ')
        val typeIndex = parts.indexOf("typ")
        return if (typeIndex >= 0 && typeIndex + 1 < parts.size) parts[typeIndex + 1] else "unknown"
    }
}

private suspend fun List<OutboundMessage>.sendAll() {
    forEach { outbound ->
        outbound.socket.send(JsonSupport.json.encodeToString(ServerWsMessage.serializer(), outbound.message))
    }
}
