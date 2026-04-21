"""
배당 변동 알림 로직
- 누적 0.05 구간마다 알림 (0.10, 0.15, 0.20...)
- 즉시 0.10+ 단발 변동 알림
- 핸디캡 / 오버언더 라인 자체 변경 알림
"""

from db import alert_sent, save_alert

CUMUL_START   = 0.10   # 누적 알림 시작
CUMUL_STEP    = 0.05   # 구간 간격
INSTANT_THRESH = 0.10  # 즉시 변동 임계값


def _diff(a, b) -> float | None:
    """두 배당값의 절대 변동폭 (None이면 비교 불가)"""
    if a is None or b is None:
        return None
    return abs(float(a) - float(b))


def _cumul_thresholds_hit(diff: float) -> list[str]:
    """변동폭에 해당하는 미발송 누적 구간 목록 반환"""
    hits = []
    level = CUMUL_START
    while level <= diff + 1e-9:
        hits.append(f"{level:.2f}")
        level = round(level + CUMUL_STEP, 2)
    return hits


def check_alerts(game: dict, opening: dict, prev: dict) -> list[dict]:
    """
    game    : 현재 스냅샷
    opening : 오프닝 라인
    prev    : 직전 스냅샷 (없으면 None)
    반환: [{"type": ..., "msg": ...}, ...]
    """
    mid = game["matchup_id"]
    label = f"[{game['league']}] {game['away']} @ {game['home']}"
    alerts = []

    # ── 누적 알림 필드 정의 ──────────────────────────────
    cumul_fields = [
        ("ml_home",  "ML 홈"),
        ("ml_away",  "ML 원정"),
        ("sp_home",  "핸디캡 홈"),
        ("sp_away",  "핸디캡 원정"),
        ("ou_over",  "오버"),
        ("ou_under", "언더"),
    ]

    for field, name in cumul_fields:
        diff = _diff(game.get(field), opening.get(field))
        if diff is None:
            continue
        direction = "▼" if float(game[field]) < float(opening[field]) else "▲"
        for thresh in _cumul_thresholds_hit(diff):
            atype = f"cumul_{field}"
            if not alert_sent(mid, atype, thresh):
                save_alert(mid, atype, thresh)
                alerts.append({
                    "type": "누적",
                    "msg": (
                        f"{label}\n"
                        f"📊 {name} 누적 {direction}{thresh} 변동\n"
                        f"오프닝 {opening[field]:.2f} → 현재 {game[field]:.2f}"
                    )
                })

    # ── 즉시 변동 알림 ────────────────────────────────────
    if prev:
        instant_fields = cumul_fields
        for field, name in instant_fields:
            diff = _diff(game.get(field), prev.get(field))
            if diff is None or diff < INSTANT_THRESH:
                continue
            direction = "▼" if float(game[field]) < float(prev[field]) else "▲"
            atype = f"instant_{field}"
            # 즉시 알림은 동일 임계값 재발송 허용 (시간 기준으로 자연 억제됨)
            save_alert(mid, atype, f"{diff:.2f}")
            alerts.append({
                "type": "즉시",
                "msg": (
                    f"{label}\n"
                    f"⚡ {name} 즉시 {direction}{diff:.2f} 급변\n"
                    f"직전 {prev[field]:.2f} → 현재 {game[field]:.2f}"
                )
            })

    # ── 라인 자체 변경 알림 ───────────────────────────────
    # 핸디캡 라인
    if (game.get("sp_pts") is not None and opening.get("sp_pts") is not None
            and game["sp_pts"] != opening["sp_pts"]):
        atype = "line_sp"
        if not alert_sent(mid, atype, str(game["sp_pts"])):
            save_alert(mid, atype, str(game["sp_pts"]))
            alerts.append({
                "type": "라인변경",
                "msg": (
                    f"{label}\n"
                    f"🔄 핸디캡 라인 변경\n"
                    f"오프닝 {opening['sp_pts']:+.1f} → 현재 {game['sp_pts']:+.1f}"
                )
            })

    # 오버언더 라인
    if (game.get("ou_pts") is not None and opening.get("ou_pts") is not None
            and game["ou_pts"] != opening["ou_pts"]):
        atype = "line_ou"
        if not alert_sent(mid, atype, str(game["ou_pts"])):
            save_alert(mid, atype, str(game["ou_pts"]))
            alerts.append({
                "type": "라인변경",
                "msg": (
                    f"{label}\n"
                    f"🔄 오버언더 라인 변경\n"
                    f"오프닝 {opening['ou_pts']:.1f} → 현재 {game['ou_pts']:.1f}"
                )
            })

    return alerts
