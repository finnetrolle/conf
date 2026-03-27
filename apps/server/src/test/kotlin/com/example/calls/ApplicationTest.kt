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
import io.ktor.websocket.CloseReason
import io.ktor.websocket.readText
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

class ApplicationTest {
    private val config = AppConfig(
        port = 8080,
        publicAppUrl = "http://localhost:3000",
        allowedOrigins = listOf("http://localhost:3000"),
        stunUrl = "stun:stun.l.google.com:19302",
        turnUrl = null,
        turnPort = 3478,
        turnTransport = "udp",
        turnAuthSecret = "webrtc-secret",
        turnCredentialTtl = java.time.Duration.ofMinutes(60),
        signalingReconnectGrace = java.time.Duration.ofMillis(250),
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
    fun `create session uses configured public url even with forwarded headers`() = testApplication {
        val publicConfig = config.copy(publicAppUrl = "https://public.example.test")
        application {
            module(config = publicConfig, enableCleanupLoop = false)
        }

        val response = client.post("/api/sessions") {
            header("X-Forwarded-Proto", "https")
            header("X-Forwarded-Host", "calls.example.test")
        }

        assertEquals(HttpStatusCode.Created, response.status)

        val body = JsonSupport.json.decodeFromString(CreateSessionResponse.serializer(), response.bodyAsText())
        assertTrue(body.hostUrl.startsWith("https://public.example.test/session/"))
        assertTrue(body.shareUrl.startsWith("https://public.example.test/session/"))
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

    @Test
    fun `ice servers require a valid join token`() = testApplication {
        application {
            module(config = config, enableCleanupLoop = false)
        }

        val createdResponse = client.post("/api/sessions")
        val created = JsonSupport.json.decodeFromString(CreateSessionResponse.serializer(), createdResponse.bodyAsText())

        val response = client.get("/api/ice-servers?sessionId=${created.sessionId}&joinToken=bad-token")

        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertTrue(response.bodyAsText().contains("Ссылка для входа больше не подходит"))
    }

    @Test
    fun `ice servers derive turn host from configured public url`() = testApplication {
        val publicConfig = config.copy(publicAppUrl = "https://public.example.test")
        application {
            module(config = publicConfig, enableCleanupLoop = false)
        }

        val createdResponse = client.post("/api/sessions")
        val created = JsonSupport.json.decodeFromString(CreateSessionResponse.serializer(), createdResponse.bodyAsText())

        val response = client.get("/api/ice-servers?sessionId=${created.sessionId}&joinToken=${created.hostJoinToken}")

        assertEquals(HttpStatusCode.OK, response.status)

        val body = JsonSupport.json.parseToJsonElement(response.bodyAsText()).jsonObject
        val iceServers = body.getValue("iceServers").jsonArray
        assertEquals(2, iceServers.size)

        val turnServer = iceServers[1].jsonObject
        val urls = turnServer.getValue("urls").jsonArray
        assertEquals("\"turn:public.example.test:3478?transport=udp\"", urls[0].toString())
        assertFalse(turnServer["username"].toString().trim('"').isBlank())
        assertFalse(turnServer["credential"].toString().trim('"').isBlank())
    }

    @Test
    fun `ice servers fall back to static turn credentials when auth secret is absent`() = testApplication {
        val legacyConfig = config.copy(
            turnUrl = "turn:legacy.example.test:3478?transport=udp",
            turnAuthSecret = null,
            turnUsername = "legacy-user",
            turnPassword = "legacy-password",
        )
        application {
            module(config = legacyConfig, enableCleanupLoop = false)
        }

        val createdResponse = client.post("/api/sessions")
        val created = JsonSupport.json.decodeFromString(CreateSessionResponse.serializer(), createdResponse.bodyAsText())

        val response = client.get("/api/ice-servers?sessionId=${created.sessionId}&joinToken=${created.hostJoinToken}")

        assertEquals(HttpStatusCode.OK, response.status)

        val body = JsonSupport.json.parseToJsonElement(response.bodyAsText()).jsonObject
        val iceServers = body.getValue("iceServers").jsonArray
        assertEquals(2, iceServers.size)

        val turnServer = iceServers[1].jsonObject
        val urls = turnServer.getValue("urls").jsonArray
        assertEquals("\"turn:legacy.example.test:3478?transport=udp\"", urls[0].toString())
        assertEquals("\"legacy-user\"", turnServer.getValue("username").toString())
        assertEquals("\"legacy-password\"", turnServer.getValue("credential").toString())
    }

    @Test
    fun `session resume does not emit leave join churn during reconnect grace`() = testApplication {
        application {
            module(config = config, enableCleanupLoop = false)
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
        val guestToken = created.shareUrl.substringAfter("joinToken=")

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

        guestSession.send(Frame.Close(CloseReason(CloseReason.Codes.NORMAL, "Transient signaling loss")))
        assertNull(withTimeoutOrNull(150) { hostSession.incoming.receive() })

        val resumedGuestSession = wsClient.webSocketSession("/ws")
        resumedGuestSession.send(
            Frame.Text(
                JsonSupport.json.encodeToString(
                    ClientWsMessage.serializer(),
                    ClientWsMessage(
                        type = "session.resume",
                        payload = JsonSupport.json.encodeToJsonElement(
                            SessionJoinPayload.serializer(),
                            SessionJoinPayload(created.sessionId, guestToken),
                        ).jsonObject,
                    ),
                ),
            ),
        )

        val resumedReady = resumedGuestSession.incoming.receive() as Frame.Text
        val resumedReadyMessage = JsonSupport.json.decodeFromString(ServerWsMessage.serializer(), resumedReady.readText())
        assertEquals("session.ready", resumedReadyMessage.type)
        assertEquals("true", resumedReadyMessage.payload.getValue("resumed").toString())
        assertEquals("false", resumedReadyMessage.payload.getValue("shouldCreateOffer").toString())
        assertNull(withTimeoutOrNull(300) { hostSession.incoming.receive() })

        resumedGuestSession.send(Frame.Close(CloseReason(CloseReason.Codes.NORMAL, "Test complete")))
        hostSession.send(Frame.Close(CloseReason(CloseReason.Codes.NORMAL, "Test complete")))
    }
}
