import { useState, useEffect, useMemo } from 'react'
import { supabase } from './supabase'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'

const ADMIN_EMAIL  = import.meta.env.VITE_ADMIN_EMAIL
const API_BASE     = Capacitor.isNativePlatform() ? 'https://pinnacle-bot.vercel.app' : ''
const TRIAL_DAYS   = 7
const BANK_INFO    = { bank: '케이뱅크', account: '100201371989', holder: '김형인', kakao: 'sharpsignal' }
const PLANS        = [
  { label: '1일',  days: 1,  price: '5,500원' },
  { label: '10일', days: 10, price: '55,000원' },
  { label: '30일', days: 30, price: '150,000원' },
]

function getDeviceId() {
  let id = localStorage.getItem('sharp_device_id')
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('sharp_device_id', id) }
  return id
}

function trialDaysLeft(sub) {
  if (!sub?.trial_started_at) return 0
  const end = new Date(sub.trial_started_at)
  end.setDate(end.getDate() + TRIAL_DAYS)
  return Math.max(0, Math.ceil((end - Date.now()) / 86400000))
}

// ── 구글 로그인 화면 ──────────────────────────────────────────
function AuthScreen() {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  async function signInWithGoogle() {
    setLoading(true)
    setError('')
    const isNative = Capacitor.isNativePlatform()
    const redirectTo = isNative
      ? 'com.sharpsignal.app://auth-callback'
      : `${window.location.origin}`

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: isNative },
    })
    if (error) { setError(error.message); setLoading(false); return }
    if (isNative && data?.url) {
      await Browser.open({ url: data.url, presentationStyle: 'fullscreen' })
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-6"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">샤프시그널</h1>
          <p className="text-slate-400 text-sm mt-2">실시간 라인 모니터</p>
        </div>
        <div className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100">
          <button
            onClick={signInWithGoogle}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 py-3.5 bg-white border-2 border-slate-200 rounded-2xl text-sm font-semibold text-slate-700 hover:bg-slate-50 active:bg-slate-100 transition-colors disabled:opacity-50">
            <svg width="20" height="20" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            {loading ? '로그인 중...' : '구글로 시작하기'}
          </button>
          {error && <p className="text-xs text-rose-500 text-center mt-3">{error}</p>}
        </div>
      </div>
    </div>
  )
}

// ── 잠금 박스 ────────────────────────────────────────────────
function LockBox({ onUnlock, label, isGuest = false }) {
  const defaultLabel = isGuest ? '로그인 후 이용 가능합니다' : '구독 후 이용 가능합니다'
  const btnLabel = isGuest ? '로그인' : '잠금 해제'
  return (
    <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 flex flex-col items-center gap-2">
      <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round" className="text-slate-500">
          <rect x="3" y="11" width="18" height="11" rx="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <div className="text-xs text-slate-500 text-center">{label ?? defaultLabel}</div>
      <button onClick={onUnlock}
        className="text-xs font-semibold text-indigo-600 bg-white border border-indigo-200 px-4 py-1.5 rounded-full">
        {btnLabel}
      </button>
    </div>
  )
}

// ── 업그레이드 모달 (바텀시트) ────────────────────────────────
function UpgradeModal({ onClose }) {
  const [selected, setSelected] = useState(null)
  const [copied, setCopied]     = useState(false)

  function copyAccount() {
    navigator.clipboard?.writeText(BANK_INFO.account)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col" onClick={onClose}>
      <div className="flex-1 bg-slate-900/40 backdrop-blur-sm" />
      <div className="relative bg-white rounded-t-3xl px-4 pt-4 max-h-[85vh] overflow-y-auto"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 24px)' }}
        onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mb-4" />
        <button onClick={onClose}
          className="absolute right-4 top-4 w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </button>

        <h2 className="text-lg font-bold text-slate-900 mb-4">이용권 구독</h2>

        {/* 이용권 선택 */}
        <div className="space-y-2 mb-4">
          {PLANS.map(plan => (
            <button key={plan.days} onClick={() => setSelected(plan)}
              className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${
                selected?.days === plan.days ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 bg-slate-50'
              }`}>
              <span className={`font-semibold text-sm ${selected?.days === plan.days ? 'text-indigo-700' : 'text-slate-700'}`}>{plan.label}</span>
              <span className={`font-bold ${selected?.days === plan.days ? 'text-indigo-600' : 'text-slate-900'}`}>{plan.price}</span>
            </button>
          ))}
        </div>

        {/* 입금 안내 */}
        <div className="bg-slate-50 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-slate-400">{BANK_INFO.bank}</span>
            <button onClick={copyAccount} className="text-xs text-indigo-600 font-semibold">
              {copied ? '복사됨 ✓' : '복사'}
            </button>
          </div>
          <div className="text-base font-bold text-slate-900 mb-0.5">{BANK_INFO.account}</div>
          <div className="text-sm text-slate-500">예금주: {BANK_INFO.holder}</div>
          {selected && (
            <div className="mt-3 bg-indigo-50 rounded-xl px-3 py-2 text-center">
              <span className="text-sm font-bold text-indigo-700">{selected.price} 입금 후 카카오톡으로 연락 주세요</span>
            </div>
          )}
          <div className="text-xs text-slate-400 text-center mt-3 leading-relaxed">
            카카오톡 <span className="font-semibold text-slate-600">{BANK_INFO.kakao}</span> 으로
            이메일과 입금자명 알려주시면 24시간 이내 처리됩니다
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 무료체험 시작 모달 ────────────────────────────────────────
function TrialPromptModal({ onStart, onDecline }) {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  async function handleStart() {
    setLoading(true)
    setError('')
    const deviceId = getDeviceId()
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`${API_BASE}/api/trial/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ deviceId }),
    })
    const json = await res.json()
    if (json.error === 'device_already_used') {
      setError('이미 다른 계정에서 체험이 사용된 기기입니다.')
      setLoading(false)
      return
    }
    setLoading(false)
    onStart()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6 bg-slate-900/50 backdrop-blur-sm">
      <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-xl">
        <div className="text-center mb-5">
          <div className="w-14 h-14 rounded-full bg-indigo-50 flex items-center justify-center mx-auto mb-3">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
            </svg>
          </div>
          <h2 className="text-lg font-bold text-slate-900">7일 무료 체험</h2>
          <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">
            모든 기능을 7일간 무료로 체험하실 수 있습니다.<br/>지금 시작하시겠습니까?
          </p>
        </div>
        {error && <p className="text-xs text-rose-500 text-center mb-3">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onDecline}
            className="flex-1 py-3 rounded-2xl border border-slate-200 text-sm font-semibold text-slate-500">
            나중에
          </button>
          <button onClick={handleStart} disabled={loading}
            className="flex-1 py-3 rounded-2xl bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50">
            {loading ? '시작 중...' : '예, 시작하기'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 관리자 화면 ──────────────────────────────────────────────
function AdminScreen({ onClose }) {
  const [users, setUsers]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [extending, setExt]     = useState(null)

  useEffect(() => { loadUsers() }, [])

  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token
  }

  async function loadUsers() {
    setLoading(true)
    const token = await getToken()
    const res   = await fetch(`${API_BASE}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
    setUsers(await res.json())
    setLoading(false)
  }

  async function extend(userId, days) {
    setExt(userId + days)
    const token = await getToken()
    await fetch(`${API_BASE}/api/admin/extend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId, days }),
    })
    await loadUsers()
    setExt(null)
  }

  function getStatus(u) {
    const now      = new Date()
    const subEnd   = u.sub_expires_at ? new Date(u.sub_expires_at) : null
    const trialEnd = u.trial_started_at ? new Date(new Date(u.trial_started_at).getTime() + TRIAL_DAYS * 86400000) : null
    if (subEnd && subEnd > now) {
      const d = Math.ceil((subEnd - now) / 86400000)
      return { label: `구독 ${d}일`, cls: 'text-emerald-600 bg-emerald-50' }
    }
    if (trialEnd > now) {
      const d = Math.ceil((trialEnd - now) / 86400000)
      return { label: `체험 ${d}일`, cls: 'text-indigo-600 bg-indigo-50' }
    }
    return { label: '만료', cls: 'text-rose-600 bg-rose-50' }
  }

  function fmtDate(d) {
    if (!d) return '-'
    return new Date(d).toLocaleDateString('ko-KR')
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col">
      <div className="bg-white border-b border-slate-100 px-4 pb-3 flex items-center justify-between"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}>
        <h2 className="text-lg font-bold text-slate-900">관리자 패널</h2>
        <button onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
        {loading ? (
          <div className="text-center py-10 text-slate-400 text-sm">불러오는 중...</div>
        ) : users.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">가입 유저 없음</div>
        ) : users.map(u => {
          const st = getStatus(u)
          return (
            <div key={u.user_id} className="bg-white rounded-2xl p-4 border border-slate-100">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0 pr-2">
                  <div className="text-sm font-semibold text-slate-900 truncate">{u.email}</div>
                  <div className="text-xs text-slate-400 mt-0.5">가입 {fmtDate(u.created_at)}</div>
                  {u.sub_expires_at && <div className="text-xs text-slate-400">구독만료 {fmtDate(u.sub_expires_at)}</div>}
                </div>
                <span className={`text-xs font-semibold px-2 py-1 rounded-full shrink-0 ${st.cls}`}>{st.label}</span>
              </div>
              <div className="flex gap-2">
                {[1, 10, 30].map(days => (
                  <button key={days} onClick={() => extend(u.user_id, days)}
                    disabled={extending === u.user_id + days}
                    className="flex-1 py-2 text-xs font-semibold bg-slate-100 text-slate-700 rounded-xl hover:bg-indigo-50 hover:text-indigo-600 transition-colors disabled:opacity-40">
                    +{days}일
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 팀 풀네임 → 약자 매핑 (MLB + NBA + NHL)
const TEAM_ABBREV = {
  // MLB
  'Arizona Diamondbacks':'AZ','Atlanta Braves':'ATL','Baltimore Orioles':'BAL',
  'Boston Red Sox':'BOS','Chicago Cubs':'CHC','Chicago White Sox':'CWS',
  'Cincinnati Reds':'CIN','Cleveland Guardians':'CLE','Colorado Rockies':'COL',
  'Detroit Tigers':'DET','Houston Astros':'HOU','Kansas City Royals':'KC',
  'Los Angeles Angels':'LAA','Los Angeles Dodgers':'LAD','Miami Marlins':'MIA',
  'Milwaukee Brewers':'MIL','Minnesota Twins':'MIN','New York Mets':'NYM',
  'New York Yankees':'NYY','Athletics':'ATH','Oakland Athletics':'ATH',
  'Philadelphia Phillies':'PHI','Pittsburgh Pirates':'PIT','San Diego Padres':'SD',
  'San Francisco Giants':'SF','Seattle Mariners':'SEA','St. Louis Cardinals':'STL',
  'Tampa Bay Rays':'TB','Texas Rangers':'TEX','Toronto Blue Jays':'TOR',
  'Washington Nationals':'WSH',
  // NBA
  'Atlanta Hawks':'ATL','Boston Celtics':'BOS','Brooklyn Nets':'BKN',
  'Charlotte Hornets':'CHA','Chicago Bulls':'CHI','Cleveland Cavaliers':'CLE',
  'Dallas Mavericks':'DAL','Denver Nuggets':'DEN','Detroit Pistons':'DET',
  'Golden State Warriors':'GSW','Houston Rockets':'HOU','Indiana Pacers':'IND',
  'Los Angeles Clippers':'LAC','Los Angeles Lakers':'LAL','Memphis Grizzlies':'MEM',
  'Miami Heat':'MIA','Milwaukee Bucks':'MIL','Minnesota Timberwolves':'MIN',
  'New Orleans Pelicans':'NOP','New York Knicks':'NYK','Oklahoma City Thunder':'OKC',
  'Orlando Magic':'ORL','Philadelphia 76ers':'PHI','Phoenix Suns':'PHX',
  'Portland Trail Blazers':'POR','Sacramento Kings':'SAC','San Antonio Spurs':'SAS',
  'Toronto Raptors':'TOR','Utah Jazz':'UTA','Washington Wizards':'WSH',
  // NHL
  'Anaheim Ducks':'ANA','Arizona Coyotes':'ARI','Boston Bruins':'BOS',
  'Buffalo Sabres':'BUF','Calgary Flames':'CGY','Carolina Hurricanes':'CAR',
  'Chicago Blackhawks':'CHI','Colorado Avalanche':'COL','Columbus Blue Jackets':'CBJ',
  'Dallas Stars':'DAL','Detroit Red Wings':'DET','Edmonton Oilers':'EDM',
  'Florida Panthers':'FLA','Los Angeles Kings':'LAK','Minnesota Wild':'MIN',
  'Montreal Canadiens':'MTL','Nashville Predators':'NSH','New Jersey Devils':'NJD',
  'New York Islanders':'NYI','New York Rangers':'NYR','Ottawa Senators':'OTT',
  'Philadelphia Flyers':'PHI','Pittsburgh Penguins':'PIT','San Jose Sharks':'SJS',
  'Seattle Kraken':'SEA','St. Louis Blues':'STL','Tampa Bay Lightning':'TBL',
  'Toronto Maple Leafs':'TOR','Utah Hockey Club':'UTA','Utah HC':'UTA','Utah Mammoth':'UTA',
  'Vancouver Canucks':'VAN',
  'Vegas Golden Knights':'VGK','Washington Capitals':'WSH','Winnipeg Jets':'WPG',
}

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
  'K리그1': '🇰🇷', 'K리그2': '🇰🇷', MLS: '🇺🇸', 'A리그': '🇦🇺', 'J리그': '🇯🇵',
  UCL: '🏆', Europa: '🟠', Conference: '🟢',
  NBA: '🇺🇸', NHL: '🇺🇸',
}

const ALL_LEAGUES = [
  'MLB', 'KBO', 'NPB',
  'EPL', 'Bundesliga', 'Serie A', 'Ligue 1', 'La Liga', 'K리그1', 'K리그2', 'MLS', 'A리그', 'J리그', 'UCL', 'Europa', 'Conference',
  'NBA', 'NHL',
]

const SPORT_GROUPS = [
  { key: 'baseball',   label: '⚾ 야구', leagues: ['MLB', 'KBO', 'NPB'] },
  { key: 'soccer',     label: '⚽ 축구', leagues: ['EPL', 'Bundesliga', 'Serie A', 'Ligue 1', 'La Liga', 'K리그1', 'K리그2', 'MLS', 'A리그', 'J리그', 'UCL', 'Europa', 'Conference'] },
  { key: 'basketball', label: '🏀 농구', leagues: ['NBA'] },
  { key: 'hockey',     label: '🏒 하키', leagues: ['NHL'] },
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
    const d = new Date(ts)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${mm}/${dd} ${hh}:${min}`
  } catch { return '' }
}

function sharpSignals(game) {
  const op = game.opening || {}
  const alerts = game.recentAlerts || []
  const hasSteamMl = alerts.some(a => a.type === 'instant_ml')
  const hasSteamSp = alerts.some(a => a.type === 'instant_sp')
  const hasSteamOu = alerts.some(a => a.type === 'instant_ou')
  const hasLineSp  = alerts.some(a => a.type === 'line_sp')
  const hasLineOu  = alerts.some(a => a.type === 'line_ou')

  const hours = hoursUntil(game.starts_at)
  const timeBoost = (hours !== null && hours >= 0 && hours <= 4) ? 1 : 0

  const signals = []

  if (hasSteamMl) {
    const dropHome = (op.ml_home && game.ml_home) ? op.ml_home - game.ml_home : 0
    const dropAway = (op.ml_away && game.ml_away) ? op.ml_away - game.ml_away : 0
    const [label, drop] = dropHome >= dropAway ? ['홈 ML', dropHome] : ['원정 ML', dropAway]
    const steamVal = parseFloat(alerts.find(a => a.type === 'instant_ml')?.threshold || 0)
    const base = steamVal >= 0.20 ? 3 : 2
    signals.push({ label, drop, score: Math.min(3, base + timeBoost) })
  }

  if (hasSteamSp || hasLineSp) {
    if (hasLineSp && op.sp_pts != null && game.sp_pts != null && game.sp_pts !== op.sp_pts) {
      const delta = game.sp_pts - op.sp_pts
      const label = delta < 0 ? '홈 핸디' : '원정 핸디'
      const base = hasSteamSp ? 3 : 2
      signals.push({ label, drop: Math.abs(delta), score: Math.min(3, base + timeBoost) })
    } else if (hasSteamSp) {
      const dropHome = (op.sp_home && game.sp_home) ? op.sp_home - game.sp_home : 0
      const dropAway = (op.sp_away && game.sp_away) ? op.sp_away - game.sp_away : 0
      const [label, drop] = dropHome >= dropAway ? ['홈 핸디', dropHome] : ['원정 핸디', dropAway]
      const steamVal = parseFloat(alerts.find(a => a.type === 'instant_sp')?.threshold || 0)
      const base = steamVal >= 0.20 ? 3 : 2
      signals.push({ label, drop, score: Math.min(3, base + timeBoost) })
    }
  }

  if (hasSteamOu || hasLineOu) {
    if (hasLineOu && op.ou_pts != null && game.ou_pts != null && game.ou_pts !== op.ou_pts) {
      const delta = game.ou_pts - op.ou_pts
      const label = delta < 0 ? '언더' : '오버'
      const base = hasSteamOu ? 3 : 2
      signals.push({ label, drop: Math.abs(delta), score: Math.min(3, base + timeBoost) })
    } else if (hasSteamOu) {
      const dropOver  = (op.ou_over  && game.ou_over)  ? op.ou_over  - game.ou_over  : 0
      const dropUnder = (op.ou_under && game.ou_under) ? op.ou_under - game.ou_under : 0
      const [label, drop] = dropOver >= dropUnder ? ['오버', dropOver] : ['언더', dropUnder]
      const steamVal = parseFloat(alerts.find(a => a.type === 'instant_ou')?.threshold || 0)
      const base = steamVal >= 0.20 ? 3 : 2
      signals.push({ label, drop, score: Math.min(3, base + timeBoost) })
    }
  }

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
      sig = { label: lbl, drop: 0, score: 1 }
      signals.push(sig)
    }
    sig.score = Math.min(3, sig.score + 1)
    sig.streak = count
  }

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
  return null
}

function OddsTag({ label, value, openValue, highlight }) {
  const diff = (value != null && openValue != null)
    ? parseFloat((value - openValue).toFixed(3)) : null
  const hasDiff = diff !== null && Math.abs(diff) >= 0.005
  const isHL = highlight === 'blue'
  return (
    <div className={`flex-1 flex flex-col items-center py-2.5 px-1 rounded-xl transition-all
      ${isHL ? 'bg-indigo-600 shadow-md shadow-indigo-100' : 'bg-slate-50 border border-slate-200'}`}>
      <span className={`text-xs font-medium mb-0.5 ${isHL ? 'text-indigo-200' : 'text-slate-400'}`}>{label}</span>
      <span className={`text-base font-bold leading-tight ${isHL ? 'text-white' : 'text-slate-900'}`}>
        {value?.toFixed(2) ?? '-'}
      </span>
      {hasDiff ? (
        <span className={`text-xs font-semibold mt-0.5 ${diff > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
          {diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)}
        </span>
      ) : <span className="text-xs opacity-0">-</span>}
    </div>
  )
}

function SharpBadge({ alerts, game }) {
  if (!alerts || alerts.length === 0) return null
  const op = game.opening || {}
  const fmtPts = v => v != null ? `${v >= 0 ? '+' : ''}${v}` : '?'
  const badges = []
  if (alerts.some(a => a.type === 'line_sp') && op.sp_pts != null && game.sp_pts != null && op.sp_pts !== game.sp_pts)
    badges.push({ key: 'line_sp', label: '핸디', detail: `${fmtPts(op.sp_pts)} → ${fmtPts(game.sp_pts)}` })
  if (alerts.some(a => a.type === 'line_ou') && op.ou_pts != null && game.ou_pts != null && op.ou_pts !== game.ou_pts)
    badges.push({ key: 'line_ou', label: 'O/U', detail: `${op.ou_pts} → ${game.ou_pts}` })
  if (badges.length === 0) return null
  return (
    <div className="flex gap-1.5 flex-wrap mb-2.5">
      {badges.map(b => (
        <span key={b.key} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
          기준점 변동 · {b.label} {b.detail}
        </span>
      ))}
    </div>
  )
}

function OddsChart({ snapshots, mktTab, isSoccer }) {
  const data = [...snapshots].reverse()
  if (data.length < 2) return null

  const W = 300, H = 80, PX = 8, PY = 8

  const series = mktTab === 'ml'
    ? [
        { values: data.map(s => s.ml_home),  color: '#6366F1', label: '홈' },
        { values: data.map(s => s.ml_away),  color: '#F43F5E', label: '원정' },
        ...(isSoccer ? [{ values: data.map(s => s.ml_draw), color: '#94A3B8', label: '무' }] : []),
      ]
    : mktTab === 'sp'
    ? [
        { values: data.map(s => s.sp_home), color: '#6366F1', label: '홈' },
        { values: data.map(s => s.sp_away), color: '#F43F5E', label: '원정' },
      ]
    : [
        { values: data.map(s => s.ou_over),  color: '#10B981', label: '오버' },
        { values: data.map(s => s.ou_under), color: '#F59E0B', label: '언더' },
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

  const yMin = lo.toFixed(2), yMax = hi.toFixed(2)

  return (
    <div className="mb-3 bg-slate-50 border border-slate-100 rounded-xl p-3">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 80 }}>
          {[0.25, 0.5, 0.75].map(t => (
            <line key={t} x1={PX} x2={W - PX}
              y1={PY + t * (H - PY * 2)} y2={PY + t * (H - PY * 2)}
              stroke="#E2E8F0" strokeWidth="1" />
          ))}
          {series.map((s, i) => {
            const d = path(s.values)
            return d ? <path key={i} d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /> : null
          })}
        </svg>
        <div className="absolute top-1 right-1 text-xs text-slate-400">{yMax}</div>
        <div className="absolute bottom-1 right-1 text-xs text-slate-400">{yMin}</div>
      </div>
      <div className="flex gap-3 justify-center mt-1">
        {series.map((s, i) => (
          <div key={i} className="flex items-center gap-1">
            <div className="w-4 h-0.5 rounded" style={{ backgroundColor: s.color }} />
            <span className="text-xs text-slate-400">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

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
        .order('id', { ascending: false })
        .limit(300)
      const rows = (res.data || []).filter(r => r.ml_home != null || r.sp_home != null || r.ou_over != null).reverse()
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
    if (cur == null) return <span className="text-slate-300">-</span>
    const d = prev != null ? parseFloat((cur - prev).toFixed(3)) : null
    const show = d !== null && Math.abs(d) >= 0.005
    return (
      <span className={show ? (d > 0 ? 'text-emerald-600 font-bold' : 'text-rose-500 font-bold') : 'text-slate-800'}>
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
      <div className="flex-1 bg-slate-900/40 backdrop-blur-sm" />
      <div
        className="relative bg-white rounded-t-3xl px-4 pt-4 max-h-[82vh] flex flex-col"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 32px)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto" />
          <button
            onClick={onClose}
            className="absolute right-4 top-4 w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-400 hover:bg-slate-200 active:bg-slate-300 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="mb-4">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
              {flag} {game.league}
            </span>
            <span className="text-xs text-slate-400">{game.starts_at?.replace(' KST','')}</span>
          </div>
          <div className="text-slate-900 font-bold text-lg mb-2">
            {game.home} <span className="text-slate-300 font-normal text-sm mx-1">vs</span> {game.away}
          </div>
          <SharpSignals signals={sharpSignals(game)} />
        </div>

        <div className="flex gap-2 mb-3">
          {mktTabs.map(t => (
            <button key={t.key} onClick={() => setMktTab(t.key)}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all
                ${mktTab === t.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-center text-slate-400 py-10 text-sm">불러오는 중...</div>
        ) : snapshots.length === 0 ? (
          <div className="text-center text-slate-400 py-10 text-sm">데이터 없음</div>
        ) : (
          <div className="overflow-y-auto flex-1">
            <OddsChart snapshots={snapshots} mktTab={mktTab} isSoccer={isSoccer} />
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 border-b border-slate-100">
                  <th className="text-left py-2 pr-2 font-medium text-xs">시간</th>
                  {mktTab === 'ml' && <>
                    <th className="text-right py-2 px-2 font-medium text-xs">홈</th>
                    {isSoccer && <th className="text-right py-2 px-2 font-medium text-xs">무</th>}
                    <th className="text-right py-2 px-2 font-medium text-xs">원정</th>
                  </>}
                  {mktTab === 'sp' && <>
                    <th className="text-right py-2 px-2 font-medium text-xs">기준선</th>
                    <th className="text-right py-2 px-2 font-medium text-xs">홈</th>
                    <th className="text-right py-2 px-2 font-medium text-xs">원정</th>
                  </>}
                  {mktTab === 'ou' && <>
                    <th className="text-right py-2 px-2 font-medium text-xs">기준선</th>
                    <th className="text-right py-2 px-2 font-medium text-xs">오버</th>
                    <th className="text-right py-2 px-2 font-medium text-xs">언더</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s, i) => {
                  const prev = snapshots[i + 1]
                  return (
                    <tr key={i} className="border-b border-slate-50">
                      <td className="py-2 pr-2 text-slate-400 whitespace-nowrap text-xs">{fmtTime(s.ts)}</td>
                      {mktTab === 'ml' && <>
                        <td className="text-right py-2 px-2">{diffCell(s.ml_home, prev?.ml_home)}</td>
                        {isSoccer && <td className="text-right py-2 px-2">{diffCell(s.ml_draw, prev?.ml_draw)}</td>}
                        <td className="text-right py-2 px-2">{diffCell(s.ml_away, prev?.ml_away)}</td>
                      </>}
                      {mktTab === 'sp' && <>
                        <td className="text-right py-2 px-2 text-slate-500 text-xs">{s.sp_pts != null ? (s.sp_pts >= 0 ? '+' : '') + s.sp_pts : '-'}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.sp_home, prev?.sp_home)}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.sp_away, prev?.sp_away)}</td>
                      </>}
                      {mktTab === 'ou' && <>
                        <td className="text-right py-2 px-2 text-slate-500 text-xs">{s.ou_pts ?? '-'}</td>
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

function PctBar({ label, pct, handle }) {
  if (pct == null) return null
  return (
    <div className="mb-1.5">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-slate-500 font-medium">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-slate-800 font-semibold">{pct}%</span>
          {handle != null && <span className="text-slate-400">· 금액 {handle}%</span>}
        </div>
      </div>
      <div className="w-full bg-slate-100 rounded-full h-1">
        <div className="bg-indigo-400 h-1 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function PublicBetting({ pb, isSoccer }) {
  if (!pb) return null
  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <div className="text-xs font-semibold text-slate-400 tracking-wide mb-2">해외 구매율</div>
      <div className="space-y-1">
        <PctBar label="홈 ML"   pct={pb.ml_bets_home}  handle={pb.ml_handle_home} />
        <PctBar label="원정 ML"  pct={pb.ml_bets_away}  handle={pb.ml_handle_away} />
        {pb.sp_bets_home != null && <PctBar label="홈 핸디"  pct={pb.sp_bets_home} handle={pb.sp_handle_home} />}
        {pb.sp_bets_away != null && <PctBar label="원정 핸디" pct={pb.sp_bets_away} handle={pb.sp_handle_away} />}
        {pb.ou_bets_over  != null && <PctBar label="오버" pct={pb.ou_bets_over}  handle={pb.ou_handle_over} />}
        {pb.ou_bets_under != null && <PctBar label="언더" pct={pb.ou_bets_under} handle={pb.ou_handle_under} />}
      </div>
    </div>
  )
}

function ProtoBetting({ proto }) {
  if (!proto) return null
  const hasMl = proto.ml_bets_home != null || proto.ml_bets_away != null
  const hasSp = proto.sp_bets_home != null || proto.sp_bets_away != null
  const hasOu = proto.ou_bets_over != null || proto.ou_bets_under != null
  if (!hasMl && !hasOu && !hasSp) return null
  return (
    <div className="mt-2 pt-2 border-t border-slate-100">
      <div className="text-xs font-semibold text-slate-400 tracking-wide mb-2">국내 구매율</div>
      <div className="space-y-1">
        {/* 승패 (ML / 승무패) */}
        {proto.ml_bets_home != null && <PctBar label="홈 승"   pct={proto.ml_bets_home} />}
        {proto.ml_bets_draw != null && <PctBar label="무"       pct={proto.ml_bets_draw} />}
        {proto.ml_bets_away != null && <PctBar label="원정 승"  pct={proto.ml_bets_away} />}
        {/* 핸디캡 (농구) */}
        {hasSp && proto.sp_bets_home != null && <PctBar label="홈 핸디"   pct={proto.sp_bets_home} />}
        {hasSp && proto.sp_bets_away != null && <PctBar label="원정 핸디" pct={proto.sp_bets_away} />}
        {/* 언오버 */}
        {hasOu && proto.ou_bets_over  != null && <PctBar label="오버" pct={proto.ou_bets_over} />}
        {hasOu && proto.ou_bets_under != null && <PctBar label="언더" pct={proto.ou_bets_under} />}
      </div>
    </div>
  )
}

const REVERSE_THRESHOLD      = 70   // 야구·농구·O/U
const REVERSE_THRESHOLD_3W   = 65   // 축구 승무패

function reverseSignals(game) {
  const proto   = game.protoBetting
  const pb      = game.publicBetting
  const op      = game.opening || {}
  const signals = []

  const mlHome  = proto?.ml_bets_home  ?? pb?.ml_bets_home
  const mlAway  = proto?.ml_bets_away  ?? pb?.ml_bets_away
  const ouOver  = proto?.ou_bets_over  ?? pb?.ou_bets_over
  const ouUnder = proto?.ou_bets_under ?? pb?.ou_bets_under

  const fmtPts  = v => v != null ? `${v >= 0 ? '+' : ''}${v}` : '?'
  const isSoccer = game.sport === 'soccer'

  if (isSoccer) {
    // ── [축구 Signal 1] 승무패 역추세: 정배 편중 + 정배 배당 상승 ─────
    // 정배 판별: 현재 배당 낮은 쪽
    const homeFav = game.ml_home != null && game.ml_away != null && game.ml_home < game.ml_away
    const awayFav = game.ml_home != null && game.ml_away != null && game.ml_away < game.ml_home

    if (homeFav && mlHome != null && mlHome >= REVERSE_THRESHOLD_3W) {
      const diff = (op.ml_home && game.ml_home) ? game.ml_home - op.ml_home : null
      if (diff != null && diff >= 0.03) {
        signals.push({ market: 'ML', pick: '원정 플핸', publicSide: `홈 ${mlHome}%`, reason: `홈배당↑ +${diff.toFixed(2)}` })
      }
    }
    if (awayFav && mlAway != null && mlAway >= REVERSE_THRESHOLD_3W) {
      const diff = (op.ml_away && game.ml_away) ? game.ml_away - op.ml_away : null
      if (diff != null && diff >= 0.03) {
        signals.push({ market: 'ML', pick: '홈 플핸', publicSide: `원정 ${mlAway}%`, reason: `원정배당↑ +${diff.toFixed(2)}` })
      }
    }

    // ── [축구 Signal 2] 핸디라인 이동: 정배 편중 + sp_pts 정배에 불리하게 변동 ─
    const spLineChanged = op.sp_pts != null && game.sp_pts != null && game.sp_pts !== op.sp_pts
    if (spLineChanged) {
      if (homeFav && mlHome != null && mlHome >= REVERSE_THRESHOLD_3W && game.sp_pts > op.sp_pts) {
        // 홈 정배인데 핸디선이 홈에게 불리하게 상승 → 원정 플핸
        signals.push({ market: '핸디', pick: '원정 플핸', publicSide: `홈 ${mlHome}%`, reason: `핸디선 ${fmtPts(op.sp_pts)}→${fmtPts(game.sp_pts)}` })
      }
      if (awayFav && mlAway != null && mlAway >= REVERSE_THRESHOLD_3W && game.sp_pts < op.sp_pts) {
        // 원정 정배인데 핸디선이 원정에게 불리하게 하락 → 홈 플핸
        signals.push({ market: '핸디', pick: '홈 플핸', publicSide: `원정 ${mlAway}%`, reason: `핸디선 ${fmtPts(op.sp_pts)}→${fmtPts(game.sp_pts)}` })
      }
    }

    // ── [축구 Signal 3] O/U 역추세: 오버 편중 + 기준점 하락 or 오버배당 상승 ─
    if (ouOver != null && ouUnder != null) {
      const ouLineChanged = op.ou_pts != null && game.ou_pts != null && game.ou_pts !== op.ou_pts
      if (ouOver >= REVERSE_THRESHOLD) {
        if (ouLineChanged && game.ou_pts < op.ou_pts) {
          signals.push({ market: 'O/U', pick: '언더', publicSide: `오버 ${ouOver}%`, reason: `기준점↓ (${op.ou_pts}→${game.ou_pts})` })
        } else if (!ouLineChanged) {
          const diff = (op.ou_over && game.ou_over) ? game.ou_over - op.ou_over : null
          if (diff != null && diff >= 0.03) {
            signals.push({ market: 'O/U', pick: '언더', publicSide: `오버 ${ouOver}%`, reason: `오버배당↑ +${diff.toFixed(2)}` })
          }
        }
      }
    }

  } else {
    // ── 야구·농구 ML 역추세 ────────────────────────────────────────
    if (mlHome != null && mlAway != null) {
      if (mlHome >= REVERSE_THRESHOLD) {
        const diff = (op.ml_home && game.ml_home) ? game.ml_home - op.ml_home : null
        if (diff != null && diff >= 0.05) {
          signals.push({ market: 'ML', pick: '원정 승', publicSide: `홈 ${mlHome}%`, reason: `홈배당↑ +${diff.toFixed(2)}` })
        }
      }
      if (mlAway >= REVERSE_THRESHOLD) {
        const diff = (op.ml_away && game.ml_away) ? game.ml_away - op.ml_away : null
        if (diff != null && diff >= 0.05) {
          signals.push({ market: 'ML', pick: '홈 승', publicSide: `원정 ${mlAway}%`, reason: `원정배당↑ +${diff.toFixed(2)}` })
        }
      }
    }

    // ── 야구·농구 핸디 역추세 ─────────────────────────────────────
    const spHome  = proto?.sp_bets_home  ?? pb?.sp_bets_home
    const spAway  = proto?.sp_bets_away  ?? pb?.sp_bets_away
    if (spHome != null && spAway != null) {
      const lineChanged = op.sp_pts != null && game.sp_pts != null && game.sp_pts !== op.sp_pts
      if (spHome >= REVERSE_THRESHOLD) {
        if (lineChanged) {
          if (game.sp_pts > op.sp_pts) {
            signals.push({ market: '핸디', pick: '원정 핸디', publicSide: `홈핸디 ${spHome}%`, reason: `기준점↑ (${fmtPts(op.sp_pts)}→${fmtPts(game.sp_pts)})` })
          }
        } else {
          const diff = (op.sp_home && game.sp_home) ? game.sp_home - op.sp_home : null
          if (diff != null && diff >= 0.05) {
            signals.push({ market: '핸디', pick: '원정 핸디', publicSide: `홈핸디 ${spHome}%`, reason: `홈핸디배당↑ +${diff.toFixed(2)}` })
          }
        }
      }
      if (spAway >= REVERSE_THRESHOLD) {
        if (lineChanged) {
          if (game.sp_pts < op.sp_pts) {
            signals.push({ market: '핸디', pick: '홈 핸디', publicSide: `원정핸디 ${spAway}%`, reason: `기준점↓ (${fmtPts(op.sp_pts)}→${fmtPts(game.sp_pts)})` })
          }
        } else {
          const diff = (op.sp_away && game.sp_away) ? game.sp_away - op.sp_away : null
          if (diff != null && diff >= 0.05) {
            signals.push({ market: '핸디', pick: '홈 핸디', publicSide: `원정핸디 ${spAway}%`, reason: `원정핸디배당↑ +${diff.toFixed(2)}` })
          }
        }
      }
    }

    // ── 야구·농구 O/U 역추세 ─────────────────────────────────────
    if (ouOver != null && ouUnder != null) {
      const lineChanged = op.ou_pts != null && game.ou_pts != null && game.ou_pts !== op.ou_pts
      if (ouOver >= REVERSE_THRESHOLD) {
        if (lineChanged) {
          if (game.ou_pts < op.ou_pts) {
            signals.push({ market: 'O/U', pick: '언더', publicSide: `오버 ${ouOver}%`, reason: `기준점↓ (${op.ou_pts}→${game.ou_pts})` })
          }
        } else {
          const diff = (op.ou_over && game.ou_over) ? game.ou_over - op.ou_over : null
          if (diff != null && diff >= 0.05) {
            signals.push({ market: 'O/U', pick: '언더', publicSide: `오버 ${ouOver}%`, reason: `오버배당↑ +${diff.toFixed(2)}` })
          }
        }
      }
      if (ouUnder >= REVERSE_THRESHOLD) {
        if (lineChanged) {
          if (game.ou_pts > op.ou_pts) {
            signals.push({ market: 'O/U', pick: '오버', publicSide: `언더 ${ouUnder}%`, reason: `기준점↑ (${op.ou_pts}→${game.ou_pts})` })
          }
        } else {
          const diff = (op.ou_under && game.ou_under) ? game.ou_under - op.ou_under : null
          if (diff != null && diff >= 0.05) {
            signals.push({ market: 'O/U', pick: '오버', publicSide: `언더 ${ouUnder}%`, reason: `언더배당↑ +${diff.toFixed(2)}` })
          }
        }
      }
    }
  }

  return signals
}

function ReverseSignals({ signals }) {
  if (!signals || signals.length === 0) return null
  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <div className="text-xs font-semibold text-slate-400 tracking-wide mb-2">시그널</div>
      <div className="flex gap-2 flex-wrap">
        {signals.map((s, i) => {
          const isFade = s.type === 'underdog_fade'
          return (
            <div key={i} className={`rounded-xl px-3 py-2 border ${
              isFade
                ? 'bg-amber-50 border-amber-100'
                : 'bg-violet-50 border-violet-100'
            }`}>
              <div className={`text-xs font-medium ${isFade ? 'text-amber-600' : 'text-violet-500'}`}>
                {isFade ? '정배역전' : '역추세'} · {s.market} · {s.publicSide}
              </div>
              <div className={`text-sm font-bold mt-0.5 ${isFade ? 'text-amber-800' : 'text-violet-800'}`}>
                {s.pick}
              </div>
              <div className={`text-xs mt-0.5 ${isFade ? 'text-amber-500' : 'text-violet-400'}`}>
                {s.reason}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 역추세 픽의 배당 추출 ─────────────────────────────────────
function getPickOdds(game, signal) {
  const op  = game.opening || {}
  const val = (cur, open) => cur ?? open
  if (signal.market === 'ML') {
    if (signal.pick.includes('홈') && !signal.pick.includes('원정')) return val(game.ml_home, op.ml_home)
    if (signal.pick.includes('원정')) return val(game.ml_away, op.ml_away)
    if (signal.pick.includes('무'))   return val(game.ml_draw, op.ml_draw)
  }
  if (signal.market === '핸디') {
    if (signal.pick.includes('홈'))   return val(game.sp_home, op.sp_home)
    if (signal.pick.includes('원정')) return val(game.sp_away, op.sp_away)
  }
  if (signal.market === 'O/U') {
    if (signal.pick.includes('오버')) return val(game.ou_over,  op.ou_over)
    if (signal.pick.includes('언더')) return val(game.ou_under, op.ou_under)
  }
  return null
}

// ── 픽 중복 제거 + 핸디↔ML 변환 ─────────────────────────────
function consolidatePicks(rawPicks) {
  const byGame = {}
  for (const pick of rawPicks) {
    const id = pick.game.matchup_id
    if (!byGame[id]) byGame[id] = []
    byGame[id].push(pick)
  }

  const result  = []
  const usedKey = new Set()

  for (const gamePicks of Object.values(byGame)) {
    const game   = gamePicks[0].game
    const op     = game.opening || {}
    const sp_pts = game.sp_pts ?? op.sp_pts

    const mlPicks = gamePicks.filter(p => p.signal.market === 'ML')
    const spPicks = gamePicks.filter(p => p.signal.market === '핸디')
    const ouPicks = gamePicks.filter(p => p.signal.market === 'O/U')

    for (const pick of mlPicks) {
      const { signal } = pick
      const isHome = signal.pick.includes('홈') && !signal.pick.includes('원정')
      const isDraw = !signal.pick.includes('홈') && !signal.pick.includes('원정') && signal.pick.includes('무')
      const key = isDraw ? `${game.matchup_id}_draw`
        : `${game.matchup_id}_${isHome ? 'home' : 'away'}`
      if (usedKey.has(key)) continue
      usedKey.add(key)
      result.push(pick)
    }

    for (const pick of spPicks) {
      const { signal } = pick
      const isHome = signal.pick.includes('홈')
      const key    = `${game.matchup_id}_${isHome ? 'home' : 'away'}`
      if (usedKey.has(key)) continue
      usedKey.add(key)

      const teamHandi = isHome ? sp_pts : (sp_pts != null ? -sp_pts : null)
      if (teamHandi != null && teamHandi > 0) {
        result.push(pick)
      } else {
        const mlPickLabel = isHome ? '홈 승' : '원정 승'
        const mlOdds      = isHome ? (game.ml_home ?? op.ml_home) : (game.ml_away ?? op.ml_away)
        result.push({ game, signal: { ...signal, market: 'ML', pick: mlPickLabel }, odds: mlOdds })
      }
    }

    for (const pick of ouPicks) {
      const { signal } = pick
      const key = `${game.matchup_id}_${signal.pick.includes('오버') ? 'over' : 'under'}`
      if (usedKey.has(key)) continue
      usedKey.add(key)
      result.push(pick)
    }
  }

  return result
}

function SignalView({ games, hasAccess, onShowUpgrade }) {
  const allPicks = useMemo(() => {
    const raw = []
    for (const game of games) {
      if (isInPast(game.starts_at)) continue
      for (const sig of reverseSignals(game)) {
        raw.push({ game, signal: sig, odds: getPickOdds(game, sig) })
      }
    }
    return consolidatePicks(raw)
      .sort((a, b) => (a.game.starts_at > b.game.starts_at ? 1 : -1))
  }, [games])

  if (!hasAccess) return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round" className="text-slate-400">
          <rect x="3" y="11" width="18" height="11" rx="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <div className="text-sm text-slate-500 text-center">
        {onShowUpgrade ? '구독 후 시그널 픽을 볼 수 있습니다' : '로그인 후 시그널 픽을 볼 수 있습니다'}
      </div>
      <button onClick={onShowUpgrade}
        className="text-sm font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 px-5 py-2 rounded-full">
        {onShowUpgrade ? '잠금 해제' : '로그인'}
      </button>
    </div>
  )

  if (allPicks.length === 0)
    return (
      <div className="text-center py-20">
        <div className="text-slate-300 text-4xl mb-3">—</div>
        <div className="text-slate-400 text-sm">현재 시그널 없음</div>
      </div>
    )

  return (
    <div className="space-y-3">
      {allPicks.map((pick, i) => {
        const { game, signal, odds } = pick
        const flag    = LEAGUE_FLAGS[game.league] || '🏟'
        const isFade  = signal.type === 'underdog_fade'
        const h       = hoursUntil(game.starts_at)
        const urgent  = h != null && h <= 1

        return (
          <div key={i} className={`bg-white rounded-2xl p-4 border shadow-sm ${
            urgent ? 'border-indigo-200' : 'border-slate-100'
          }`}>
            {/* 리그 + 시간 */}
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full">
                {flag} {game.league}
              </span>
              <div className="flex items-center gap-1.5">
                {urgent && (
                  <span className="text-xs font-semibold text-rose-500 bg-rose-50 px-2 py-0.5 rounded-full">
                    {h < 0 ? '진행중' : `${Math.round(h * 60)}분 후`}
                  </span>
                )}
                <span className="text-xs text-slate-400">{game.starts_at?.replace(' KST','')}</span>
              </div>
            </div>

            {/* 팀명 */}
            <div className="text-sm font-bold text-slate-900 mb-2.5">
              {game.home} <span className="text-slate-300 font-normal">vs</span> {game.away}
            </div>

            {/* 시그널 */}
            <div className={`rounded-xl px-3 py-2.5 flex items-center justify-between border ${
              isFade
                ? 'bg-amber-50 border-amber-100'
                : 'bg-violet-50 border-violet-100'
            }`}>
              <div className="flex-1 min-w-0">
                <div className={`text-xs font-semibold mb-0.5 ${isFade ? 'text-amber-600' : 'text-violet-500'}`}>
                  {isFade ? '정배역전' : '역추세'} · {signal.market} · {signal.publicSide}
                </div>
                <div className={`text-base font-bold ${isFade ? 'text-amber-800' : 'text-violet-800'}`}>
                  {signal.pick}
                </div>
                <div className={`text-xs mt-0.5 ${isFade ? 'text-amber-500' : 'text-violet-400'}`}>
                  {signal.reason}
                </div>
              </div>
              {odds != null && (
                <div className="text-right ml-4 shrink-0">
                  <div className="text-xs text-slate-400 mb-0.5">배당</div>
                  <div className="text-2xl font-bold text-slate-900">{odds.toFixed(2)}</div>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function GameCard({ game, onClick, hasAccess, onShowUpgrade }) {
  const flag     = LEAGUE_FLAGS[game.league] || '🏟'
  const isSoccer = game.sport === 'soccer'
  const op       = game.opening || {}

  const revSigs = reverseSignals(game)
  const hasPick = (market, side) => revSigs.some(s => s.market === market && s.pick.includes(side))
  const mlHomeHL  = hasPick('ML', '홈') ? 'blue' : null
  const mlAwayHL  = hasPick('ML', '원정') ? 'blue' : null
  const spHomeHL  = hasPick('핸디', '홈') ? 'blue' : null
  const spAwayHL  = hasPick('핸디', '원정') ? 'blue' : null
  const ouOverHL  = hasPick('O/U', '오버') ? 'blue' : null
  const ouUnderHL = hasPick('O/U', '언더') ? 'blue' : null

  const mlHome  = game.ml_home  ?? op.ml_home
  const mlAway  = game.ml_away  ?? op.ml_away
  const mlDraw  = game.ml_draw  ?? op.ml_draw
  const spHome  = game.sp_home  ?? op.sp_home
  const spAway  = game.sp_away  ?? op.sp_away
  const ouOver  = game.ou_over  ?? op.ou_over
  const ouUnder = game.ou_under ?? op.ou_under
  const spPts   = game.sp_pts   ?? op.sp_pts
  const ouPts   = game.ou_pts   ?? op.ou_pts

  return (
    <div className="bg-white rounded-2xl p-4 mb-3 border border-slate-100 shadow-sm cursor-pointer active:opacity-75 transition-opacity"
      onClick={hasAccess ? onClick : onShowUpgrade}>

      {/* 리그 + 시간 */}
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full">
          {flag} {game.league}
        </span>
        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <span>{game.starts_at?.replace(' KST','')}</span>
          {minsAgo(game.ts) && <>
            <span className="text-slate-200">·</span>
            <span>{minsAgo(game.ts)} 기준</span>
          </>}
        </div>
      </div>

      {/* 기준점 변동 배지 */}
      <SharpBadge alerts={game.recentAlerts} game={game} />

      {/* 팀명 */}
      <div className="mb-3">
        <span className="text-slate-900 font-bold text-xl">{game.home}</span>
        <span className="text-slate-300 text-base mx-2 font-normal">vs</span>
        <span className="text-slate-900 font-bold text-xl">{game.away}</span>
      </div>

      {/* 승패 */}
      <div className="flex gap-1.5 mb-1.5">
        <OddsTag label="홈" value={mlHome} openValue={game.ml_home != null ? op.ml_home : null} highlight={mlHomeHL} />
        {isSoccer && mlDraw && <OddsTag label="무" value={mlDraw} openValue={game.ml_draw != null ? op.ml_draw : null} />}
        <OddsTag label="원정" value={mlAway} openValue={game.ml_away != null ? op.ml_away : null} highlight={mlAwayHL} />
      </div>

      {/* 핸디 */}
      {spPts != null && (
        <div className="flex gap-1.5 mb-1.5">
          <OddsTag label={`홈 ${spPts >= 0 ? '+' : ''}${spPts}`} value={spHome} openValue={game.sp_home != null ? op.sp_home : null} highlight={spHomeHL} />
          <OddsTag label={`원정 ${(-spPts) >= 0 ? '+' : ''}${-spPts}`} value={spAway} openValue={game.sp_away != null ? op.sp_away : null} highlight={spAwayHL} />
        </div>
      )}

      {/* O/U */}
      {ouPts != null && (
        <div className="flex gap-1.5">
          <OddsTag label={`오버 ${ouPts}`} value={ouOver} openValue={game.ou_over != null ? op.ou_over : null} highlight={ouOverHL} />
          <OddsTag label={`언더 ${ouPts}`} value={ouUnder} openValue={game.ou_under != null ? op.ou_under : null} highlight={ouUnderHL} />
        </div>
      )}

      {hasAccess
        ? <><PublicBetting pb={game.publicBetting} isSoccer={isSoccer} /><ProtoBetting proto={game.protoBetting} /><ReverseSignals signals={reverseSignals(game)} /></>
        : <LockBox onUnlock={onShowUpgrade} isGuest={!onShowUpgrade} />
      }
    </div>
  )
}

function MainApp({ user, isAdmin, hasAccess, sub, onSignOut, onSignIn }) {
  const [games, setGames]           = useState([])
  const [tab, setTab]               = useState('all')
  const [subLeague, setSubLeague]   = useState('all')
  const [pastLeague, setPastLeague] = useState('all')
  const [loading, setLoading]       = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [selected, setSelected]     = useState(null)
  const [showAdmin, setShowAdmin]   = useState(false)
  const [showUpgrade, setShowUpgrade] = useState(false)
  const daysLeft = trialDaysLeft(sub)

  // 뒤로가기 버튼 처리
  useEffect(() => {
    let listener
    CapApp.addListener('backButton', () => {
      if (selected) {
        setSelected(null)
      } else {
        if (window.confirm('샤프시그널 앱을 종료하시겠습니까?')) {
          CapApp.exitApp()
        }
      }
    }).then(l => { listener = l })
    return () => { listener?.remove() }
  }, [selected])

  // 앱 포그라운드 복귀 시 자동 새로고침 (스크롤 유지 위해 silent)
  useEffect(() => {
    let listener
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) fetchGames(true)
    }).then(l => { listener = l })
    return () => { listener?.remove() }
  }, [])

  // 모달 열릴 때 배경 스크롤 방지
  useEffect(() => {
    document.body.style.overflow = selected ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [selected])

  useEffect(() => {
    fetchGames()
    const timer = setInterval(() => fetchGames(true), 10 * 60 * 1000) // 10분마다 자동 새로고침 (silent)
    return () => clearInterval(timer)
  }, [])

  // silent=true 이면 기존 데이터를 유지한 채 백그라운드 갱신 (스크롤 위치 보존)
  async function fetchGames(silent = false) {
    if (!silent) setLoading(true)
    let json
    try {
      const res = await fetch(`${API_BASE}/api/games`)
      json = await res.json()
    } catch (e) {
      if (!silent) setLoading(false)
      return
    }

    const linesData  = json.lines         || []
    const openings   = json.openings      || []
    const alertsData = json.alerts        || []
    const pbData     = json.publicBetting || []
    const protoData  = json.protoBetting  || []

    const currentIds  = new Set(linesData.map(g => g.matchup_id))
    const openingsMap = Object.fromEntries(openings.map(o => [o.matchup_id, o]))
    const alertsMap   = {}
    for (const a of alertsData) {
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

    function findPb(game) {
      const sportMap = { baseball: 'mlb', basketball: 'nba', hockey: 'nhl' }
      const sport = sportMap[game.sport] || game.sport
      if (!['mlb','nba','nhl'].includes(sport)) return null
      const homeAbbr = TEAM_ABBREV[game.home] || ''
      const awayAbbr = TEAM_ABBREV[game.away] || ''
      if (!homeAbbr || !awayAbbr) return null
      const norm = s => (s || '').toUpperCase()
      return pbData.find(pb =>
        pb.sport === sport && (
          (norm(pb.home) === norm(homeAbbr) && norm(pb.away) === norm(awayAbbr)) ||
          (norm(pb.home) === norm(awayAbbr) && norm(pb.away) === norm(homeAbbr))
        )
      ) || null
    }

    function findProto(game) {
      const sportMap = { baseball: 'baseball', basketball: 'basketball', soccer: 'soccer' }
      const protoSport = sportMap[game.sport]
      if (!protoSport) return null

      const norm = s => (s || '').trim().toLowerCase()
      // 6시간 이상 된 데이터는 스테일로 간주 → 표시 안 함
      const STALE_MS = 6 * 60 * 60 * 1000
      const isRecent = p => !p.updated_at || (Date.now() - new Date(p.updated_at).getTime()) < STALE_MS

      if (game.league === 'MLB' || game.league === 'NBA') {
        const homeAbbr = TEAM_ABBREV[game.home] || ''
        const awayAbbr = TEAM_ABBREV[game.away] || ''
        if (!homeAbbr || !awayAbbr) return null
        const found = protoData.find(p =>
          p.sport === protoSport &&
          p.league === game.league &&
          p.home_abbr?.toUpperCase() === homeAbbr.toUpperCase() &&
          p.away_abbr?.toUpperCase() === awayAbbr.toUpperCase()
        )
        return (found && isRecent(found)) ? found : null
      }
      // KBO/NPB/soccer: home_abbr = Pinnacle 영문 팀명과 직접 비교
      const found = protoData.find(p =>
        p.sport === protoSport &&
        norm(p.home_abbr) === norm(game.home) &&
        norm(p.away_abbr) === norm(game.away)
      )
      return (found && isRecent(found)) ? found : null
    }

    const merged = linesData.filter(g =>
      !/(Games\))/i.test(g.home || '') && !/(Games\))/i.test(g.away || '')
    ).map(g => ({
      ...g,
      opening:      openingsMap[g.matchup_id] || null,
      recentAlerts: alertsMap[g.matchup_id] ? Object.values(alertsMap[g.matchup_id]) : [],
      publicBetting: findPb(g),
      protoBetting:  findProto(g),
    }))
    setGames(merged)
    setLastUpdate(new Date().toLocaleTimeString('ko-KR'))
    if (!silent) setLoading(false)
  }

  const isPastView  = tab === 'past'
  const isComboView = tab === 'combo'
  const filtered = games.filter(g => {
    const past = isInPast(g.starts_at)
    if (isPastView) {
      if (!past) return false
      if (pastLeague !== 'all' && g.league !== pastLeague) return false
      return true
    }
    if (past) return false
    if (tab !== 'all' && g.sport !== tab) return false
    if (tab !== 'all' && subLeague !== 'all' && g.league !== subLeague) return false
    return true
  })
  const sorted = [...filtered].sort((a, b) =>
    isPastView ? (b.starts_at > a.starts_at ? 1 : -1) : (a.starts_at > b.starts_at ? 1 : -1)
  )
  const activeSports = SPORT_GROUPS.filter(sg => games.some(g => sg.leagues.includes(g.league) && !isInPast(g.starts_at)))
  const currentSportGroup = SPORT_GROUPS.find(sg => sg.key === tab)
  const subLeagues = currentSportGroup
    ? currentSportGroup.leagues.filter(l => games.some(g => g.league === l && !isInPast(g.starts_at)))
    : []
  const pastLeagues = ALL_LEAGUES.filter(l => games.some(g => g.league === l && isInPast(g.starts_at)))

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* ── 헤더 ── */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-100 px-4 pb-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}>
        <div className="flex justify-between items-center mb-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">샤프시그널</h1>
            <div className="text-xs text-slate-400 mt-0.5">실시간 라인 모니터</div>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <button onClick={() => setShowAdmin(true)}
                className="text-xs font-semibold text-violet-600 bg-violet-50 px-3 py-1.5 rounded-full">
                관리자
              </button>
            )}
            {!isAdmin && (() => {
              const subEnd = sub?.sub_expires_at ? new Date(sub.sub_expires_at) : null
              const subDays = subEnd && subEnd > new Date()
                ? Math.ceil((subEnd - Date.now()) / 86400000) : 0
              if (subDays > 0) return (
                <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full">
                  구독 {subDays}일 남음
                </span>
              )
              if (daysLeft > 0) return (
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                  daysLeft <= 2 ? 'text-rose-500 bg-rose-50' : 'text-indigo-500 bg-indigo-50'
                }`}>
                  체험 {daysLeft}일 남음
                </span>
              )
              return null
            })()}
            <button onClick={fetchGames}
              className="text-xs font-semibold text-slate-500 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 px-3 py-1.5 rounded-full transition-colors">
              {lastUpdate ? `갱신 ${lastUpdate}` : '새로고침'}
            </button>
            {user ? (
              <button onClick={onSignOut}
                className="text-xs font-semibold text-slate-400 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 px-3 py-1.5 rounded-full transition-colors">
                로그아웃
              </button>
            ) : (
              <button onClick={onSignIn}
                className="text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 px-3 py-1.5 rounded-full transition-colors">
                로그인
              </button>
            )}
          </div>
        </div>

        {/* 조합 탭 - 단독 상단 행 */}
        <div className="flex mb-2">
          <button
            onClick={() => { setTab('combo'); setSubLeague('all') }}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all
              ${tab === 'combo'
                ? 'bg-violet-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-500'}`}>
            시그널 픽
          </button>
        </div>

        {/* 스포츠 탭 */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          <button
            onClick={() => { setTab('all'); setSubLeague('all') }}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-all
              ${tab === 'all' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>
            전체
          </button>
          {activeSports.map(sg => (
            <button key={sg.key}
              onClick={() => { setTab(sg.key); setSubLeague('all') }}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-all
                ${tab === sg.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>
              {sg.label}
            </button>
          ))}
          <button
            onClick={() => { setTab('past'); setPastLeague('all') }}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-all
              ${tab === 'past' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>
            지난경기
          </button>
        </div>

        {/* 서브리그 필터 */}
        {currentSportGroup && subLeagues.length > 1 && tab !== 'combo' && (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide mt-2">
            <button onClick={() => setSubLeague('all')}
              className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all
                ${subLeague === 'all' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}>
              전체
            </button>
            {subLeagues.map(l => (
              <button key={l} onClick={() => setSubLeague(l)}
                className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all
                  ${subLeague === l ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}>
                {LEAGUE_FLAGS[l]} {l}
              </button>
            ))}
          </div>
        )}

        {/* 지난경기 필터 */}
        {isPastView && (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide mt-2">
            <button onClick={() => setPastLeague('all')}
              className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all
                ${pastLeague === 'all' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}>
              전체
            </button>
            {pastLeagues.map(l => (
              <button key={l} onClick={() => setPastLeague(l)}
                className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all
                  ${pastLeague === l ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}>
                {LEAGUE_FLAGS[l]} {l}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── 컨텐츠 ── */}
      <div className="px-4 py-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
        {loading ? (
          <div className="text-center text-slate-400 py-20 text-sm">불러오는 중...</div>
        ) : isComboView ? (
          <SignalView games={games} hasAccess={hasAccess}
            onShowUpgrade={user ? () => setShowUpgrade(true) : onSignIn} />
        ) : filtered.length === 0 ? (
          <div className="text-center text-slate-400 py-20 text-sm">경기 없음</div>
        ) : (
          sorted.map(g => <GameCard key={g.matchup_id} game={g}
            hasAccess={hasAccess} onShowUpgrade={user ? () => setShowUpgrade(true) : onSignIn}
            onClick={() => setSelected(g)} />)
        )}
      </div>

      {selected && <HistoryModal game={selected} onClose={() => setSelected(null)} />}
      {showAdmin && <AdminScreen onClose={() => setShowAdmin(false)} />}
      {showUpgrade && <UpgradeModal onClose={() => setShowUpgrade(false)} />}
    </div>
  )
}

// ── 앱 진입점 (인증 래퍼) ────────────────────────────────────
export default function App() {
  const [user, setUser]             = useState(null)
  const [sub, setSub]               = useState(null)
  const [authReady, setReady]       = useState(false)
  const [showTrialPrompt, setShowTrialPrompt] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) loadSub(session.user.id)
      setReady(true)
    })

    const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange(async (_e, session) => {
      setUser(session?.user ?? null)
      if (session?.user) loadSub(session.user.id)
      else { setSub(null); setShowTrialPrompt(false) }
    })

    CapApp.addListener('appUrlOpen', async ({ url }) => {
      if (url?.startsWith('com.sharpsignal.app://auth-callback')) {
        await Browser.close()
        const hash   = url.split('#')[1] || ''
        const params = new URLSearchParams(hash)
        const access_token  = params.get('access_token')
        const refresh_token = params.get('refresh_token')
        if (access_token) {
          const { data } = await supabase.auth.setSession({ access_token, refresh_token })
          if (data.user) loadSub(data.user.id)
        }
      }
    })

    return () => authSub.unsubscribe()
  }, [])

  async function loadSub(userId) {
    const { data } = await supabase.from('subscriptions').select('*').eq('user_id', userId).maybeSingle()
    if (!data) {
      // 첫 로그인: 구독 레코드 생성
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: inserted } = await supabase
          .from('subscriptions').insert({ user_id: user.id, email: user.email })
          .select().maybeSingle()
        setSub(inserted)
        setShowTrialPrompt(true) // 신규 유저 → 체험 프롬프트
      }
    } else {
      setSub(data)
      // 체험도 구독도 없으면 프롬프트 표시
      if (!data.trial_started_at && !data.sub_expires_at) setShowTrialPrompt(true)
    }
  }

  async function signInWithGoogle() {
    const isNative = Capacitor.isNativePlatform()
    // 네이티브: Vercel URL로 redirect → 앱이 auth 상태변화 감지
    const redirectTo = 'https://pinnacle-bot.vercel.app'
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: isNative },
    })
    if (!error && isNative && data?.url) {
      await Browser.open({ url: data.url, presentationStyle: 'fullscreen' })
    }
  }

  async function signOut() {
    await supabase.auth.signOut()
    setUser(null); setSub(null); setShowTrialPrompt(false)
  }

  function handleTrialStart() {
    setShowTrialPrompt(false)
    // sub 재조회
    if (user) loadSub(user.id)
  }

  // 웹 브라우저 접속 차단 (앱 전용)
  if (!Capacitor.isNativePlatform()) {
    const hash = window.location.hash
    // OAuth 콜백 → 토큰을 앱 딥링크로 릴레이
    if (hash.includes('access_token=')) {
      window.location.href = `com.sharpsignal.app://auth-callback${hash}`
      return null
    }
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-indigo-600 flex items-center justify-center mb-5">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-slate-900 mb-2">샤프시그널</h1>
        <p className="text-slate-500 text-sm mb-6">앱 전용 서비스입니다.<br/>안드로이드 앱에서 이용해주세요.</p>
        <a href="https://play.google.com/store/apps/details?id=com.sharpsignal.app"
          className="bg-indigo-600 text-white text-sm font-semibold px-6 py-3 rounded-2xl">
          Play Store에서 다운로드
        </a>
      </div>
    )
  }

  if (!authReady) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-slate-400 text-sm">로딩 중...</div>
    </div>
  )

  const isAdmin   = user ? user.email === ADMIN_EMAIL : false
  const isOnTrial = sub?.trial_started_at &&
    new Date(new Date(sub.trial_started_at).getTime() + TRIAL_DAYS * 86400000) > new Date()
  const isSubbed  = sub?.sub_expires_at && new Date(sub.sub_expires_at) > new Date()
  const hasAccess = isAdmin || isOnTrial || isSubbed

  return (
    <>
      <MainApp
        user={user}
        isAdmin={isAdmin}
        hasAccess={hasAccess}
        sub={sub}
        onSignOut={signOut}
        onSignIn={signInWithGoogle}
      />
      {showTrialPrompt && !isAdmin && (
        <TrialPromptModal
          onStart={handleTrialStart}
          onDecline={() => setShowTrialPrompt(false)}
        />
      )}
    </>
  )
}
