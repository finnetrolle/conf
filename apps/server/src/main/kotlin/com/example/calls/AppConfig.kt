package com.example.calls

import java.time.Duration

data class AppConfig(
    val port: Int,
    val publicAppUrl: String,
    val allowedOrigins: List<String>,
    val stunUrl: String,
    val turnUrl: String?,
    val turnPort: Int,
    val turnTransport: String,
    val turnUsername: String? = null,
    val turnPassword: String? = null,
    val turnAuthSecret: String?,
    val turnCredentialTtl: Duration,
    val signalingReconnectGrace: Duration = Duration.ofSeconds(5),
    val emptySessionGrace: Duration,
    val endedSessionRetention: Duration,
    val sessionMaxAge: Duration,
)

object AppConfigLoader {
    fun fromEnvironment(): AppConfig = fromEnvironment(System.getenv())

    internal fun fromEnvironment(env: Map<String, String>): AppConfig {
        return AppConfig(
            port = env.getInt("APP_PORT", 8080),
            publicAppUrl = env["PUBLIC_APP_URL"] ?: "http://localhost:3000",
            allowedOrigins = env["ALLOWED_ORIGINS"]
                ?.split(",")
                ?.map(String::trim)
                ?.filter(String::isNotBlank)
                ?: listOf("http://localhost:3000"),
            stunUrl = env["STUN_URL"] ?: "stun:stun.l.google.com:19302",
            turnUrl = env["TURN_URL"]?.trim()?.takeIf(String::isNotBlank),
            turnPort = env.getInt("TURN_PORT", 3478),
            turnTransport = env["TURN_TRANSPORT"]?.trim()?.takeIf(String::isNotBlank) ?: "udp",
            turnUsername = env["TURN_USERNAME"]?.trim()?.takeIf(String::isNotBlank),
            turnPassword = env["TURN_PASSWORD"]?.trim()?.takeIf(String::isNotBlank),
            turnAuthSecret = env["TURN_AUTH_SECRET"]?.trim()?.takeIf(String::isNotBlank),
            turnCredentialTtl = Duration.ofMinutes(env.getLong("TURN_CREDENTIAL_TTL_MINUTES", 60)),
            signalingReconnectGrace = Duration.ofSeconds(env.getLong("SIGNALING_RECONNECT_GRACE_SECONDS", 5)),
            emptySessionGrace = Duration.ofSeconds(env.getLong("SESSION_EMPTY_GRACE_SECONDS", 10)),
            endedSessionRetention = Duration.ofSeconds(env.getLong("SESSION_RETENTION_SECONDS", 300)),
            sessionMaxAge = Duration.ofHours(env.getLong("SESSION_MAX_AGE_HOURS", 24)),
        )
    }

    private fun Map<String, String>.getInt(key: String, defaultValue: Int): Int =
        this[key]?.toIntOrNull() ?: defaultValue

    private fun Map<String, String>.getLong(key: String, defaultValue: Long): Long =
        this[key]?.toLongOrNull() ?: defaultValue
}
