#!/usr/bin/env python3
import copy, json, os, random, sys, time, uuid
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
    albums = getattr(t, 'albums', None) or []
    album_id = str(getattr(albums[0], 'id', '')) if albums else ''
    return {
        'id': 'ym_' + tid,
        'yandexId': tid,
        'albumId': album_id,
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
    c = Client(TOKEN or None, language='ru')
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


def ynison_enqueue_next(token, track_id, title='', artist='', cover='', album_id=None):
    """Insert a Yandex track immediately after the currently playing item.

    This updates the live Ynison player state, so the active Yandex device keeps
    playing the current song and receives the accepted song as the next item.
    """
    from yandex_music.ynison import YnisonClient
    from yandex_music.ynison.models import ynison_state as ys

    tid = str(track_id or '').replace('ym_', '').strip()
    if not tid:
        raise RuntimeError('Yandex track id is missing')

    with YnisonClient(token, device_title='MUSCIBAR DJ').session(timeout=12.0) as yc:
        state = yc.state
        active = yc.active_device
        if active is None:
            raise RuntimeError('Нет активного устройства Yandex Music')
        if not getattr(active, 'capabilities', None) or not active.capabilities.can_be_player:
            raise RuntimeError('Активное устройство Yandex не может проигрывать музыку')

        player_state = copy.deepcopy(state.player_state)
        pq = player_state.player_queue
        items = list(pq.playable_list or [])
        current = int(pq.current_playable_index)

        new_item = ys.Playable(
            playable_id=tid,
            album_id_optional=str(album_id) if album_id else None,
            playable_type=ys.PlayablePlayableType.TRACK,
            from_='search',
            title=str(title or ('Трек ' + tid))[:200],
            cover_url_optional=(str(cover) if cover else None),
        )

        if not items or current < 0 or current >= len(items):
            # No current item: make the requested track the first/only item.
            pq.playable_list = [new_item]
            pq.current_playable_index = 0
            if getattr(pq, 'shuffle_optional', None):
                pq.shuffle_optional.playable_indices = [0]
        else:
            insert_at = current + 1
            # Keep the track immediately after the current track in playback order.
            pq.playable_list = items[:insert_at] + [new_item] + items[insert_at:]

            shuffle = getattr(pq, 'shuffle_optional', None)
            if shuffle and getattr(shuffle, 'playable_indices', None):
                old_order = list(shuffle.playable_indices)
                new_order = [idx + 1 if idx >= insert_at else idx for idx in old_order]
                try:
                    pos = new_order.index(current)
                except ValueError:
                    pos = len(new_order) - 1
                new_order.insert(pos + 1, insert_at)
                shuffle.playable_indices = new_order

            # Wave queues track the last/live index separately.
            q = getattr(pq, 'queue', None)
            wave = getattr(q, 'wave_queue', None) if q else None
            if wave is not None and getattr(wave, 'live_playable_index', -1) >= insert_at:
                wave.live_playable_index += 1

        pq.version = ys.UpdateVersion(
            device_id=yc.device_id,
            version=random.randint(1, 2**63 - 1),
            timestamp_ms=int(time.time() * 1000),
        )

        request = ys.PutYnisonStateRequest(
            update_player_state=ys.UpdatePlayerState(player_state=player_state),
            player_action_timestamp_ms=int(time.time() * 1000),
            rid=str(uuid.uuid4()),
            activity_interception_type=ys.PutYnisonStateRequestActivityInterceptionType.DO_NOT_INTERCEPT_BY_DEFAULT,
        )
        yc.send(request)

        # Give Ynison a moment to broadcast the updated state back to the remote.
        deadline = time.time() + 1.5
        while time.time() < deadline:
            latest = yc.latest_state
            if latest is not None:
                latest_items = latest.player_state.player_queue.playable_list or []
                if any(str(x.playable_id) == tid for x in latest_items):
                    return {
                        'ok': True,
                        'queued': True,
                        'trackId': tid,
                        'title': title,
                        'artist': artist,
                        'activeDeviceId': active.info.device_id,
                        'activeDevice': active.info.title,
                        'queueIndex': next((i for i, x in enumerate(latest_items) if str(x.playable_id) == tid), None),
                    }
            time.sleep(0.1)

        # The websocket accepted the request even if the echo arrived too late.
        return {
            'ok': True,
            'queued': True,
            'trackId': tid,
            'title': title,
            'artist': artist,
            'activeDeviceId': active.info.device_id,
            'activeDevice': active.info.title,
            'verified': False,
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
        elif action == 'ynison_enqueue_next':
            data = ynison_enqueue_next(TOKEN, req.get('track_id'), req.get('title'), req.get('artist'), req.get('cover'), req.get('album_id'))
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
