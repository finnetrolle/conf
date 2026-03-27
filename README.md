# Browser Video Sessions

Монорепозиторий для `MVP` браузерного приложения `1:1` видеосвязи.

Стек:

- `React + Vite + shadcn/ui` для веб-клиента;
- `Kotlin + Ktor + WebSocket` для signaling/backend;
- `WebRTC` для медиа;
- `coturn` для `STUN/TURN`;
- `docker compose` для локального запуска.

## Структура

```text
apps/
  server/  Kotlin Ktor API + signaling
  web/     React client
infra/
  coturn/  TURN/STUN config
  https/   скрипт генерации локального сертификата
docs/
  signaling-protocol.md
```

## Требования

- `Docker` с поддержкой `docker compose`;
- `OpenSSL` в `PATH` для генерации локального сертификата.

## Быстрый старт

1. Создай локальный env-файл:

   ```bash
   cp .env.example .env
   ```

2. Сгенерируй сертификат для локальной разработки:

   ```bash
   ./infra/https/generate-local-cert.sh localhost 127.0.0.1 <LAN_IP>
   ```

3. Подними проект:

   ```bash
   docker compose up --build
   ```

4. Открой [https://localhost:3000](https://localhost:3000) и подтверди локальный сертификат.

Для второго устройства в той же сети используй адрес вида `https://<LAN_IP>:3000`.
Если хочешь отправить ссылку на другой компьютер, создай сессию именно с `https://<LAN_IP>:3000`, а не с `https://localhost:3000`.

Это важно, потому что браузеры не дают доступ к камере и микрофону на другом устройстве по `http://<LAN_IP>`.

## Что уже реализовано

- создание одноразовой сессии;
- вход по ссылке;
- локальное превью камеры и микрофона;
- `WebSocket` signaling;
- `WebRTC offer/answer/ICE`;
- `mute/unmute` и `camera on/off`;
- выбор камеры, микрофона и аудиовыхода там, где браузер это поддерживает;
- повторный вход в тот же звонок после краткого обрыва или закрытия вкладки;
- устойчивое хранение жизненного цикла сессий с восстановлением после рестарта сервера;
- разделение состояний между ожиданием собеседника, завершенным звонком и устаревшим приглашением;
- cleanup старых сессий;
- контейнерный запуск через `docker compose`.

## Локальная проверка

Frontend:

```bash
cd apps/web
npm ci
npm run build
```

Backend:

```bash
cd apps/server
./gradlew test
```

Container smoke:

```bash
docker compose up -d --build server coturn
node scripts/smoke/backend-smoke.mjs
docker compose down -v
```

Browser WebRTC e2e:

```bash
COMPOSE_PROJECT_NAME=webrtc_e2e ./scripts/e2e/run-webrtc-browser.sh
```

Сценарий прогоняет два режима: обычный `auto` и `relay-only`, где клиент принудительно использует только `TURN`.
Для локального relay-прогона wrapper специально использует `127.0.0.1`, чтобы `TURN` шел по IPv4, а не через неоднозначный `localhost`.
Для ручной диагностики можно открыть ссылку с `?iceTransport=relay`, чтобы проверить именно relay-путь.

## Подготовка к GitHub

- `.env`, локальные сертификаты, `node_modules`, `dist` и служебные TypeScript-артефакты исключены из Git;
- добавлен базовый GitHub Actions workflow для сборки клиента и запуска тестов сервера;
- репозиторий можно инициализировать локально через `git init -b main`, затем добавить remote и выполнить первый push.
