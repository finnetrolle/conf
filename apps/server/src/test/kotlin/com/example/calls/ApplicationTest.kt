package com.example.calls

import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.request.header
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.testing.testApplication
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

class ApplicationTest {
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
    fun `can create session through http`() = testApplication {
        application {
            module(config = config, enableCleanupLoop = false)
        }

        val response = client.post("/api/sessions")
        assertEquals(HttpStatusCode.Created, response.status)

        val body = JsonSupport.json.decodeFromString(CreateSessionResponse.serializer(), response.bodyAsText())
        assertTrue(body.shareUrl.contains(body.sessionId))
    }

    @Test
    fun `create session respects forwarded public url`() = testApplication {
        application {
            module(config = config, enableCleanupLoop = false)
        }

        val response = client.post("/api/sessions") {
            header("X-Forwarded-Proto", "https")
            header("X-Forwarded-Host", "calls.example.test")
        }

        assertEquals(HttpStatusCode.Created, response.status)

        val body = JsonSupport.json.decodeFromString(CreateSessionResponse.serializer(), response.bodyAsText())
        assertTrue(body.hostUrl.startsWith("https://calls.example.test/session/"))
        assertTrue(body.shareUrl.startsWith("https://calls.example.test/session/"))
    }

    @Test
    fun `websocket forwards offer to peer`() = testApplication {
        val registry = SessionRegistry(config)
        application {
            module(config = config, registryOverride = registry, enableCleanupLoop = false)
        }

        val restClient = createClient {
            install(ContentNegotiation) {
                json(JsonSupport.json)
            }
        }
        val wsClient = createClient {
            install(WebSockets)
            install(ContentNegotiation) {
                json(JsonSupport.json)
            }
        }

        val createdResponse = restClient.post("/api/sessions")
        val created = JsonSupport.json.decodeFromString(CreateSessionResponse.serializer(), createdResponse.bodyAsText())

        val hostSession = wsClient.webSocketSession("/ws")
        hostSession.send(
            Frame.Text(
                JsonSupport.json.encodeToString(
                    ClientWsMessage.serializer(),
                    ClientWsMessage(
                        type = "session.join",
                        payload = JsonSupport.json.encodeToJsonElement(
                            SessionJoinPayload.serializer(),
                            SessionJoinPayload(created.sessionId, created.hostJoinToken),
                        ).jsonObject,
                    ),
                ),
            ),
        )
        hostSession.incoming.receive() as Frame.Text

        val guestToken = created.shareUrl.substringAfter("joinToken=")
        val guestSession = wsClient.webSocketSession("/ws")
        guestSession.send(
            Frame.Text(
                JsonSupport.json.encodeToString(
                    ClientWsMessage.serializer(),
                    ClientWsMessage(
                        type = "session.join",
                        payload = JsonSupport.json.encodeToJsonElement(
                            SessionJoinPayload.serializer(),
                            SessionJoinPayload(created.sessionId, guestToken),
                        ).jsonObject,
                    ),
                ),
            ),
        )

        guestSession.incoming.receive() as Frame.Text
        hostSession.incoming.receive() as Frame.Text

        hostSession.send(
            Frame.Text(
                JsonSupport.json.encodeToString(
                    ClientWsMessage.serializer(),
                    ClientWsMessage(
                        type = "webrtc.offer",
                        payload = buildJsonObject {
                            put("sdp", "test-offer")
                        },
                    ),
                ),
            ),
        )

        val forwarded = guestSession.incoming.receive() as Frame.Text
        val forwardedMessage = JsonSupport.json.decodeFromString(ServerWsMessage.serializer(), forwarded.readText())

        assertEquals("webrtc.offer", forwardedMessage.type)
        assertEquals("\"test-offer\"", forwardedMessage.payload["sdp"].toString())

        val health = restClient.get("/health")
        assertEquals(HttpStatusCode.OK, health.status)
    }
}
