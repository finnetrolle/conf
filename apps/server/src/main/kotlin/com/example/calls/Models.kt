package com.example.calls

import io.ktor.server.websocket.DefaultWebSocketServerSession
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import java.time.Instant

@Serializable
enum class SessionStatus {
    @SerialName("waiting_for_peer")
    WAITING_FOR_PEER,

    @SerialName("connecting")
    CONNECTING,

    @SerialName("active")
    ACTIVE,

    @SerialName("ended")
    ENDED,

    @SerialName("expired")
    EXPIRED,
}

@Serializable
enum class ParticipantRole {
    @SerialName("host")
    HOST,

    @SerialName("guest")
    GUEST,
}

@Serializable
data class CreateSessionResponse(
    val sessionId: String,
    val status: SessionStatus,
    val hostUrl: String,
    val shareUrl: String,
    val hostJoinToken: String,
)

@Serializable
data class SessionInfoResponse(
    val sessionId: String,
    val status: SessionStatus,
    val role: ParticipantRole? = null,
    val canJoin: Boolean,
    val activeParticipants: Int,
    val maxParticipants: Int,
    val shareUrl: String,
    val message: String? = null,
)

@Serializable
data class IceServersResponse(
    val iceServers: List<IceServerConfig>,
)

@Serializable
data class IceServerConfig(
    val urls: List<String>,
    val username: String? = null,
    val credential: String? = null,
)

@Serializable
data class HealthResponse(
    val status: String,
    val totalSessions: Int,
)

@Serializable
data class ClientWsMessage(
    val type: String,
    val payload: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class ServerWsMessage(
    val type: String,
    val payload: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class SessionJoinPayload(
    val sessionId: String,
    val joinToken: String,
)

@Serializable
data class SessionLeavePayload(
    val sessionId: String,
)

@Serializable
data class ErrorPayload(
    val code: String,
    val message: String,
)

internal data class ParticipantRecord(
    val participantId: String,
    val role: ParticipantRole,
    val joinToken: String,
    var socket: DefaultWebSocketServerSession? = null,
    var connectedAt: Instant? = null,
    var disconnectedAt: Instant? = null,
    var audioEnabled: Boolean = true,
    var videoEnabled: Boolean = true,
)

internal data class SessionRecord(
    val sessionId: String,
    val createdAt: Instant,
    val hostUrl: String,
    val shareUrl: String,
    val participants: MutableMap<ParticipantRole, ParticipantRecord>,
    var status: SessionStatus,
    var lastActivityAt: Instant,
    var emptySince: Instant? = null,
    var endedAt: Instant? = null,
)

internal data class OutboundMessage(
    val socket: DefaultWebSocketServerSession,
    val message: ServerWsMessage,
)

internal sealed class JoinResult {
    data class Success(
        val role: ParticipantRole,
        val participantId: String,
        val shouldCreateOffer: Boolean,
        val outboundMessages: List<OutboundMessage>,
        val previousSocket: DefaultWebSocketServerSession? = null,
    ) : JoinResult()

    data class Failure(
        val code: String,
        val message: String,
    ) : JoinResult()
}

internal data class ForwardResult(
    val outboundMessages: List<OutboundMessage>,
)
