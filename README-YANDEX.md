# MUSCIBAR + Yandex Music

В проект встроен bridge для популярной неофициальной библиотеки `MarshalX/yandex-music-api`.

## Установка

```bash
npm run setup:yandex
```

Если `python3` называется иначе:

```bash
python -m pip install -r requirements-yandex.txt
```

## Авторизация

Можно задать токен Яндекс Музыки переменной окружения:

```bash
YANDEX_MUSIC_TOKEN=... npm start
```

Без токена публичный поиск работает с ограничениями. Авторизованный доступ нужен для личных данных и части возможностей API.

## API MUSCIBAR

- `GET /api/yandex/status` — состояние bridge.
- `GET /api/yandex/search?q=Miyagi` — поиск треков в Яндекс Музыке.
- `GET /api/yandex/similar?id=TRACK_ID:ALBUM_ID` — похожие треки.
- `GET /api/search?q=Miyagi` — единый поиск MUSCIBAR; Яндекс объединяется с Deezer/iTunes.

## Важное

Библиотека MarshalX сама обозначает API как неофициальный и reverse-engineered. Яндекс может менять внутренние методы. Не используйте получение/загрузку аудио через неофициальные методы вопреки условиям сервиса или применимому лицензированию. Для публичного коммерческого воспроизведения в баре отдельно проверьте права на музыкальное использование.
