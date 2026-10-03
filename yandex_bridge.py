#!/usr/bin/env python3
import json, os, sys
from yandex_music import Client

TOKEN = os.getenv('YANDEX_MUSIC_TOKEN', '').strip()


def cover_url(track):
    c = getattr(track, 'cover_uri', '') or ''
    if c:
        return 'https://' + c.replace('%%', '300x300')
    return ''


def map_track(t):
    artists = getattr(t, 'artists', None) or []
    artist = ', '.join((getattr(a, 'name', '') or '') for a in artists if getattr(a, 'name', None)) or 'Unknown'
    duration = int((getattr(t, 'duration_ms', 0) or 0) / 1000)
    tid = str(getattr(t, 'id', ''))
    return {
        'id': 'ym_' + tid,
        'yandexId': tid,
        'title': getattr(t, 'title', '') or 'Unknown',
        'artist': artist,
        'cover': cover_url(t),
        'duration': duration,
        'preview': '',
        'explicit': bool(getattr(t, 'explicit', False)),
        'source': 'yandex',
        'local': False,
    }


def client():
    c = Client(TOKEN or None, language='ru_RU')
    return c.init()


def search(c, q):
    result = c.search(q, type_='all', page=0)
    out = []
    tracks = getattr(getattr(result, 'tracks', None), 'results', None) or []
    for t in tracks[:50]:
        out.append(map_track(t))
    return out


def similar(c, track_id):
    obj = c.tracks_similar(str(track_id))
    out = []
    for t in (getattr(obj, 'similar_tracks', None) or [])[:30]:
        out.append(map_track(t))
    return out


def wave(c, seed, queue=None):
    seeds = seed if isinstance(seed, list) else [seed]
    session = c.rotor_session_new(seeds, queue=queue or [], include_tracks_in_response=True, interactive=True)
    out = []
    for t in (getattr(session, 'sequence', None) or []):
        track = getattr(t, 'track', None)
        if track:
            out.append(map_track(track))
    return out

def ynison_state(token):
    from yandex_music.ynison import simple
    state = simple.get_state(token)
    active = simple.get_active_device(token)
    current = simple.get_current_track(token)
    return {
        'ok': True,
        'activeDevice': getattr(getattr(active, 'info', None), 'title', None) if active else None,
        'activeDeviceId': getattr(active, 'device_id', None) if active else None,
        'current': {
            'id': getattr(current, 'playable_id', None),
            'title': getattr(current, 'title', None),
            'duration': int((getattr(current, 'duration_ms', 0) or 0) / 1000),
        } if current else None,
        'devices': [
            {
                'id': getattr(d, 'device_id', None),
                'title': getattr(getattr(d, 'info', None), 'title', None),
                'active': bool(active and getattr(d, 'device_id', None) == getattr(active, 'device_id', None)),
            }
            for d in (getattr(state, 'devices', None) or [])
        ],
    }

def ynison_control(token, action, volume=None):
    from yandex_music.ynison import simple
    if action == 'pause': simple.pause(token)
    elif action == 'resume': simple.resume(token)
    elif action == 'next': simple.next_track(token)
    elif action == 'previous': simple.previous_track(token)
    elif action == 'volume': simple.set_volume(token, float(volume))
    else: raise RuntimeError('Unknown Ynison action')
    return ynison_state(token)


def main():
    try:
        req = json.loads(sys.stdin.read() or '{}')
        action = req.get('action')
        if not TOKEN:
            raise RuntimeError('YANDEX_MUSIC_TOKEN is not set')
        c = client()
        if action == 'search':
            data = search(c, str(req.get('q', '')).strip()[:100])
        elif action == 'similar':
            data = similar(c, req.get('track_id'))
        elif action == 'wave':
            data = wave(c, req.get('seed', 'user:onyourwave'), req.get('queue') or [])
        elif action == 'ynison_state':
            data = ynison_state(TOKEN)
        elif action == 'ynison_control':
            data = ynison_control(TOKEN, str(req.get('action', '')), req.get('volume'))
        elif action == 'status':
            me = getattr(c, 'me', None)
            account = getattr(me, 'account', None)
            data = {'ok': True, 'login': getattr(account, 'login', None), 'uid': getattr(account, 'uid', None)}
        else:
            raise RuntimeError('Unknown action')
        print(json.dumps({'ok': True, 'data': data}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        sys.exit(0)

if __name__ == '__main__':
    main()
