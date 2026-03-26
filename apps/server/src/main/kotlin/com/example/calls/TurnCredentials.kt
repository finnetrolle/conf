package com.example.calls

import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

internal data class TurnCredentials(
    val username: String,
    val credential: String,
)

internal fun issueTurnCredentials(
    config: AppConfig,
    sessionId: String,
    role: ParticipantRole,
): TurnCredentials? {
    config.turnAuthSecret?.let { secret ->
        val expiresAt = Instant.now().plus(config.turnCredentialTtl).epochSecond
        val username = "$expiresAt:$sessionId:${role.name.lowercase()}"

        val mac = Mac.getInstance("HmacSHA1")
        mac.init(SecretKeySpec(secret.toByteArray(StandardCharsets.UTF_8), "HmacSHA1"))
        val digest = mac.doFinal(username.toByteArray(StandardCharsets.UTF_8))
        val credential = Base64.getEncoder().encodeToString(digest)

        return TurnCredentials(username = username, credential = credential)
    }

    val username = config.turnUsername?.takeIf(String::isNotBlank) ?: return null
    val credential = config.turnPassword?.takeIf(String::isNotBlank) ?: return null
    return TurnCredentials(username = username, credential = credential)
}
