package com.example.calls

import java.time.Duration

data class AppConfig(
    val port: Int,
    val publicAppUrl: String,
    val allowedOrigins: List<String>,
    val stunUrl: String,
    val turnUrl: String,
    val turnUsername: String,
    val turnPassword: String,
    val emptySessionGrace: Duration,
    val endedSessionRetention: Duration,
    val sessionMaxAge: Duration,
)

object AppConfigLoader {
    fun fromEnvironment(): AppConfig {
        val env = System.getenv()
        return AppConfig(
            port = env.getInt("APP_PORT", 8080),
            publicAppUrl = env["PUBLIC_APP_URL"] ?: "http://localhost:3000",
            allowedOrigins = env["ALLOWED_ORIGINS"]
                ?.split(",")
                ?.map(String::trim)
                ?.filter(String::isNotBlank)
                ?: listOf("http://localhost:3000"),
            stunUrl = env["STUN_URL"] ?: "stun:stun.l.google.com:19302",
            turnUrl = env["TURN_URL"] ?: "turn:localhost:3478?transport=udp",
            turnUsername = env["TURN_USERNAME"] ?: "webrtc",
            turnPassword = env["TURN_PASSWORD"] ?: "webrtc-secret",
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

