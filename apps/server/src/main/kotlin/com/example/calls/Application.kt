package com.example.calls

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.application.ApplicationStopped
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.callloging.CallLogging
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main() {
    val config = AppConfigLoader.fromEnvironment()
    embeddedServer(
        factory = Netty,
        host = "0.0.0.0",
        port = config.port,
        module = {
            module(config = config)
        },
    ).start(wait = true)
}

fun Application.module(
    config: AppConfig = AppConfigLoader.fromEnvironment(),
    registryOverride: SessionRegistry? = null,
    enableCleanupLoop: Boolean = true,
) {
    val registry = registryOverride ?: SessionRegistry(config)

    install(CallLogging)
    install(ContentNegotiation) {
        json(JsonSupport.json)
    }
    install(CORS) {
        allowMethod(io.ktor.http.HttpMethod.Get)
        allowMethod(io.ktor.http.HttpMethod.Post)
        allowMethod(io.ktor.http.HttpMethod.Options)
        allowHeader(io.ktor.http.HttpHeaders.ContentType)
        allowHeader(io.ktor.http.HttpHeaders.Authorization)
        allowCredentials = false
        config.allowedOrigins.forEach { origin ->
            allowHost(origin.removePrefix("http://").removePrefix("https://"), schemes = listOf("http", "https"))
        }
    }
    install(WebSockets) {
        pingPeriodMillis = 15_000
        timeoutMillis = 15_000
        masking = false
        maxFrameSize = Long.MAX_VALUE
    }

    val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    if (enableCleanupLoop) {
        cleanupScope.launch {
            while (true) {
                delay(5_000)
                registry.cleanup()
            }
        }
    }

    environment.monitor.subscribe(ApplicationStopped) {
        cleanupScope.cancel()
    }

    routing {
        get("/health") {
            call.respond(HealthResponse(status = "ok", totalSessions = registry.totalSessions()))
        }

        route("/api") {
            post("/sessions") {
                call.respond(HttpStatusCode.Created, registry.createSession(call.resolvePublicAppUrl(config)))
            }

            get("/sessions/{sessionId}") {
                val sessionId = call.parameters["sessionId"]
                    ?: return@get call.respond(HttpStatusCode.BadRequest, mapOf("message" to "Missing sessionId"))
                val joinToken = call.request.queryParameters["joinToken"]
                val sessionInfo = registry.getSessionInfo(sessionId, joinToken)
                    ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("message" to "Session not found"))
                call.respond(sessionInfo)
            }

            get("/ice-servers") {
                call.respond(
                    IceServersResponse(
                        iceServers = listOf(
                            IceServerConfig(urls = listOf(config.stunUrl)),
                            IceServerConfig(
                                urls = listOf(config.turnUrl),
                                username = config.turnUsername,
                                credential = config.turnPassword,
                            ),
                        ),
                    ),
                )
            }
        }

        webSocket("/ws") {
            var joinedSessionId: String? = null
            var joinedToken: String? = null
            try {
                for (frame in incoming) {
                    if (frame !is Frame.Text) {
                        continue
                    }

                    val clientMessage = JsonSupport.json.decodeFromString(ClientWsMessage.serializer(), frame.readText())
                    when (clientMessage.type) {
                        "session.join" -> {
                            val payload = JsonSupport.json.decodeFromJsonElement(SessionJoinPayload.serializer(), clientMessage.payload)
                            when (val joinResult = registry.join(payload.sessionId, payload.joinToken, this)) {
                                is JoinResult.Success -> {
                                    joinedSessionId = payload.sessionId
                                    joinedToken = payload.joinToken
                                }

                                is JoinResult.Failure -> {
                                    sendError(joinResult.code, joinResult.message)
                                    close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, joinResult.message))
                                    return@webSocket
                                }
                            }
                        }

                        "session.leave" -> {
                            val sessionId = joinedSessionId
                            val token = joinedToken
                            if (sessionId != null && token != null) {
                                registry.leave(sessionId, token, this)
                                joinedSessionId = null
                                joinedToken = null
                            }
                            close(CloseReason(CloseReason.Codes.NORMAL, "Session left by client."))
                            return@webSocket
                        }

                        "webrtc.offer",
                        "webrtc.answer",
                        "webrtc.ice_candidate",
                        "webrtc.restart_ice",
                        "media.state_changed",
                        -> {
                            val sessionId = joinedSessionId
                            val token = joinedToken
                            if (sessionId == null || token == null) {
                                sendError("session_not_joined", "Join a session before sending signaling messages.")
                                continue
                            }
                            registry.forward(sessionId, token, clientMessage.type, clientMessage.payload)
                        }

                        else -> {
                            sendError("unsupported_event", "Unsupported event type: ${clientMessage.type}")
                        }
                    }
                }
            } catch (exception: Throwable) {
                if (exception !is CancellationException) {
                    this@module.environment.log.error("WebSocket failure", exception)
                }
            } finally {
                val sessionId = joinedSessionId
                val token = joinedToken
                if (sessionId != null && token != null) {
                    registry.leave(sessionId, token, this)
                }
            }
        }
    }
}

private fun ApplicationCall.resolvePublicAppUrl(config: AppConfig): String {
    val forwardedProto = request.headers["X-Forwarded-Proto"]?.substringBefore(",")?.trim()
    val forwardedHost = request.headers["X-Forwarded-Host"]?.substringBefore(",")?.trim()
    if (!forwardedProto.isNullOrBlank() && !forwardedHost.isNullOrBlank()) {
        return "$forwardedProto://$forwardedHost"
    }

    val origin = request.headers[HttpHeaders.Origin]?.substringBefore(",")?.trim()?.removeSuffix("/")
    if (!origin.isNullOrBlank()) {
        return origin
    }

    return config.publicAppUrl.removeSuffix("/")
}

private suspend fun DefaultWebSocketServerSession.sendError(code: String, message: String) {
    send(
        JsonSupport.json.encodeToString(
            ServerWsMessage.serializer(),
            ServerWsMessage(
                type = "error",
                payload = buildJsonObject {
                    put("code", code)
                    put("message", message)
                },
            ),
        ),
    )
}

object JsonSupport {
    val json = kotlinx.serialization.json.Json {
        prettyPrint = false
        ignoreUnknownKeys = true
        encodeDefaults = true
    }
}
