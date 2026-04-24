import { useState, useEffect } from 'react'
import { supabase } from './supabase'

function isInPast(startsAt) {
  if (!startsAt) return false
  try {
    const m = startsAt.match(/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/)
    if (!m) return false
    const year = new Date().getFullYear()
    const utcMs = Date.UTC(year, parseInt(m[1]) - 1, parseInt(m[2]), parseInt(m[3]) - 9, parseInt(m[4]))
    return utcMs < Date.now()
  } catch { return false }
}

const LEAGUE_FLAGS = {
  MLB: '🇺🇸', KBO: '🇰🇷', NPB: '🇯🇵',
  EPL: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Bundesliga: '🇩🇪', 'Serie A': '🇮🇹',
  'Ligue 1': '🇫🇷', 'La Liga': '🇪🇸',
  'K리그1': '🇰🇷', MLS: '🇺🇸',
  UCL: '🏆', Europa: '🟠', Conference: '🟢',
  NBA: '🇺🇸', NHL: '🇺🇸',
}

const ALL_LEAGUES = [
  'MLB', 'KBO', 'NPB',
  'EPL', 'Bundesliga', 'Serie A', 'Ligue 1', 'La Liga', 'K리그1', 'MLS', 'UCL', 'Europa', 'Conference',
  'NBA', 'NHL',
]

function minsAgo(ts) {
  if (!ts) return null
  try {
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 60000)
    if (diff < 1) return '방금'
    return `${diff}분 전`
  } catch { return null }
}

function hoursUntil(startsAt) {
  if (!startsAt) return null
  try {
    const m = startsAt.match(/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/)
    if (!m) return null
    const year = new Date().getFullYear()
    const utcMs = Date.UTC(year, parseInt(m[1]) - 1, parseInt(m[2]), parseInt(m[3]) - 9, parseInt(m[4]))
    return (utcMs - Date.now()) / 3600000
  } catch { return null }
}

function fmtTime(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return '' }
}

// 마켓·사이드별 샤프 시그널 (①멀티확인 ②시간가중 ④연속하락 포함)
function sharpSignals(game) {
  const op = game.opening || {}
  const alerts = game.recentAlerts || []
  const hasSteamMl = alerts.some(a => a.type === 'instant_ml')
  const hasSteamSp = alerts.some(a => a.type === 'instant_sp')
  const hasSteamOu = alerts.some(a => a.type === 'instant_ou')
  const hasLineSp  = alerts.some(a => a.type === 'line_sp')
  const hasLineOu  = alerts.some(a => a.type === 'line_ou')

  // ② 시간 가중: 경기 0-4h 이내이면 +1
  const hours = hoursUntil(game.starts_at)
  const timeBoost = (hours !== null && hours >= 0 && hours <= 4) ? 1 : 0

  const signals = []

  function calcScore(drop, hasSteam, hasLine) {
    let base
    if ((hasLine && hasSteam) || drop >= 0.20) base = 3
    else if (hasSteam || hasLine || drop >= 0.10) base = 2
    else if (drop >= 0.05) base = 1
    else base = 0
    return Math.min(3, base + timeBoost)
  }

  // ML
  const dropMlHome = (op.ml_home && game.ml_home) ? op.ml_home - game.ml_home : null
  const dropMlAway = (op.ml_away && game.ml_away) ? op.ml_away - game.ml_away : null
  if (dropMlHome !== null || dropMlAway !== null || hasSteamMl) {
    const h = dropMlHome ?? 0, a = dropMlAway ?? 0
    const [label, drop] = h >= a ? [`홈 ML`, h] : [`원정 ML`, a]
    const score = calcScore(drop, hasSteamMl, false)
    if (score > 0) signals.push({ label, drop, score })
  }

  // 핸디 — 기준선이 실제로 변경된 경우에만 방향으로 판단
  if (hasLineSp && op.sp_pts != null && game.sp_pts != null && game.sp_pts !== op.sp_pts) {
    const delta = game.sp_pts - op.sp_pts
    const label = delta < 0 ? '홈 핸디' : '원정 핸디'
    const base = hasSteamSp ? 3 : 2
    signals.push({ label, drop: Math.abs(delta), score: Math.min(3, base + timeBoost) })
  } else {
    const dropSpHome = (op.sp_home && game.sp_home) ? op.sp_home - game.sp_home : null
    const dropSpAway = (op.sp_away && game.sp_away) ? op.sp_away - game.sp_away : null
    if (dropSpHome !== null || dropSpAway !== null || hasSteamSp) {
      const h = dropSpHome ?? 0, a = dropSpAway ?? 0
      const [label, drop] = h >= a ? [`홈 핸디`, h] : [`원정 핸디`, a]
      const score = calcScore(drop, hasSteamSp, false)
      if (score > 0) signals.push({ label, drop, score })
    }
  }

  // O/U — 기준선이 실제로 변경된 경우에만 방향으로 판단
  if (hasLineOu && op.ou_pts != null && game.ou_pts != null && game.ou_pts !== op.ou_pts) {
    const delta = game.ou_pts - op.ou_pts
    const label = delta < 0 ? '언더' : '오버'
    const base = hasSteamOu ? 3 : 2
    signals.push({ label, drop: Math.abs(delta), score: Math.min(3, base + timeBoost) })
  } else {
    const dropOver  = (op.ou_over  && game.ou_over)  ? op.ou_over  - game.ou_over  : null
    const dropUnder = (op.ou_under && game.ou_under) ? op.ou_under - game.ou_under : null
    if (dropOver !== null || dropUnder !== null || hasSteamOu) {
      const o = dropOver ?? 0, u = dropUnder ?? 0
      const [label, drop] = o >= u ? [`오버`, o] : [`언더`, u]
      const score = calcScore(drop, hasSteamOu, false)
      if (score > 0) signals.push({ label, drop, score })
    }
  }

  // ④ 연속 하락 통합
  const streakMap = {
    streak_ml_home: '홈 ML', streak_ml_away: '원정 ML',
    streak_sp_home: '홈 핸디', streak_sp_away: '원정 핸디',
    streak_ou_over: '오버', streak_ou_under: '언더',
  }
  for (const a of alerts) {
    const lbl = streakMap[a.type]
    if (!lbl) continue
    const count = parseInt(a.threshold) || 0
    let sig = signals.find(s => s.label === lbl)
    if (!sig) {
      sig = { label: lbl, drop: 0, score: 0 }
      signals.push(sig)
    }
    sig.score = Math.min(3, sig.score + 1)
    sig.streak = count
  }

  // ① 멀티마켓 확인: ML + 핸디 같은 방향이면 각각 +1
  const mlSig = signals.find(s => s.label.endsWith('ML'))
  const spSig = signals.find(s => s.label.endsWith('핸디'))
  if (mlSig && spSig) {
    const mlHome = mlSig.label.startsWith('홈')
    const spHome = spSig.label.startsWith('홈')
    if (mlHome === spHome) {
      mlSig.score = Math.min(3, mlSig.score + 1)
      spSig.score = Math.min(3, spSig.score + 1)
      mlSig.multi = true
      spSig.multi = true
    }
  }

  return signals.filter(s => s.score > 0)
}

function SharpSignals({ signals }) {
  if (!signals || signals.length === 0) return null
  return (
    <div className="flex gap-2 flex-wrap">
      {signals.map(s => {
        const color = s.score === 3 ? 'text-red-400' : s.score === 2 ? 'text-yellow-400' : 'text-blue-400'
        return (
          <div key={s.label} className="flex items-center gap-0.5 bg-gray-700 rounded-lg px-2 py-1">
            <span className="text-sm font-semibold text-gray-200">{s.label}</span>
            <span className={`text-sm font-bold ${color}`}> {'★'.repeat(s.score)}{'☆'.repeat(3 - s.score)}</span>
            {s.streak ? <span className="text-xs text-orange-400 ml-1">{s.streak}연속</span> : null}
            {s.multi ? <span className="text-xs text-purple-400 ml-1">멀티</span> : null}
          </div>
        )
      })}
    </div>
  )
}

// highlight: null | 'blue' | 'red'
function OddsTag({ label, value, openValue, highlight }) {
  const diff = (value != null && openValue != null)
    ? parseFloat((value - openValue).toFixed(3)) : null
  const hasDiff = diff !== null && Math.abs(diff) >= 0.005
  const bg = highlight === 'red' ? 'bg-red-600' : highlight === 'blue' ? 'bg-blue-600' : 'bg-gray-700'
  return (
    <div className={`flex-1 flex flex-col items-center py-2 rounded-lg ${bg}`}>
      <span className="text-xs text-gray-300">{label}</span>
      <span className={`text-base font-bold leading-tight ${highlight ? 'text-white' : 'text-gray-100'}`}>
        {value?.toFixed(2) ?? '-'}
      </span>
      {/* ② 오프닝 대비 낙폭 — 더 크고 선명하게 */}
      {hasDiff ? (
        <span className={`text-sm font-bold ${diff > 0 ? 'text-green-400' : 'text-red-300'}`}>
          {diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)}
        </span>
      ) : <span className="text-sm opacity-0">-</span>}
    </div>
  )
}

function SharpBadge({ alerts, game }) {
  if (!alerts || alerts.length === 0) return null
  const op = game.opening || {}
  const fmtPts = v => v != null ? `${v >= 0 ? '+' : ''}${v}` : '?'
  return (
    <div className="flex gap-1 flex-wrap mb-2">
      {alerts.map(({ type, threshold }) => {
        let label, detail
        switch (type) {
          case 'instant_ml': label = '⚡ML'; detail = threshold ? parseFloat(threshold).toFixed(2) : ''; break
          case 'instant_sp': label = '⚡핸디'; detail = threshold ? parseFloat(threshold).toFixed(2) : ''; break
          case 'instant_ou': label = '⚡O/U'; detail = threshold ? parseFloat(threshold).toFixed(2) : ''; break
          case 'line_sp':
            if (op.sp_pts == null || game.sp_pts == null || op.sp_pts === game.sp_pts) return null
            label = '🔄핸디'; detail = `${fmtPts(op.sp_pts)}→${fmtPts(game.sp_pts)}`; break
          case 'line_ou':
            if (op.ou_pts == null || game.ou_pts == null || op.ou_pts === game.ou_pts) return null
            label = '🔄O/U'; detail = `${op.ou_pts}→${game.ou_pts}`; break
          case 'streak_ml_home':  label = '📉홈 ML';    detail = threshold ? `${threshold}연속` : ''; break
          case 'streak_ml_away':  label = '📉원정 ML';  detail = threshold ? `${threshold}연속` : ''; break
          case 'streak_sp_home':  label = '📉홈 핸디';  detail = threshold ? `${threshold}연속` : ''; break
          case 'streak_sp_away':  label = '📉원정 핸디'; detail = threshold ? `${threshold}연속` : ''; break
          case 'streak_ou_over':  label = '📉오버';     detail = threshold ? `${threshold}연속` : ''; break
          case 'streak_ou_under': label = '📉언더';     detail = threshold ? `${threshold}연속` : ''; break
          default: label = type; detail = threshold || ''
        }
        return (
          <span key={type} className="text-sm px-3 py-1 rounded-lg bg-yellow-500 text-gray-900 font-bold">
            {label}{detail ? ` ${detail}` : ''}
          </span>
        )
      })}
    </div>
  )
}

// ③ SVG 차트
function OddsChart({ snapshots, mktTab, isSoccer }) {
  const data = [...snapshots].reverse() // 시간순
  if (data.length < 2) return null

  const W = 300, H = 80, PX = 8, PY = 8

  const series = mktTab === 'ml'
    ? [
        { values: data.map(s => s.ml_home),  color: '#60a5fa', label: '홈' },
        { values: data.map(s => s.ml_away),  color: '#f87171', label: '원정' },
        ...(isSoccer ? [{ values: data.map(s => s.ml_draw), color: '#9ca3af', label: '무' }] : []),
      ]
    : mktTab === 'sp'
    ? [
        { values: data.map(s => s.sp_home), color: '#60a5fa', label: '홈' },
        { values: data.map(s => s.sp_away), color: '#f87171', label: '원정' },
      ]
    : [
        { values: data.map(s => s.ou_over),  color: '#34d399', label: '오버' },
        { values: data.map(s => s.ou_under), color: '#fbbf24', label: '언더' },
      ]

  const allVals = series.flatMap(s => s.values).filter(v => v != null)
  if (allVals.length < 2) return null
  const lo = Math.min(...allVals), hi = Math.max(...allVals)
  const range = hi - lo || 0.1

  function path(values) {
    const pts = values.map((v, i) => {
      if (v == null) return null
      const x = PX + (i / (values.length - 1)) * (W - PX * 2)
      const y = PY + (1 - (v - lo) / range) * (H - PY * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).filter(Boolean)
    return pts.length < 2 ? null : `M ${pts.join(' L ')}`
  }

  // Y축 레이블 (최소/최대)
  const yMin = lo.toFixed(2), yMax = hi.toFixed(2)

  return (
    <div className="mb-3 bg-gray-800 rounded-lg p-2">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 80 }}>
          {/* 그리드 */}
          {[0.25, 0.5, 0.75].map(t => (
            <line key={t} x1={PX} x2={W - PX}
              y1={PY + t * (H - PY * 2)} y2={PY + t * (H - PY * 2)}
              stroke="#374151" strokeWidth="1" />
          ))}
          {/* 라인 */}
          {series.map((s, i) => {
            const d = path(s.values)
            return d ? <path key={i} d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /> : null
          })}
        </svg>
        {/* Y축 레이블 */}
        <div className="absolute top-1 right-1 text-xs text-gray-500">{yMax}</div>
        <div className="absolute bottom-1 right-1 text-xs text-gray-500">{yMin}</div>
      </div>
      {/* 범례 */}
      <div className="flex gap-3 justify-center mt-1">
        {series.map((s, i) => (
          <div key={i} className="flex items-center gap-1">
            <div className="w-4 h-0.5 rounded" style={{ backgroundColor: s.color }} />
            <span className="text-xs text-gray-400">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// 배당 흐름 모달
function HistoryModal({ game, onClose }) {
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading]     = useState(true)
  const [mktTab, setMktTab]       = useState('ml')
  const isSoccer = game.sport === 'soccer'

  useEffect(() => {
    async function load() {
      const res = await supabase
        .from('snapshots')
        .select('ts,ml_home,ml_away,ml_draw,sp_pts,sp_home,sp_away,ou_pts,ou_over,ou_under')
        .eq('matchup_id', game.matchup_id)
        .order('id', { ascending: true })
        .limit(500)
      const rows = (res.data || []).filter(r => r.ml_home != null)
      const changed = rows.filter((r, i) => {
        if (i === 0) return true
        const p = rows[i - 1]
        return ['ml_home','ml_away','ml_draw','sp_pts','sp_home','sp_away','ou_pts','ou_over','ou_under']
          .some(k => r[k] !== p[k])
      })
      setSnapshots(changed.reverse())
      setLoading(false)
    }
    load()
  }, [game.matchup_id])

  const flag = LEAGUE_FLAGS[game.league] || '🏟'

  function diffCell(cur, prev) {
    if (cur == null) return <span className="text-gray-500">-</span>
    const d = prev != null ? parseFloat((cur - prev).toFixed(3)) : null
    const show = d !== null && Math.abs(d) >= 0.005
    return (
      <span className={show ? (d > 0 ? 'text-green-400 font-bold' : 'text-red-400 font-bold') : 'text-gray-100'}>
        {cur.toFixed(2)}{show ? (d > 0 ? ' ▲' : ' ▼') : ''}
      </span>
    )
  }

  const mktTabs = [
    { key: 'ml', label: '승패' },
    ...(snapshots.some(s => s.sp_pts != null) ? [{ key: 'sp', label: '핸디' }] : []),
    ...(snapshots.some(s => s.ou_pts != null) ? [{ key: 'ou', label: 'O/U' }] : []),
  ]

  return (
    <div className="fixed inset-0 z-50 flex flex-col" onClick={onClose}>
      <div className="flex-1 bg-black/60" />
      <div
        className="bg-gray-900 rounded-t-2xl px-4 pt-4 pb-8 max-h-[82vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-gray-600 rounded-full mx-auto mb-4" />

        <div className="mb-3">
          <div className="text-sm text-gray-400 mb-1">{flag} {game.league} · {game.starts_at?.replace(' KST','')}</div>
          <div className="text-white font-bold text-lg mb-1">{game.home} <span className="text-gray-500 font-normal text-base">vs</span> {game.away}</div>
          <SharpSignals signals={sharpSignals(game)} />
        </div>

        <div className="flex gap-2 mb-3">
          {mktTabs.map(t => (
            <button key={t.key} onClick={() => setMktTab(t.key)}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors
                ${mktTab === t.key ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-center text-gray-500 py-10">불러오는 중...</div>
        ) : snapshots.length === 0 ? (
          <div className="text-center text-gray-500 py-10">데이터 없음</div>
        ) : (
          <div className="overflow-y-auto flex-1">
            {/* ③ 차트 */}
            <OddsChart snapshots={snapshots} mktTab={mktTab} isSoccer={isSoccer} />

            {/* 테이블 */}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 border-b border-gray-700">
                  <th className="text-left py-2 pr-2">시간</th>
                  {mktTab === 'ml' && <>
                    <th className="text-right py-2 px-2">홈</th>
                    {isSoccer && <th className="text-right py-2 px-2">무</th>}
                    <th className="text-right py-2 px-2">원정</th>
                  </>}
                  {mktTab === 'sp' && <>
                    <th className="text-right py-2 px-2">기준선</th>
                    <th className="text-right py-2 px-2">홈</th>
                    <th className="text-right py-2 px-2">원정</th>
                  </>}
                  {mktTab === 'ou' && <>
                    <th className="text-right py-2 px-2">기준선</th>
                    <th className="text-right py-2 px-2">오버</th>
                    <th className="text-right py-2 px-2">언더</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s, i) => {
                  const prev = snapshots[i + 1]
                  return (
                    <tr key={i} className="border-b border-gray-800">
                      <td className="py-2 pr-2 text-gray-400 whitespace-nowrap">{fmtTime(s.ts)}</td>
                      {mktTab === 'ml' && <>
                        <td className="text-right py-2 px-2">{diffCell(s.ml_home, prev?.ml_home)}</td>
                        {isSoccer && <td className="text-right py-2 px-2">{diffCell(s.ml_draw, prev?.ml_draw)}</td>}
                        <td className="text-right py-2 px-2">{diffCell(s.ml_away, prev?.ml_away)}</td>
                      </>}
                      {mktTab === 'sp' && <>
                        <td className="text-right py-2 px-2 text-gray-300">{s.sp_pts != null ? (s.sp_pts >= 0 ? '+' : '') + s.sp_pts : '-'}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.sp_home, prev?.sp_home)}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.sp_away, prev?.sp_away)}</td>
                      </>}
                      {mktTab === 'ou' && <>
                        <td className="text-right py-2 px-2 text-gray-300">{s.ou_pts ?? '-'}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.ou_over, prev?.ou_over)}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.ou_under, prev?.ou_under)}</td>
                      </>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function GameCard({ game, onClick }) {
  const flag     = LEAGUE_FLAGS[game.league] || '🏟'
  const isSoccer = game.sport === 'soccer'
  const op       = game.opening || {}
  const signals  = sharpSignals(game)

  function dropHighlight(curA, openA, curB, openB) {
    if (curA == null || openA == null || curB == null || openB == null) return [null, null]
    const dA = curA - openA, dB = curB - openB
    if (dA === dB) return [null, null]
    const favA = dA < dB
    const drop = favA ? Math.abs(dA) : Math.abs(dB)
    const color = drop >= 0.10 ? 'red' : 'blue'
    return favA ? [color, null] : [null, color]
  }

  const [mlHomeHL, mlAwayHL]  = dropHighlight(game.ml_home, op.ml_home, game.ml_away, op.ml_away)
  const [spHomeHL, spAwayHL]  = dropHighlight(game.sp_home, op.sp_home, game.sp_away, op.sp_away)
  const [ouOverHL, ouUnderHL] = dropHighlight(game.ou_over, op.ou_over, game.ou_under, op.ou_under)

  return (
    <div className="bg-gray-800 rounded-xl p-4 mb-3 border border-gray-700 cursor-pointer active:opacity-80" onClick={onClick}>
      {/* 리그 */}
      <div className="mb-1">
        <span className="text-base font-bold text-gray-200">{flag} {game.league}</span>
      </div>

      {/* 팀명 */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span className="text-white font-bold text-xl">{game.home}</span>
        <span className="text-gray-500 text-lg font-normal">vs</span>
        <span className="text-white font-bold text-xl">{game.away}</span>
      </div>

      {/* 샤프 시그널 */}
      <SharpBadge alerts={game.recentAlerts} game={game} />

      {/* 마켓별 샤프 점수 */}
      {signals.length > 0 && <div className="mb-2"><SharpSignals signals={signals} /></div>}

      {/* 경기시간 + 기준 */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-base font-semibold text-gray-300">⏰ {game.starts_at?.replace(' KST','')}</span>
        {minsAgo(game.ts) && <span className="text-xs text-gray-500">{minsAgo(game.ts)} 기준</span>}
      </div>

      {/* 승패 */}
      <div className="flex gap-1.5 mb-1.5">
        <OddsTag label="홈" value={game.ml_home} openValue={op.ml_home} highlight={mlHomeHL} />
        {isSoccer && game.ml_draw && <OddsTag label="무" value={game.ml_draw} openValue={op.ml_draw} />}
        <OddsTag label="원정" value={game.ml_away} openValue={op.ml_away} highlight={mlAwayHL} />
      </div>

      {/* 핸디 */}
      {game.sp_pts != null && (
        <div className="flex gap-1.5 mb-1.5">
          <OddsTag label={`홈 ${game.sp_pts >= 0 ? '+' : ''}${game.sp_pts}`} value={game.sp_home} openValue={op.sp_home} highlight={spHomeHL} />
          <OddsTag label={`원정 ${(-game.sp_pts) >= 0 ? '+' : ''}${-game.sp_pts}`} value={game.sp_away} openValue={op.sp_away} highlight={spAwayHL} />
        </div>
      )}

      {/* O/U */}
      {game.ou_pts != null && (
        <div className="flex gap-1.5">
          <OddsTag label={`오버 ${game.ou_pts}`} value={game.ou_over} openValue={op.ou_over} highlight={ouOverHL} />
          <OddsTag label={`언더 ${game.ou_pts}`} value={game.ou_under} openValue={op.ou_under} highlight={ouUnderHL} />
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [games, setGames]           = useState([])
  const [tab, setTab]               = useState('all')
  const [pastLeague, setPastLeague] = useState('all')
  const [loading, setLoading]       = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [selected, setSelected]     = useState(null)

  useEffect(() => { fetchGames() }, [])

  async function fetchGames() {
    setLoading(true)
    const [linesRes, openingsRes, alertsRes] = await Promise.all([
      supabase.from('latest_lines').select('*').order('starts_at', { ascending: true }),
      supabase.from('opening_lines').select('matchup_id,ml_home,ml_away,ml_draw,sp_pts,sp_home,sp_away,ou_pts,ou_over,ou_under'),
      supabase.from('alerts').select('matchup_id,alert_type,threshold').order('id', { ascending: false }).limit(500),
    ])
    const openingsMap = Object.fromEntries((openingsRes.data || []).map(o => [o.matchup_id, o]))
    const currentIds  = new Set((linesRes.data || []).map(g => g.matchup_id))
    const alertsMap   = {}
    for (const a of (alertsRes.data || [])) {
      if (!currentIds.has(a.matchup_id)) continue
      if (!alertsMap[a.matchup_id]) alertsMap[a.matchup_id] = {}
      const cur = alertsMap[a.matchup_id][a.alert_type]
      if (!cur) {
        alertsMap[a.matchup_id][a.alert_type] = { type: a.alert_type, threshold: a.threshold }
      } else if (a.alert_type.startsWith('instant_') && parseFloat(a.threshold) > parseFloat(cur.threshold)) {
        cur.threshold = a.threshold
      } else if (a.alert_type.startsWith('streak_') && parseInt(a.threshold) > parseInt(cur.threshold)) {
        cur.threshold = a.threshold
      }
    }
    const merged = (linesRes.data || []).map(g => ({
      ...g,
      opening:      openingsMap[g.matchup_id] || null,
      recentAlerts: alertsMap[g.matchup_id] ? Object.values(alertsMap[g.matchup_id]) : [],
    }))
    setGames(merged)
    setLastUpdate(new Date().toLocaleTimeString('ko-KR'))
    setLoading(false)
  }

  const isPastView = tab === 'past'
  const filtered = games.filter(g => {
    const past = isInPast(g.starts_at)
    if (isPastView) {
      if (!past) return false
      if (pastLeague !== 'all' && g.league !== pastLeague) return false
      return true
    }
    if (past) return false
    if (tab !== 'all' && g.league !== tab) return false
    return true
  })
  const sorted = [...filtered].sort((a, b) =>
    isPastView ? (b.starts_at > a.starts_at ? 1 : -1) : (a.starts_at > b.starts_at ? 1 : -1)
  )
  const activeLegues = ALL_LEAGUES.filter(l => games.some(g => g.league === l && !isInPast(g.starts_at)))
  const pastLeagues  = ALL_LEAGUES.filter(l => games.some(g => g.league === l && isInPast(g.starts_at)))

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-700 px-4 pt-4 pb-3">
        <div className="flex justify-between items-center mb-3">
          <h1 className="text-2xl font-bold">⚡ 샤프시그널</h1>
          <button onClick={fetchGames} className="text-sm text-gray-400 active:text-white">
            {lastUpdate ? `갱신 ${lastUpdate}` : '새로고침'}
          </button>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          <button onClick={() => setTab('all')} className={`px-4 py-2 rounded-full text-base font-semibold whitespace-nowrap transition-colors ${tab === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}>전체</button>
          {activeLegues.map(l => (
            <button key={l} onClick={() => setTab(l)} className={`px-4 py-2 rounded-full text-base font-semibold whitespace-nowrap transition-colors ${tab === l ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}>
              {LEAGUE_FLAGS[l]} {l}
            </button>
          ))}
          <button onClick={() => { setTab('past'); setPastLeague('all') }} className={`px-4 py-2 rounded-full text-base font-semibold whitespace-nowrap transition-colors ${tab === 'past' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}>🕐 지난경기</button>
        </div>
        {isPastView && (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide mt-2">
            <button onClick={() => setPastLeague('all')} className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap ${pastLeague === 'all' ? 'bg-gray-500 text-white' : 'bg-gray-700 text-gray-300'}`}>전체</button>
            {pastLeagues.map(l => (
              <button key={l} onClick={() => setPastLeague(l)} className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap ${pastLeague === l ? 'bg-gray-500 text-white' : 'bg-gray-700 text-gray-300'}`}>
                {LEAGUE_FLAGS[l]} {l}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-4 py-4">
        {loading ? (
          <div className="text-center text-gray-500 py-20">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-gray-500 py-20">경기 없음</div>
        ) : (
          sorted.map(g => <GameCard key={g.matchup_id} game={g} onClick={() => setSelected(g)} />)
        )}
      </div>

      {selected && <HistoryModal game={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
