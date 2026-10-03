# MUSCIBAR v6

Музыкальная система бара: гостевой поиск/заказ, очередь, админка, экран зала, DJ-player, Yandex Music search/Wave и fallback Deezer/iTunes.

## Быстрый запуск локально

```bash
npm install
python3 -m pip install -r requirements-yandex.txt
export YANDEX_MUSIC_TOKEN="ВАШ_ТОКЕН"
npm start
```

Открой:

- `/` — гость
- `/admin.html` — админка
- `/hall.html` — экран зала
- `/player` — DJ/player
- `/health` — health check

## Render

Проект уже содержит `Dockerfile` и `render.yaml`. Можно создать Web Service из репозитория и выбрать Docker runtime.

Обязательная переменная:

`YANDEX_MUSIC_TOKEN` — токен аккаунта Яндекс Музыки.

Рекомендуемая:

`ADMIN_TOKEN` — дополнительный секрет для административных запросов.

Получить токен локально:

```bash
python3 -m pip install -r requirements-yandex.txt
python3 yandex_token.py
```

Скрипт использует Device Flow библиотеки `yandex-music`: откроет URL/код, после подтверждения выведет access token. Сам проект библиотеки описывает Device Flow и хранение токена на стороне приложения. Неофициальная библиотека поддерживает поиск, радио/«Моя волна», похожие треки и очереди. 

## Важно про воспроизведение

Yandex API здесь используется как каталог/поиск/рекомендации/Wave. Страница `/player` воспроизводит доступные preview/local tracks через HTML5 Audio. Полноценное коммерческое воспроизведение каталога Яндекс Музыки требует отдельной проверки прав и условий сервиса; неофициальный API не является официальным коммерческим playback SDK.


## Автоматическая очередь Yandex для принятых заказов

В этой версии принятие Yandex-трека в админке сразу отправляет его в live-очередь Ynison **следующим после текущего трека**. Render выступает сервером/пультом, а звук продолжает воспроизводить активное устройство Yandex Music в баре.

Для работы нужен активный Yandex Music-плеер на устройстве бара под тем же аккаунтом, чей OAuth-токен указан в `YANDEX_MUSIC_TOKEN`. Если активного устройства нет или оно не принимает удалённое управление, заказ всё равно остаётся в серверной очереди MUSCIBAR и ошибка добавления фиксируется в истории.

Это использует неофициальный `yandex-music-api`/Ynison; его очередь и remote-control являются reverse-engineered механизмами, а не официальным публичным SDK Yandex.


## Production deployment

This build is intended to run on Render as a Docker web service. It installs Node.js, Python and `yandex-music[ynison]==3.0.0` from the included Dockerfile. Set `YANDEX_MUSIC_TOKEN` in Render.

The guest search uses Yandex as the primary catalog and returns Yandex results directly; preview enrichment is deliberately not on the critical search path. The `/player` and `/player?mode=wave` routes are served as HTML, not downloads.

Accepted Yandex orders are mirrored into the active Ynison device queue as the next item. DJ controls use a persistent Ynison websocket session for pause, resume, next, previous and volume. The audio itself remains on the active Yandex Music device; Render is the control/server layer.
