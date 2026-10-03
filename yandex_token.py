#!/usr/bin/env python3
"""One-time helper: obtain a Yandex Music OAuth token using Device Flow."""
from yandex_music import Client

def show(code):
    print('\nОткрой:', code.verification_url)
    print('Код:', code.user_code)
    print('Подтверди вход в браузере. Жду…\n')

token = Client().device_auth(on_code=show)
print('ACCESS_TOKEN=')
print(token.access_token)
print('\nСкопируй значение в Render → Environment → YANDEX_MUSIC_TOKEN')
