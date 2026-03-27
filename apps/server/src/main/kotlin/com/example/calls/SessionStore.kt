package com.example.calls

import kotlinx.serialization.Serializable
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.time.Instant

internal interface SessionStateStore {
    fun load(): List<StoredSessionRecord>

    fun save(sessions: Collection<StoredSessionRecord>)

    companion object {
        fun fromConfig(config: AppConfig): SessionStateStore {
            val storePath = config.sessionStorePath?.trim()?.takeIf(String::isNotBlank)
                ?: return InMemorySessionStateStore()
            return JsonFileSessionStateStore(Path.of(storePath))
        }
    }
}

internal class InMemorySessionStateStore(
    initialSessions: List<StoredSessionRecord> = emptyList(),
) : SessionStateStore {
    private var sessions = initialSessions.deepCopy()

    override fun load(): List<StoredSessionRecord> = sessions.deepCopy()

    override fun save(sessions: Collection<StoredSessionRecord>) {
        this.sessions = sessions.toList().deepCopy()
    }
}

internal class JsonFileSessionStateStore(
    private val path: Path,
) : SessionStateStore {
    private val logger = LoggerFactory.getLogger(JsonFileSessionStateStore::class.java)

    override fun load(): List<StoredSessionRecord> {
        if (!Files.exists(path)) {
            return emptyList()
        }

        return runCatching {
            val raw = Files.readString(path)
            if (raw.isBlank()) {
                return emptyList()
            }

            val snapshot = JsonSupport.json.decodeFromString(SessionStoreSnapshot.serializer(), raw)
            snapshot.sessions.deepCopy()
        }.getOrElse { error ->
            logger.error("Failed to load session state from {}", path, error)
            emptyList()
        }
    }

    override fun save(sessions: Collection<StoredSessionRecord>) {
        runCatching {
            val snapshot = SessionStoreSnapshot(
                sessions = sessions.toList().deepCopy(),
            )
            val parent = path.parent
            if (parent != null) {
                Files.createDirectories(parent)
            }

            val tempPath = path.resolveSibling("${path.fileName}.tmp")
            Files.writeString(
                tempPath,
                JsonSupport.json.encodeToString(SessionStoreSnapshot.serializer(), snapshot),
            )

            runCatching {
                Files.move(
                    tempPath,
                    path,
                    StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE,
                )
            }.getOrElse {
                Files.move(
                    tempPath,
                    path,
                    StandardCopyOption.REPLACE_EXISTING,
                )
            }
        }.onFailure { error ->
            logger.error("Failed to persist session state to {}", path, error)
        }
    }
}

@Serializable
internal data class SessionStoreSnapshot(
    val version: Int = 1,
    val sessions: List<StoredSessionRecord> = emptyList(),
)

@Serializable
internal data class StoredSessionRecord(
    val sessionId: String,
    val createdAt: String,
    val hostUrl: String,
    val shareUrl: String,
    val participants: List<StoredParticipantRecord>,
    val status: SessionStatus,
    val lastActivityAt: String,
    val emptySince: String? = null,
    val endedAt: String? = null,
    val callEstablishedAt: String? = null,
)

@Serializable
internal data class StoredParticipantRecord(
    val participantId: String,
    val role: ParticipantRole,
    val joinToken: String,
    val connectedAt: String? = null,
    val disconnectedAt: String? = null,
    val reconnectGraceUntil: String? = null,
    val audioEnabled: Boolean = true,
    val videoEnabled: Boolean = true,
)

internal fun SessionRecord.toStoredSnapshot(): StoredSessionRecord =
    StoredSessionRecord(
        sessionId = sessionId,
        createdAt = createdAt.toString(),
        hostUrl = hostUrl,
        shareUrl = shareUrl,
        participants = participants.values
            .sortedBy { it.role.ordinal }
            .map { participant ->
                StoredParticipantRecord(
                    participantId = participant.participantId,
                    role = participant.role,
                    joinToken = participant.joinToken,
                    connectedAt = participant.connectedAt.toPersistedInstant(),
                    disconnectedAt = participant.disconnectedAt.toPersistedInstant(),
                    reconnectGraceUntil = participant.reconnectGraceUntil.toPersistedInstant(),
                    audioEnabled = participant.audioEnabled,
                    videoEnabled = participant.videoEnabled,
                )
            },
        status = status,
        lastActivityAt = lastActivityAt.toString(),
        emptySince = emptySince.toPersistedInstant(),
        endedAt = endedAt.toPersistedInstant(),
        callEstablishedAt = callEstablishedAt.toPersistedInstant(),
    )

internal fun StoredSessionRecord.toSessionRecordOrNull(
    config: AppConfig,
    restoredAt: Instant,
    logger: Logger,
): SessionRecord? {
    val createdAtInstant = createdAt.toInstantOrNull()
    val lastActivityAtInstant = lastActivityAt.toInstantOrNull()
    if (createdAtInstant == null || lastActivityAtInstant == null) {
        logger.warn("Skipping corrupted persisted session {}", sessionId)
        return null
    }

    val participantsByRole = participants
        .map(::toParticipantRecord)
        .associateBy { it.role }
        .toMutableMap()
    if (!participantsByRole.keys.containsAll(setOf(ParticipantRole.HOST, ParticipantRole.GUEST))) {
        logger.warn("Skipping persisted session {} without host and guest records", sessionId)
        return null
    }

    val session = SessionRecord(
        sessionId = sessionId,
        createdAt = createdAtInstant,
        hostUrl = hostUrl,
        shareUrl = shareUrl,
        participants = participantsByRole,
        status = status,
        lastActivityAt = lastActivityAtInstant,
        emptySince = emptySince.toInstantOrNull(),
        endedAt = endedAt.toInstantOrNull(),
        callEstablishedAt = callEstablishedAt.toInstantOrNull(),
    )

    return session.normalizeAfterRestore(config, restoredAt)
}

private fun toParticipantRecord(snapshot: StoredParticipantRecord): ParticipantRecord =
    ParticipantRecord(
        participantId = snapshot.participantId,
        role = snapshot.role,
        joinToken = snapshot.joinToken,
        connectedAt = snapshot.connectedAt.toInstantOrNull(),
        disconnectedAt = snapshot.disconnectedAt.toInstantOrNull(),
        reconnectGraceUntil = snapshot.reconnectGraceUntil.toInstantOrNull(),
        audioEnabled = snapshot.audioEnabled,
        videoEnabled = snapshot.videoEnabled,
    )

private fun SessionRecord.normalizeAfterRestore(
    config: AppConfig,
    restoredAt: Instant,
): SessionRecord {
    val wasTerminal = status == SessionStatus.ENDED || status == SessionStatus.EXPIRED
    val participantsThatLookedConnected = participants.values.filter { it.connectedAt != null && it.disconnectedAt == null }

    participants.values.forEach { participant ->
        participant.socket = null
        if (wasTerminal) {
            participant.reconnectGraceUntil = null
        } else if (participant.reconnectGraceUntil?.isAfter(restoredAt) == false) {
            participant.reconnectGraceUntil = null
        }
    }

    if (wasTerminal) {
        if (endedAt == null) {
            endedAt = restoredAt
        }
        return this
    }

    if (participantsThatLookedConnected.isNotEmpty()) {
        participantsThatLookedConnected.forEach { participant ->
            participant.disconnectedAt = restoredAt
            participant.reconnectGraceUntil = restoredAt.plus(config.signalingReconnectGrace)
        }
        lastActivityAt = restoredAt
        emptySince = restoredAt
    } else if (emptySince == null) {
        emptySince = restoredAt
    }

    endedAt = null
    status = SessionStatus.WAITING_FOR_PEER
    return this
}

private fun Instant?.toPersistedInstant(): String? = this?.toString()

private fun String?.toInstantOrNull(): Instant? =
    this?.let { value ->
        runCatching { Instant.parse(value) }.getOrNull()
    }

private fun List<StoredSessionRecord>.deepCopy(): List<StoredSessionRecord> =
    map { session ->
        session.copy(
            participants = session.participants.map { participant -> participant.copy() },
        )
    }
