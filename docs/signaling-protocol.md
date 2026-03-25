# Signaling Protocol

## HTTP endpoints

### `POST /api/sessions`

Создает новую сессию и возвращает данные для создателя:

```json
{
  "sessionId": "session_abc123",
  "status": "waiting_for_peer",
  "hostUrl": "http://localhost:3000/session/session_abc123?joinToken=host_token",
  "shareUrl": "http://localhost:3000/session/session_abc123?joinToken=guest_token",
  "hostJoinToken": "host_token"
}
```

### `GET /api/sessions/{sessionId}?joinToken=...`

Возвращает метаданные сессии и возможность входа для конкретного токена.

### `GET /api/ice-servers`

Возвращает `STUN/TURN` конфигурацию.

## WebSocket

Клиент подключается к `/ws`, а затем отправляет `session.join`.

### Client -> Server

#### `session.join`

```json
{
  "type": "session.join",
  "payload": {
    "sessionId": "session_abc123",
    "joinToken": "guest_token"
  }
}
```

#### `session.leave`

```json
{
  "type": "session.leave",
  "payload": {
    "sessionId": "session_abc123"
  }
}
```

#### `webrtc.offer`

```json
{
  "type": "webrtc.offer",
  "payload": {
    "sdp": "..."
  }
}
```

#### `webrtc.answer`

```json
{
  "type": "webrtc.answer",
  "payload": {
    "sdp": "..."
  }
}
```

#### `webrtc.ice_candidate`

```json
{
  "type": "webrtc.ice_candidate",
  "payload": {
    "candidate": {
      "candidate": "candidate:...",
      "sdpMid": "0",
      "sdpMLineIndex": 0
    }
  }
}
```

#### `media.state_changed`

```json
{
  "type": "media.state_changed",
  "payload": {
    "audioEnabled": true,
    "videoEnabled": false
  }
}
```

### Server -> Client

#### `session.ready`

```json
{
  "type": "session.ready",
  "payload": {
    "sessionId": "session_abc123",
    "participantId": "participant_host",
    "role": "host",
    "peerPresent": false,
    "shouldCreateOffer": false,
    "activeParticipants": 1
  }
}
```

#### `participant.joined`

```json
{
  "type": "participant.joined",
  "payload": {
    "participantId": "participant_guest",
    "role": "guest"
  }
}
```

#### `participant.left`

```json
{
  "type": "participant.left",
  "payload": {
    "participantId": "participant_guest",
    "role": "guest"
  }
}
```

#### `session.full`

Сессия занята и не принимает дополнительных подключений.

#### `session.ended`

Сессия завершена и больше не принимает подключения.

#### `error`

Общая ошибка протокола:

```json
{
  "type": "error",
  "payload": {
    "code": "invalid_join_token",
    "message": "Join token is invalid for this session."
  }
}
```

