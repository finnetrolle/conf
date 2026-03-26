# VPS Installation Guide

Подробная инструкция по разворачиванию этого проекта на "голом" VPS с собственным доменом.

Гайд собран под текущую структуру репозитория:

- `apps/web` - frontend на `React + Vite`, внутри контейнера обслуживается `nginx`;
- `apps/server` - backend/signaling на `Kotlin + Ktor`;
- `infra/coturn` - `coturn` для `STUN/TURN`;
- внешний `nginx` на самом VPS - принимает трафик с домена и завершает `HTTPS`.

Гайд рассчитан на `Ubuntu/Debian` и домен вида `callparents.ru`. Вместо него подставляй свой домен.

## 1. Как будет устроено в production

Рекомендуемая схема для VPS:

1. Пользователь открывает `https://callparents.ru`.
2. Системный `nginx` на VPS принимает запросы на `80/443`.
3. Системный `nginx` проксирует весь домен в контейнер `web` на `127.0.0.1:3000`.
4. Внутри контейнера `web` свой `nginx` раздает фронтенд и проксирует `/api` и `/ws` в контейнер `server`.
5. Контейнер `coturn` обслуживает `STUN/TURN` на `3478` и relay-портах `49160-49200/udp`.

Это важно: `HTTPS` лучше завершать на хостовом `nginx`, а не внутри `apps/web/nginx.conf`.

## 2. Что нужно заранее

- VPS с публичным IPv4.
- Домен с доступом к DNS.
- Доступ по `SSH`.
- Пользователь с правами `sudo`.

Желательно:

- отдельная `A`-запись для основного домена;
- при использовании `www` отдельная запись `www`;
- если есть `AAAA`-запись, она тоже должна указывать на этот VPS, иначе браузер может уйти на другой сервер по `IPv6`.

## 3. Настройка DNS

В панели регистратора или DNS-провайдера создай записи:

```text
A     callparents.ru      -> <IP_VPS>
A     www.callparents.ru  -> <IP_VPS>   (если нужен www)
```

Проверить можно так:

```bash
getent ahosts callparents.ru
curl -4 -I http://callparents.ru
```

Если нужен именно `dig`, установи его:

```bash
sudo apt update
sudo apt install -y dnsutils
dig +short A callparents.ru
dig +short AAAA callparents.ru
```

## 4. Подготовка VPS

Установи базовые пакеты:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx git ufw
sudo systemctl enable --now docker
sudo systemctl enable --now nginx
```

## 5. Исправление доступа к Docker

Если при запуске видишь ошибку:

```text
permission denied while trying to connect to the docker API at unix:///var/run/docker.sock
```

это значит, что пользователь не имеет доступа к Docker daemon.

Разовый запуск:

```bash
sudo docker compose up -d --build
```

Постоянное решение:

```bash
sudo usermod -aG docker $USER
newgrp docker
docker ps
```

Если после `newgrp docker` ошибка осталась, выйди из SSH-сессии и зайди снова.

## 6. Клонирование проекта

```bash
cd ~
git clone <URL_РЕПО> conf
cd ~/conf
cp .env.example .env
```

## 7. Production-правки в проекте

Перед первым запуском нужно адаптировать репозиторий под VPS.

### 7.1. `.env`

Открой файл:

```bash
nano ~/conf/.env
```

Пример production-значений:

```env
PUBLIC_APP_URL=https://callparents.ru
ALLOWED_ORIGINS=https://callparents.ru,https://www.callparents.ru

VITE_PUBLIC_APP_URL=
VITE_API_BASE_URL=
VITE_WS_BASE_URL=

API_PORT=8080
WEB_PORT=3000
TURN_PORT=3478

STUN_URL=stun:stun.l.google.com:19302
TURN_URL=turn:callparents.ru:3478?transport=udp
TURN_USERNAME=webrtc
TURN_PASSWORD=fead7ee26a6378167ed2eed695afa9deedb739150a55c5713c1f90f0ef50d809

SESSION_EMPTY_GRACE_SECONDS=10
SESSION_RETENTION_SECONDS=300
SESSION_MAX_AGE_HOURS=24
```

Замечания:

- `VITE_API_BASE_URL` и `VITE_WS_BASE_URL` можно оставить пустыми, потому что фронтенд умеет работать через same-origin.
- `ALLOWED_ORIGINS` можно перечислять через запятую.
- если не нужен `www`, убери его из `ALLOWED_ORIGINS`.

### 7.2. Как сгенерировать `TURN_PASSWORD`

Лучше всего использовать hex-строку без спецсимволов:

```bash
openssl rand -hex 32
```

Пример результата:

```text
fead7ee26a6378167ed2eed695afa9deedb739150a55c5713c1f90f0ef50d809
```

Такой секрет безопаснее использовать, потому что:

- нет пробелов;
- нет `:`, `$`, кавычек и других символов, которые могут ломать парсинг;
- его удобно вставлять и в `.env`, и в `coturn`.

### 7.3. `apps/web/nginx.conf`

Файл `apps/web/nginx.conf` в репозитории по умолчанию настроен на локальный `SSL` с dev-сертификатами. Для VPS это не нужно, потому что `HTTPS` будет обслуживать внешний `nginx` на хосте.

Открой:

```bash
nano ~/conf/apps/web/nginx.conf
```

Сделай production-вариант:

```nginx
server {
  listen 80;
  server_name _;

  root /usr/share/nginx/html;
  index index.html;

  location /api/ {
    proxy_pass http://server:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Origin "";
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  location = /ws {
    proxy_pass http://server:8080/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header Origin "";
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

Что меняется по сравнению с локальным режимом:

- `listen 80 ssl;` заменяется на `listen 80;`
- удаляются `ssl_certificate`, `ssl_certificate_key`, `ssl_protocols`, `ssl_session_*`

### 7.4. `infra/coturn/turnserver.conf`

Открой:

```bash
nano ~/conf/infra/coturn/turnserver.conf
```

Рекомендуемый production-вариант:

```ini
listening-port=3478
realm=callparents.ru
fingerprint
lt-cred-mech
user=webrtc:fead7ee26a6378167ed2eed695afa9deedb739150a55c5713c1f90f0ef50d809
external-ip=<IP_VPS>
no-cli
no-tls
no-dtls
min-port=49160
max-port=49200
```

Важно:

- пароль здесь должен совпадать с `TURN_PASSWORD` из `.env`;
- `realm` должен быть реальным доменом;
- `external-ip` обязателен для нормальной работы `TURN` за NAT/на VPS;
- переменная `TURN_REALM` из `.env.example` в текущем коде не используется, поэтому `realm` надо менять вручную в `turnserver.conf`.

### 7.5. `docker-compose.yml`

Рекомендуется сделать так, чтобы `server` и `web` были доступны только локально с VPS, а наружу торчал только `coturn`. За публичный `HTTP/HTTPS` отвечает хостовый `nginx`.

Открой:

```bash
nano ~/conf/docker-compose.yml
```

Рекомендуемый вариант:

```yaml
services:
  server:
    build:
      context: ./apps/server
      dockerfile: Dockerfile
    environment:
      APP_PORT: 8080
      PUBLIC_APP_URL: ${PUBLIC_APP_URL}
      ALLOWED_ORIGINS: ${ALLOWED_ORIGINS}
      STUN_URL: ${STUN_URL}
      TURN_URL: ${TURN_URL}
      TURN_USERNAME: ${TURN_USERNAME}
      TURN_PASSWORD: ${TURN_PASSWORD}
      SESSION_EMPTY_GRACE_SECONDS: ${SESSION_EMPTY_GRACE_SECONDS:-10}
      SESSION_RETENTION_SECONDS: ${SESSION_RETENTION_SECONDS:-300}
      SESSION_MAX_AGE_HOURS: ${SESSION_MAX_AGE_HOURS:-24}
    ports:
      - "127.0.0.1:${API_PORT:-8080}:8080"
    depends_on:
      - coturn

  web:
    build:
      context: ./apps/web
      dockerfile: Dockerfile
      args:
        VITE_PUBLIC_APP_URL: ${VITE_PUBLIC_APP_URL:-}
        VITE_API_BASE_URL: ${VITE_API_BASE_URL:-}
        VITE_WS_BASE_URL: ${VITE_WS_BASE_URL:-}
    ports:
      - "127.0.0.1:${WEB_PORT:-3000}:80"
    depends_on:
      - server

  coturn:
    image: coturn/coturn:latest
    command:
      - -c
      - /etc/coturn/turnserver.conf
    ports:
      - "${TURN_PORT:-3478}:3478"
      - "${TURN_PORT:-3478}:3478/udp"
      - "49160-49200:49160-49200/udp"
    volumes:
      - ./infra/coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro
```

Ключевой момент: если не пробросить `49160-49200/udp`, `TURN`-relay может не работать.

Если отталкиваешься от текущего `docker-compose.yml` в репозитории, убери старый bind-монт dev-сертификатов в `web`, потому что в production `SSL` завершает внешний `nginx` на VPS.

## 8. Первый запуск контейнеров

```bash
cd ~/conf
docker compose up -d --build
docker compose ps
```

Полезные проверки:

```bash
curl -I http://127.0.0.1:3000
curl http://127.0.0.1:8080/health
docker compose logs -f web
docker compose logs -f server
docker compose logs -f coturn
```

## 9. Настройка системного Nginx на VPS

Здесь речь не про `apps/web/nginx.conf`, а про системный `nginx` на сервере.

Создай файл:

```bash
sudo nano /etc/nginx/sites-available/callparents.ru
```

Содержимое:

```nginx
server {
    listen 80 default_server;
    server_name callparents.ru www.callparents.ru;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Включи сайт:

```bash
sudo ln -sf /etc/nginx/sites-available/callparents.ru /etc/nginx/sites-enabled/callparents.ru
```

Если у тебя раньше создавался другой сайт по IP, например `193.187.92.61`, удали его из enabled:

```bash
sudo rm -f /etc/nginx/sites-enabled/193.187.92.61
```

Если включен дефолтный конфиг `default`, тоже убери:

```bash
sudo rm -f /etc/nginx/sites-enabled/default
```

Проверка и перезагрузка:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 10. Выпуск HTTPS-сертификата

Если нужен только основной домен:

```bash
sudo certbot --nginx -d callparents.ru
```

Если нужен и `www`:

```bash
sudo certbot --nginx -d callparents.ru -d www.callparents.ru
```

`Certbot` сам добавит `listen 443 ssl`, пути к сертификатам и `redirect` с `80` на `443`, если конфиг корректный.

После успешного выпуска сертификата проверь:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo ss -tulpn | grep :443
curl -I https://callparents.ru
```

## 11. Firewall

Открой необходимые порты:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49160:49200/udp
sudo ufw enable
sudo ufw status
```

## 12. Финальная проверка

Проверь:

```bash
curl -I http://127.0.0.1:3000
curl -I -H 'Host: callparents.ru' http://127.0.0.1
curl -I https://callparents.ru
```

Открой сайт:

- с ноутбука по `https://callparents.ru`
- с телефона по мобильному интернету

Проверь:

1. создание сессии;
2. копирование ссылки;
3. подключение второго участника;
4. доступ к камере и микрофону;
5. успешный звонок между двумя разными сетями.

## 13. Диагностика проблем

### 13.1. `permission denied while trying to connect to the docker API`

Решение:

```bash
sudo usermod -aG docker $USER
newgrp docker
docker ps
```

Либо запускай команды через `sudo`.

### 13.2. Открывается `Welcome to nginx!`

Это значит, что запрос попадает в дефолтный или неправильный сайт `nginx`, а не в твой конфиг домена.

Проверь:

```bash
sudo nginx -T | grep -n "server_name\|listen"
ls -l /etc/nginx/sites-enabled
```

Что должно быть:

- активен сайт `callparents.ru`;
- удалены `default` и старые сайты по IP;
- доменный сайт желательно сделать `default_server`, если это единственный сайт на VPS.

Дополнительная проверка:

```bash
curl -I -H 'Host: callparents.ru' http://127.0.0.1
curl -I http://127.0.0.1:3000
curl http://127.0.0.1:3000 | head -20
```

Как читать результат:

- если `127.0.0.1:3000` уже отдает не приложение, проблема в контейнере `web`;
- если `127.0.0.1:3000` отдает приложение, а домен показывает `Welcome to nginx!`, проблема в системном `nginx`.

### 13.3. `http://callparents.ru` открывается, а `https://callparents.ru` нет

Проверь:

```bash
sudo ss -tulpn | grep :443
sudo ufw status
curl -I https://callparents.ru
```

Частые причины:

- сертификат еще не выпущен;
- закрыт `443/tcp`;
- `nginx` не слушает `443`;
- есть проблема с `IPv6` и `AAAA`-записью.

### 13.4. Нет команды `dig`

Установи:

```bash
sudo apt update
sudo apt install -y dnsutils
```

Или используй:

```bash
getent ahosts callparents.ru
curl -4 -I http://callparents.ru
curl -6 -I http://callparents.ru
```

### 13.5. Не работает `TURN` / звонки не соединяются между разными сетями

Проверь по пунктам:

1. В `.env` и `infra/coturn/turnserver.conf` совпадают `TURN_USERNAME` и `TURN_PASSWORD`.
2. В `turnserver.conf` указан `external-ip=<IP_VPS>`.
3. Открыты `3478/tcp`, `3478/udp`, `49160-49200/udp`.
4. В `.env` `TURN_URL` указывает на реальный домен VPS:

```env
TURN_URL=turn:callparents.ru:3478?transport=udp
```

5. Контейнер `coturn` реально поднят:

```bash
docker compose logs -f coturn
```

## 14. Краткий чеклист

1. Домен указывает на VPS.
2. Docker и Nginx установлены.
3. Пользователь имеет доступ к Docker.
4. В `.env` прописаны production-значения.
5. `apps/web/nginx.conf` переведен на `listen 80`.
6. `turnserver.conf` содержит реальный домен, пароль и `external-ip`.
7. `docker-compose.yml` пробрасывает `49160-49200/udp`.
8. Контейнеры подняты через `docker compose up -d --build`.
9. Системный `nginx` проксирует домен в `127.0.0.1:3000`.
10. `Certbot` выпустил сертификат.
11. Открыты `80`, `443`, `3478`, `49160-49200/udp`.
12. Звонок проверен между двумя разными сетями.

## 15. Что можно улучшить позже

- вынести production-конфиг `nginx` и `coturn` в отдельные файлы рядом с dev-конфигами;
- параметризовать `realm` и `coturn user` через переменные окружения;
- добавить отдельный production `docker-compose.prod.yml`;
- автоматизировать разворачивание через `Makefile`, `Ansible` или `Terraform`;
- добавить healthchecks для `web`, `server` и `coturn`.
