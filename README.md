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
