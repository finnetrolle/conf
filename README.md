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
- завершение сессии после выхода обоих участников;
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
gradle test
```

## Подготовка к GitHub

- `.env`, локальные сертификаты, `node_modules`, `dist` и служебные TypeScript-артефакты исключены из Git;
- добавлен базовый GitHub Actions workflow для сборки клиента и запуска тестов сервера;
- репозиторий можно инициализировать локально через `git init -b main`, затем добавить remote и выполнить первый push.
