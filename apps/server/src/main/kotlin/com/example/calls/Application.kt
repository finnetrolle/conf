package com.example.calls

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
                    ?: return@get call.respond(HttpStatusCode.BadRequest, mapOf("message" to "Ссылка на звонок открыта не полностью. Откройте приглашение еще раз."))
                val joinToken = call.request.queryParameters["joinToken"]
                val sessionInfo = registry.getSessionInfo(sessionId, joinToken)
                    ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("message" to "Такой звонок не найден. Проверьте ссылку или попросите новое приглашение."))
                call.respond(sessionInfo)
            }

            get("/ice-servers") {
                val sessionId = call.request.queryParameters["sessionId"]
                    ?: return@get call.respond(HttpStatusCode.BadRequest, mapOf("message" to "Ссылка на звонок открыта не полностью. Откройте приглашение еще раз."))
                val joinToken = call.request.queryParameters["joinToken"]
                    ?: return@get call.respond(HttpStatusCode.BadRequest, mapOf("message" to "Ссылка на звонок открыта не полностью. Откройте приглашение еще раз."))

                val sessionInfo = registry.getSessionInfo(sessionId, joinToken)
                    ?: return@get call.respond(HttpStatusCode.NotFound, mapOf("message" to "Такой звонок не найден. Проверьте ссылку или попросите новое приглашение."))
                if (sessionInfo.role == null) {
                    return@get call.respond(HttpStatusCode.Forbidden, mapOf("message" to "Ссылка для входа больше не подходит. Попросите отправить приглашение еще раз."))
                }
                if (!sessionInfo.canJoin) {
                    val status = when (sessionInfo.status) {
                        SessionStatus.ENDED,
                        SessionStatus.EXPIRED,
                        -> HttpStatusCode.Gone

                        else -> HttpStatusCode.Conflict
                    }
                    return@get call.respond(status, mapOf("message" to (sessionInfo.message ?: "Не удалось подготовить звонок. Обновите страницу и попробуйте снова.")))
                }

                val iceServers = buildList {
                    if (config.stunUrl.isNotBlank()) {
                        add(IceServerConfig(urls = listOf(config.stunUrl)))
                    }

                    call.resolveTurnIceServer(config, sessionId, sessionInfo.role)?.let(::add)
                }
                this@module.environment.log.info(
                    "Issued ICE config for session={} role={} servers={} turnEnabled={}",
                    sessionId,
                    sessionInfo.role.name.lowercase(),
                    iceServers.size,
                    iceServers.any { server -> server.urls.any { it.startsWith("turn:") } },
                )

                call.respond(
                    IceServersResponse(
                        iceServers = iceServers,
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
                        "session.join",
                        "session.resume",
                        -> {
                            val payload = JsonSupport.json.decodeFromJsonElement(SessionJoinPayload.serializer(), clientMessage.payload)
                            when (
                                val joinResult = registry.join(
                                    payload.sessionId,
                                    payload.joinToken,
                                    this,
                                    resumeRequested = clientMessage.type == "session.resume",
                                )
                            ) {
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
                                sendError("session_not_joined", "Сначала откройте звонок по ссылке, а потом повторите действие.")
                                continue
                            }
                            registry.forward(sessionId, token, clientMessage.type, clientMessage.payload)
                        }

                        else -> {
                            this@module.environment.log.warn("Unsupported WebSocket event type={}", clientMessage.type)
                            sendError("unsupported_event", "Во время звонка произошла ошибка. Обновите страницу и попробуйте снова.")
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
                    registry.markDisconnected(sessionId, token, this)?.let { reconnectGraceUntil ->
                        cleanupScope.launch {
                            delay(config.signalingReconnectGrace.toMillis())
                            registry.finalizeDisconnect(sessionId, token, reconnectGraceUntil)
                        }
                    }
                }
            }
        }
    }
}

private fun ApplicationCall.resolvePublicAppUrl(config: AppConfig): String {
    return config.publicAppUrl.removeSuffix("/")
}

private fun ApplicationCall.resolveTurnIceServer(
    config: AppConfig,
    sessionId: String,
    role: ParticipantRole,
): IceServerConfig? {
    val credentials = issueTurnCredentials(config, sessionId, role) ?: return null
    val turnUrl = config.turnUrl ?: resolveTurnUrlFromPublicAppUrl(config) ?: return null
    return IceServerConfig(
        urls = listOf(turnUrl),
        username = credentials.username,
        credential = credentials.credential,
    )
}

private fun resolveTurnUrlFromPublicAppUrl(config: AppConfig): String? {
    val host = runCatching {
        java.net.URI(config.publicAppUrl.removeSuffix("/")).host
    }.getOrNull()?.takeIf { it.isNotBlank() } ?: return null

    return "turn:$host:${config.turnPort}?transport=${config.turnTransport}"
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
