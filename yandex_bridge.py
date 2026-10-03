#!/usr/bin/env python3
"""Small JSONL bridge for MarshalX/yandex-music-api.
The Node server talks to this process over stdin/stdout.
"""
import json, os, sys, traceback

try:
    from yandex_music import Client
except Exception as exc:
    print(json.dumps({"id": 0, "ok": False, "error": "yandex-music package is not installed: %s" % exc}, ensure_ascii=False), flush=True)
    sys.exit(2)

TOKEN = os.getenv("YANDEX_MUSIC_TOKEN", "").strip()
client = Client(TOKEN or None).init()

def artist_names(track):
    return [a.name for a in (getattr(track, "artists", None) or []) if getattr(a, "name", None)]

def cover_url(track):
    albums = getattr(track, "albums", None) or []
    if not albums:
        return ""
    cover = getattr(albums[0], "cover_uri", "") or ""
    if not cover:
        return ""
    if cover.startswith("http"):
        return cover
    return "https://" + cover.replace("%%", "300x300")

def map_track(track):
    tid = str(getattr(track, "id", ""))
    album_id = ""
    albums = getattr(track, "albums", None) or []
    if albums:
        album_id = str(getattr(albums[0], "id", ""))
    ym_id = tid + (":" + album_id if album_id else "")
    return {
        "id": "ym_" + ym_id.replace(":", "_"),
        "yandexId": ym_id,
        "title": getattr(track, "title", "") or "",
        "artist": ", ".join(artist_names(track)) or "Unknown",
        "cover": cover_url(track),
        "duration": int(getattr(track, "duration_ms", 0) or 0) // 1000,
        "explicit": bool(getattr(track, "content_warning", None)),
        "source": "yandex",
        "url": "https://music.yandex.ru/album/%s/track/%s" % (album_id, tid) if album_id and tid else ""
    }

def do(action, msg):
    if action == "search":
        r = client.search(msg.get("query", ""), type_="track", page=0, nocorrect=False)
        tracks = getattr(getattr(r, "tracks", None), "results", None) or []
        return [map_track(t) for t in tracks[:50]]
    if action == "similar":
        tid = msg.get("yandexId") or msg.get("trackId")
        if not tid:
            return []
        r = client.tracks_similar(tid)
        tracks = getattr(r, "similar_tracks", None) or []
        return [map_track(t) for t in tracks[:30]]
    if action == "track":
        tid = msg.get("yandexId") or msg.get("trackId")
        tracks = client.tracks([tid]) if tid else []
        return map_track(tracks[0]) if tracks else None
    if action == "status":
        return {"installed": True, "authenticated": bool(TOKEN)}
    raise ValueError("Unknown action: " + str(action))

for line in sys.stdin:
    try:
        msg = json.loads(line)
        rid = msg.get("id")
        data = do(msg.get("action"), msg)
        print(json.dumps({"id": rid, "ok": True, "data": data}, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps({"id": msg.get("id") if 'msg' in locals() else 0, "ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
