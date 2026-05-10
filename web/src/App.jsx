import { useState, useEffect, useRef, useMemo, Component } from 'react'
import { supabase } from './supabase'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { Device } from '@capacitor/device'

// ── Betman 직접 호출 (앱에서 직접, CORS 우회) ────────────────────
const BETMAN_BUYABLE_API = 'https://www.betman.co.kr/buyPsblGame/inqCacheBuyAbleGameInfoList.do'
const BETMAN_BUYABLE_URL = 'https://www.betman.co.kr/main/mainPage/gamebuy/buyableGameList.do'
const BETMAN_GAME_API    = 'https://www.betman.co.kr/buyPsblGame/gameInfoInq.do'
const BETMAN_GAMESLIP    = 'https://www.betman.co.kr/main/mainPage/gamebuy/gameSlip.do'
const BETMAN_HIDDEN      = ['SUM', '전반', '승1패']
const BETMAN_SPORT_MAP   = { BS: 'baseball', BK: 'basketball', SC: 'soccer' }
const BETMAN_HEADERS     = {
  'Content-Type': 'application/json; charset=UTF-8',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0',
}

function betmanKstDate(ms) {
  if (!ms) return ''
  const d = new Date(parseInt(ms) + 9 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}
function betmanPct(c, t) { return t ? Math.round(c * 1000 / t) / 10 : 0 }
function betmanAmt(c, total, sell) {
  return (c && total && sell) ? Math.round(sell * c / total) : 0
}

function parseBetmanData(data) {
  const votes = {}
  for (const v of (data.voteStatus || [])) votes[parseInt(v.GM_SEQ)] = v
  const totalSell = parseInt(data.currentLottery?.totalSellAmount || 0)
  const keys = data.compSchedules?.keys || []
  const rawRows = []

  for (const rawRow of (data.compSchedules?.datas || [])) {
    const s = Object.fromEntries(keys.map((k, i) => [k, rawRow[i]]))
    const market = s.betNm || s.betTypNm || ''
    if (BETMAN_HIDDEN.some(k => market.includes(k))) continue
    const seq = parseInt(s.matchSeq)
    const v = votes[seq] || {}
    const wc = parseInt(v.W_BET_CNT || 0)
    const dc = parseInt(v.D_BET_CNT || 0)
    const lc = parseInt(v.L_BET_CNT || 0)
    const tot = wc + dc + lc
    rawRows.push({
      gameDate: betmanKstDate(s.gameDate), itemCode: s.itemCode || '',
      league: s.leagueShortName || s.leagueName || '',
      home: s.homeName || '', away: s.awayName || '',
      market, base: s.winHandi || s.loseHandi || '',
      winTxt: s.winTxt || '', winCount: wc, winPct: betmanPct(wc, tot), winAmt: betmanAmt(wc, tot, totalSell),
      drawTxt: s.drawTxt || '', drawCount: dc, drawPct: betmanPct(dc, tot), drawAmt: betmanAmt(dc, tot, totalSell),
      loseTxt: s.loseTxt || '', loseCount: lc, losePct: betmanPct(lc, tot), loseAmt: betmanAmt(lc, tot, totalSell),
      totalCount: tot, totalSell,
    })
  }

  const grouped = {}
  for (const r of rawRows) {
    const sport = BETMAN_SPORT_MAP[r.itemCode]
    if (!sport || !r.gameDate) continue
    const key = `${sport}|${r.league}|${r.home}|${r.away}|${r.gameDate}`
    if (!grouped[key]) {
      grouped[key] = {
        sport, league: r.league, home: r.home, away: r.away,
        home_abbr: r.home, away_abbr: r.away,
        game_date: r.gameDate, updated_at: new Date().toISOString(),
        totalSell: r.totalSell,
      }
    }
    const t = grouped[key]
    const { market, winTxt, loseTxt, drawTxt } = r
    if (market.includes('언더오버') || market.includes('언더/오버')) {
      if (winTxt.includes('언더'))  { t.ou_bets_under = r.winPct;  t.ou_bets_under_count = r.winCount;  t.ou_bets_under_amount = r.winAmt }
      if (winTxt.includes('오버'))  { t.ou_bets_over  = r.winPct;  t.ou_bets_over_count  = r.winCount;  t.ou_bets_over_amount  = r.winAmt }
      if (loseTxt.includes('언더')) { t.ou_bets_under = r.losePct; t.ou_bets_under_count = r.loseCount; t.ou_bets_under_amount = r.loseAmt }
      if (loseTxt.includes('오버')) { t.ou_bets_over  = r.losePct; t.ou_bets_over_count  = r.loseCount; t.ou_bets_over_amount  = r.loseAmt }
      t.ou_base = r.base
    } else if (market.includes('핸디')) {
      t.sp_bets_home = r.winPct;  t.sp_bets_home_count = r.winCount;  t.sp_bets_home_amount = r.winAmt
      t.sp_bets_draw = r.drawPct; t.sp_bets_draw_count = r.drawCount; t.sp_bets_draw_amount = r.drawAmt
      t.sp_bets_away = r.losePct; t.sp_bets_away_count = r.loseCount; t.sp_bets_away_amount = r.loseAmt
      t.sp_base = r.base
    } else if (market.includes('승무패') || market.includes('승패')) {
      t.ml_bets_home = r.winPct;  t.ml_bets_home_count = r.winCount;  t.ml_bets_home_amount = r.winAmt
      if (drawTxt && drawTxt !== '-') {
        t.ml_bets_draw = r.drawPct; t.ml_bets_draw_count = r.drawCount; t.ml_bets_draw_amount = r.drawAmt
      }
      t.ml_bets_away = r.losePct; t.ml_bets_away_count = r.loseCount; t.ml_bets_away_amount = r.loseAmt
    }
  }
  return Object.values(grouped)
}

// ── 에러 경계: 렌더 크래시 시 흰 화면 대신 에러 메시지 표시 ─────
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(e) { return { error: e } }
  componentDidCatch(e, info) { console.error('[ErrorBoundary]', e, info) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', background: '#fff0f0', minHeight: '100vh' }}>
          <h2 style={{ color: '#c00', marginBottom: 8 }}>렌더 에러</h2>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#333' }}>
            {String(this.state.error)}{'\n\n'}{this.state.error?.stack}
          </pre>
          <button style={{ marginTop: 16, padding: '8px 16px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8 }}
            onClick={() => this.setState({ error: null })}>
            다시 시도
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const ADMIN_EMAIL  = import.meta.env.VITE_ADMIN_EMAIL
const API_BASE     = Capacitor.isNativePlatform() ? 'https://pinnacle-bot.vercel.app' : ''
const GAMES_API    = 'https://sharpsignal.cloud'   // 토토 games API (Vercel 대체)
const TRIAL_DAYS   = 7
const BANK_INFO    = { bank: '케이뱅크', account: '100201371989', holder: '김형인', kakao: 'sharpsignal' }
const PLANS        = [
  { label: '1일',  days: 1,  price: '5,500원' },
  { label: '10일', days: 10, price: '55,000원' },
  { label: '30일', days: 30, price: '150,000원' },
]

async function getDeviceId() {
  // 네이티브(Android): 시스템 Android ID 사용 → 재설치해도 유지, 앱 데이터 초기화로 우회 불가
  if (Capacitor.isNativePlatform()) {
    try {
      const info = await Device.getId()
      return info.identifier   // Android ID (64-bit hex, 앱 서명키 + 기기 조합 고유값)
    } catch (e) {}
  }
  // 웹 fallback: localStorage UUID
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
      ? 'https://pinnacle-bot.vercel.app'
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

// ── 마이페이지 ─────────────────────────────────────────────────
const NOTICES_API = 'https://sharpsignal.cloud/api/notices'

function MyPage({ user, sub, onSignOut, onShowUpgrade, onClose }) {
  const [notices, setNotices]   = useState([])
  const [loadingN, setLoadingN] = useState(true)
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    fetch(NOTICES_API)
      .then(r => r.json())
      .then(d => { setNotices(Array.isArray(d) ? d : []); setLoadingN(false) })
      .catch(() => setLoadingN(false))
  }, [])

  const isAdmin = user?.email === ADMIN_EMAIL

  const now     = new Date()
  const subEnd  = sub?.sub_expires_at  ? new Date(sub.sub_expires_at)  : null
  const trialEnd = sub?.trial_started_at
    ? new Date(new Date(sub.trial_started_at).getTime() + TRIAL_DAYS * 86400000) : null
  const subDays   = subEnd  && subEnd  > now ? Math.ceil((subEnd  - now) / 86400000) : 0
  const trialDays = trialEnd && trialEnd > now ? Math.ceil((trialEnd - now) / 86400000) : 0

  const planLabel = isAdmin ? '관리자' : (sub?.plan || (trialDays > 0 ? '무료 체험' : null))
  const isActive  = isAdmin || subDays > 0 || trialDays > 0
  const daysLeft  = isAdmin ? null : (subDays || trialDays)
  const expiryDate = isAdmin ? null : (
    subEnd && subEnd > now
      ? subEnd.toLocaleDateString('ko-KR')
      : trialEnd && trialEnd > now
      ? trialEnd.toLocaleDateString('ko-KR')
      : null
  )

  function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString('ko-KR') : '-'
  }

  function openKakao() {
    window.open('https://open.kakao.com/o/s4nnW1ti', '_system')
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col max-w-[520px] mx-auto">
      {/* 헤더 */}
      <div className="bg-white border-b border-slate-100 px-4 pb-3 flex items-center justify-between"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}>
        <h2 className="text-lg font-bold text-slate-900">마이페이지</h2>
        <button onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* 컨텐츠 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 24px)' }}>

        {/* 구독 현황 */}
        <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-bold text-slate-900">구독 현황</span>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              isActive ? 'text-emerald-600 bg-emerald-50' : 'text-rose-500 bg-rose-50'
            }`}>
              {isActive ? '이용중' : '만료됨'}
            </span>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-xs text-slate-400">현재 플랜</span>
              <span className="text-sm font-semibold text-slate-800">{planLabel || '없음'}</span>
            </div>
            {expiryDate && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">만료일</span>
                <span className="text-sm font-semibold text-slate-800">{expiryDate}</span>
              </div>
            )}
            {daysLeft > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">남은 일수</span>
                <span className={`text-sm font-bold ${daysLeft <= 3 ? 'text-rose-500' : 'text-emerald-600'}`}>
                  {daysLeft}일
                </span>
              </div>
            )}
          </div>
          {!isAdmin && (
            <button onClick={onShowUpgrade}
              className="mt-3 w-full py-2.5 bg-indigo-600 text-white text-sm font-bold rounded-xl active:bg-indigo-700 transition-colors">
              {isActive ? '구독 연장' : '구독하기'}
            </button>
          )}
        </div>

        {/* 계정 정보 */}
        <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
          <span className="text-sm font-bold text-slate-900 block mb-3">계정 정보</span>
          <div className="flex justify-between items-center">
            <span className="text-xs text-slate-400">이메일</span>
            <span className="text-sm text-slate-700 font-medium">{user?.email || '-'}</span>
          </div>
          {sub?.created_at && (
            <div className="flex justify-between items-center mt-2">
              <span className="text-xs text-slate-400">가입일</span>
              <span className="text-sm text-slate-700">{fmtDate(sub.created_at)}</span>
            </div>
          )}
        </div>

        {/* 공지사항 */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-50">
            <span className="text-sm font-bold text-slate-900">공지사항</span>
          </div>
          {loadingN ? (
            <div className="text-center py-6 text-slate-400 text-sm">불러오는 중...</div>
          ) : notices.length === 0 ? (
            <div className="text-center py-6 text-slate-400 text-sm">공지사항이 없습니다</div>
          ) : notices.map(n => (
            <div key={n.id}
              className="px-4 py-3 border-b border-slate-50 last:border-0 cursor-pointer active:bg-slate-50"
              onClick={() => setExpanded(expanded === n.id ? null : n.id)}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800 flex-1 pr-2">{n.title}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-slate-400">
                    {new Date(n.created_at).toLocaleDateString('ko-KR')}
                  </span>
                  <svg className={`w-4 h-4 text-slate-300 transition-transform ${expanded === n.id ? 'rotate-180' : ''}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 9l6 6 6-6"/>
                  </svg>
                </div>
              </div>
              {expanded === n.id && n.content && (
                <div className="mt-2 text-sm text-slate-600 leading-relaxed whitespace-pre-line">
                  {n.content}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* 문의하기 */}
        <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
          <span className="text-sm font-bold text-slate-900 block mb-3">문의하기</span>
          <button onClick={openKakao}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-yellow-400 text-slate-900 text-sm font-bold rounded-xl active:bg-yellow-500 transition-colors">
            <span>💬</span>
            카카오톡 오픈채팅 문의
          </button>
          <div className="text-xs text-slate-400 text-center mt-2">카카오톡 ID: {BANK_INFO.kakao}</div>
        </div>

        {/* 앱 버전 */}
        <div className="text-center text-xs text-slate-300 py-1">Sharp Signal v1.2</div>

        {/* 로그아웃 */}
        <button onClick={() => { onSignOut(); onClose() }}
          className="w-full py-3 border border-slate-200 text-slate-500 text-sm font-semibold rounded-2xl active:bg-slate-50 transition-colors">
          로그아웃
        </button>
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
    const deviceId = await getDeviceId()
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
  const [adminTab, setAdminTab]   = useState('users')  // 'users' | 'notices'
  const [users, setUsers]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [extending, setExt]       = useState(null)
  // 공지사항
  const [notices, setNotices]     = useState([])
  const [nTitle, setNTitle]       = useState('')
  const [nContent, setNContent]   = useState('')
  const [nSaving, setNSaving]     = useState(false)
  const [nDeleting, setNDeleting] = useState(null)

  useEffect(() => {
    if (adminTab === 'users') loadUsers()
    else loadNotices()
  }, [adminTab])

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

  async function loadNotices() {
    setLoading(true)
    const res = await fetch(NOTICES_API)
    setNotices(await res.json())
    setLoading(false)
  }

  async function saveNotice() {
    if (!nTitle.trim()) return
    setNSaving(true)
    const token = await getToken()
    await fetch(NOTICES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: nTitle.trim(), content: nContent.trim() }),
    })
    setNTitle(''); setNContent('')
    await loadNotices()
    setNSaving(false)
  }

  async function deleteNotice(id) {
    setNDeleting(id)
    const token = await getToken()
    await fetch(`${NOTICES_API}/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    await loadNotices()
    setNDeleting(null)
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
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col max-w-[520px] mx-auto">
      {/* 헤더 */}
      <div className="bg-white border-b border-slate-100 px-4 pb-0 flex flex-col"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-slate-900">관리자 패널</h2>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-400">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        {/* 탭 */}
        <div className="flex gap-1 pb-0">
          {[['users','회원 관리'],['notices','공지사항']].map(([key, label]) => (
            <button key={key} onClick={() => setAdminTab(key)}
              className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
                adminTab === key
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-slate-400'
              }`}>{label}</button>
          ))}
        </div>
      </div>

      {/* 컨텐츠 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>

        {/* 회원 관리 탭 */}
        {adminTab === 'users' && (loading ? (
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
        }))}

        {/* 공지사항 탭 */}
        {adminTab === 'notices' && (<>
          {/* 작성 폼 */}
          <div className="bg-white rounded-2xl p-4 border border-slate-100">
            <div className="text-sm font-bold text-slate-900 mb-3">새 공지 작성</div>
            <input
              value={nTitle} onChange={e => setNTitle(e.target.value)}
              placeholder="제목"
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm mb-2 outline-none focus:border-indigo-400"
            />
            <textarea
              value={nContent} onChange={e => setNContent(e.target.value)}
              placeholder="내용 (선택)"
              rows={3}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm mb-3 outline-none focus:border-indigo-400 resize-none"
            />
            <button onClick={saveNotice} disabled={nSaving || !nTitle.trim()}
              className="w-full py-2.5 bg-indigo-600 text-white text-sm font-bold rounded-xl disabled:opacity-40 active:bg-indigo-700">
              {nSaving ? '저장 중...' : '공지 등록'}
            </button>
          </div>

          {/* 기존 공지 목록 */}
          {loading ? (
            <div className="text-center py-6 text-slate-400 text-sm">불러오는 중...</div>
          ) : notices.length === 0 ? (
            <div className="text-center py-6 text-slate-400 text-sm">공지사항 없음</div>
          ) : notices.map(n => (
            <div key={n.id} className="bg-white rounded-2xl p-4 border border-slate-100">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900">{n.title}</div>
                  {n.content && <div className="text-xs text-slate-500 mt-1 whitespace-pre-line">{n.content}</div>}
                  <div className="text-xs text-slate-300 mt-1">
                    {new Date(n.created_at).toLocaleDateString('ko-KR')}
                  </div>
                </div>
                <button onClick={() => deleteNotice(n.id)} disabled={nDeleting === n.id}
                  className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-rose-50 text-rose-400 active:bg-rose-100 disabled:opacity-40">
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                    <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </>)}
      </div>
    </div>
  )
}

// ── 파워볼 분석기 탭 ───────────────────────────────────────────
const PB_API = 'https://sharpsignal.cloud/api/powerball'

const PB_CATS = [
  { key: 'pb_odd', label: '파워볼 홀/짝',    short: 'P홀짝', a: '홀',  b: '짝',  aCs: 'text-rose-600 bg-rose-50',     bCs: 'text-blue-600 bg-blue-50'    },
  { key: 'pb_ou',  label: '파워볼 언더/오버', short: 'P언오', a: '언더', b: '오버', aCs: 'text-blue-600 bg-blue-50',     bCs: 'text-orange-600 bg-orange-50'},
  { key: 'nb_odd', label: '일반볼 홀/짝',    short: 'N홀짝', a: '홀',  b: '짝',  aCs: 'text-rose-600 bg-rose-50',     bCs: 'text-blue-600 bg-blue-50'    },
  { key: 'nb_ou',  label: '일반볼 언더/오버', short: 'N언오', a: '언더', b: '오버', aCs: 'text-blue-600 bg-blue-50',     bCs: 'text-orange-600 bg-orange-50'},
]

function fmtCd(sec) {
  const m = Math.floor(sec / 60), s = sec % 60
  return `${m}:${String(s).padStart(2,'0')}`
}

function resultChip(label, val) {
  const colorMap = {
    '홀':  'text-rose-600 bg-rose-50',
    '짝':  'text-blue-600 bg-blue-50',
    '오버':'text-orange-600 bg-orange-50',
    '언더':'text-blue-600 bg-blue-50',
  }
  const cs = colorMap[val] || 'text-slate-600 bg-slate-100'
  return (
    <span className={`text-sm font-bold px-3 py-1.5 rounded-full ${cs}`}>
      <span className="text-slate-400 font-medium">{label} </span>{val}
    </span>
  )
}

function pickChip(val) {
  const colorMap = {
    '홀':  'text-rose-600 bg-rose-50 border border-rose-200',
    '짝':  'text-blue-600 bg-blue-50 border border-blue-200',
    '오버':'text-orange-600 bg-orange-50 border border-orange-200',
    '언더':'text-blue-600 bg-blue-50 border border-blue-200',
  }
  if (!val) return <span className="text-xs text-slate-300">-</span>
  return <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${colorMap[val] || ''}`}>{val}</span>
}

function PowerballTab({ hasAccess, user, onShowUpgrade, onSignIn }) {
  const [data, setData]         = useState(null)
  const [loading, setLoading]   = useState(true)
  const [countdown, setCountdown] = useState(0)
  const [rankTab, setRankTab]   = useState('pb_odd')
  const [expandedAlgo, setExpandedAlgo] = useState(null)
  const fastPollRef = useRef(null)

  useEffect(() => {
    loadData()
    const iv = setInterval(loadData, 30000)   // 30초마다 백그라운드 갱신
    return () => { clearInterval(iv); clearTimeout(fastPollRef.current) }
  }, [])

  // next_draw_epoch 기준 카운트다운 — 서버 시각에서 계산해서 오차 없음
  useEffect(() => {
    if (!data?.next_draw_epoch) return
    const tick = () => {
      const sec = Math.max(0, Math.round(data.next_draw_epoch - Date.now() / 1000))
      setCountdown(sec)
      // 추첨 시간 지나면 빠르게 새 데이터 폴링 (10초마다, 최대 2분)
      if (sec === 0) {
        let tries = 0
        const poll = () => {
          if (tries++ > 12) return
          loadData()
          fastPollRef.current = setTimeout(poll, 10000)
        }
        clearTimeout(fastPollRef.current)
        fastPollRef.current = setTimeout(poll, 5000)
      }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [data?.next_draw_epoch])

  async function loadData() {
    try {
      const res  = await fetch(PB_API)
      const json = await res.json()
      if (!json.error) {
        setData(json)
        setLoading(false)
      } else {
        // 서버 캐시 아직 준비중 → 3초 후 재시도
        setTimeout(loadData, 3000)
      }
    } catch(e) {
      setLoading(false)
    }
  }

  if (!hasAccess) {
    return (
      <div className="px-4 pt-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
        <LockBox
          label="구독 후 파워볼 패턴을 이용할 수 있습니다"
          onUnlock={user ? onShowUpgrade : onSignIn}
          isGuest={!user}
        />
      </div>
    )
  }

  if (loading) return <div className="text-center py-20 text-slate-400 text-sm">불러오는 중...</div>
  if (!data || data.error) return <div className="text-center py-20 text-slate-400 text-sm">데이터 없음</div>

  const { latest, predictions, algo_rankings, today_rounds, current_round, next_round } = data
  const rankings = algo_rankings?.[rankTab] || []

  return (
    <div className="px-4 py-4 space-y-4"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>

      {/* ── 현재 회차 + 카운트다운 ── */}
      <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
        <div className="flex justify-between items-center mb-3">
          <div>
            <div className="text-xs text-slate-400">오늘 {today_rounds}회차 진행</div>
            <div className="text-sm font-bold text-slate-700 mt-0.5">{current_round}회차 결과</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-400">다음 추첨</div>
            <div className={`text-2xl font-bold tabular-nums mt-0.5 ${countdown < 60 ? 'text-rose-500 animate-pulse' : 'text-indigo-600'}`}>
              {countdown === 0 ? '집계중...' : fmtCd(countdown)}
            </div>
          </div>
        </div>
        {/* 결과 태그 — 2x2 그리드 */}
        <div className="grid grid-cols-2 gap-2">
          {resultChip('파워볼', latest.pb_odd)}
          {resultChip('파워볼', latest.pb_ou)}
          {resultChip('일반볼', latest.nb_odd)}
          {resultChip('일반볼', latest.nb_ou)}
        </div>
      </div>

      {/* ── 다음 회차 예측 ── */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-50 flex items-center justify-between">
          <span className="text-sm font-bold text-slate-900">다음 회차 예측</span>
          <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full">{next_round}회차</span>
        </div>

        {today_rounds < 20 ? (
          <div className="text-center py-8 text-slate-400 text-sm">
            ⏳ 20회차 이후 예측 시작
            <div className="text-xs mt-1">{20 - today_rounds}회 남음</div>
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {PB_CATS.map(cat => {
              const pred = predictions[cat.key]
              if (!pred) return (
                <div key={cat.key} className="px-4 py-3 flex justify-between items-center">
                  <span className="text-sm text-slate-600">{cat.label}</span>
                  <span className="text-xs text-slate-300">분석중...</span>
                </div>
              )
              const isA = pred.prediction === cat.a
              const chipCs = isA ? cat.aCs : cat.bCs
              const streakTxt = pred.win_streak > 0
                ? <span className="text-xs font-bold text-emerald-600">🔥 {pred.win_streak}연승</span>
                : pred.lose_streak > 0
                ? <span className="text-xs text-rose-400">{pred.lose_streak}연패</span>
                : null
              // 해당 카테고리에서 이 알고리즘의 순위 계산
              const rankList = algo_rankings?.[cat.key] || []
              const rankIdx  = rankList.findIndex(r => r.algo === pred.algo)
              const rankNum  = rankIdx >= 0 ? rankIdx + 1 : null
              return (
                <div key={cat.key} className="px-4 py-3 flex justify-between items-center gap-2">
                  <span className="text-sm font-medium text-slate-700">{cat.label}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-right">
                      <div className="text-xs text-slate-400">
                        {pred.label} {Math.round(pred.rate*100)}%
                        {rankNum && (
                          <span className="ml-1 text-indigo-400 font-semibold">[{cat.short} {rankNum}위]</span>
                        )}
                      </div>
                      <div className="text-xs">{streakTxt}</div>
                    </div>
                    <span className={`text-sm font-bold px-3 py-1.5 rounded-full min-w-[48px] text-center ${chipCs}`}>
                      {pred.prediction}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── 알고리즘 순위 ── */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-4 pt-3 pb-0 border-b border-slate-100">
          <div className="text-sm font-bold text-slate-900 mb-2">알고리즘 순위 (오늘)</div>
          <div className="flex gap-1 overflow-x-auto pb-0 scrollbar-hide">
            {PB_CATS.map(cat => (
              <button key={cat.key} onClick={() => { setRankTab(cat.key); setExpandedAlgo(null) }}
                className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg whitespace-nowrap border-b-2 transition-colors ${
                  rankTab === cat.key
                    ? 'border-indigo-500 text-indigo-600 bg-indigo-50'
                    : 'border-transparent text-slate-400'
                }`}>
                {cat.short}
              </button>
            ))}
          </div>
        </div>

        {today_rounds < 20 ? (
          <div className="text-center py-6 text-slate-400 text-sm">20회차 이후 표시</div>
        ) : rankings.length === 0 ? (
          <div className="text-center py-6 text-slate-400 text-sm">데이터 없음</div>
        ) : (
          <div>
            {rankings.map((r, i) => {
              const streakEl = r.win_streak > 0
                ? <span className="text-emerald-600 font-bold text-xs">🔥 {r.win_streak}연승</span>
                : r.lose_streak > 0
                ? <span className="text-rose-400 text-xs">{r.lose_streak}연패</span>
                : <span className="text-slate-300 text-xs">-</span>
              const isTop = i === 0
              const isExpanded = expandedAlgo === `${rankTab}_${r.algo}`
              const oxList = r.ox || []
              return (
                <div key={r.algo} className={`border-t border-slate-50 ${isTop ? 'bg-emerald-50/60' : ''}`}>
                  {/* 순위 행 — 탭하면 O/X 상세 토글 */}
                  <div
                    className="flex items-center justify-between px-4 py-2.5 active:bg-slate-50 cursor-pointer"
                    onClick={() => setExpandedAlgo(isExpanded ? null : `${rankTab}_${r.algo}`)}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-xs font-bold w-5 text-center shrink-0 ${isTop ? 'text-emerald-600' : 'text-slate-300'}`}>
                        {i + 1}
                      </span>
                      <div className="min-w-0">
                        <div className={`text-sm font-semibold truncate ${isTop ? 'text-emerald-700' : 'text-slate-700'}`}>
                          {r.label}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-xs text-slate-400">{r.correct}/{r.total}회</span>
                          {streakEl}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-slate-300">최다연승 <span className="text-emerald-400 font-semibold">{r.max_win}</span></span>
                          <span className="text-[10px] text-slate-300">최다연패 <span className="text-rose-300 font-semibold">{r.max_lose}</span></span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {pickChip(r.next_pred)}
                      <div className={`text-sm font-bold tabular-nums w-10 text-right ${isTop ? 'text-emerald-600' : 'text-slate-600'}`}>
                        {Math.round(r.rate * 100)}%
                      </div>
                      <span className={`text-slate-300 text-xs transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                    </div>
                  </div>

                  {/* O/X 상세 패널 */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 bg-slate-50/70">
                      <div className="text-[10px] text-slate-400 mb-2">
                        전체 {oxList.length}회 예측 기록 (오래된 순 → 최신)
                      </div>
                      {oxList.length === 0 ? (
                        <div className="text-xs text-slate-300 text-center py-3">기록 없음</div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {oxList.map((item, idx) => (
                            <div key={idx} className="flex flex-col items-center gap-0.5">
                              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                                item.ok
                                  ? 'bg-emerald-500 text-white'
                                  : 'bg-rose-400 text-white'
                              }`}>
                                {item.ok ? 'O' : 'X'}
                              </div>
                              <span className="text-[9px] text-slate-300 tabular-nums">{item.r}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
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

function fmtCount(count) {
  const n = Number(count)
  return Number.isFinite(n) && n > 0 ? n.toLocaleString('ko-KR') : null
}

function fmtMoney(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}억`
  if (n >= 10000) return `${Math.round(n / 10000).toLocaleString('ko-KR')}만`
  return `${n.toLocaleString('ko-KR')}원`
}

function MarketResult({ label, result, base }) {
  if (!result && !base) return null
  return (
    <div className="text-[11px] text-slate-400 mt-1">
      {label}{base ? ` ${base}` : ''}{result ? ` · 결과 ${result}` : ''}
    </div>
  )
}

function PctBar({ label, pct, handle, count, amount }) {
  if (pct == null) return null
  const countLabel = fmtCount(count)
  const amountLabel = fmtMoney(amount)
  return (
    <div className="mb-1.5">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-slate-500 font-medium">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-slate-800 font-semibold">{pct}%</span>
          {handle != null && <span className="text-slate-400">· 금액 {handle}%</span>}
          {countLabel && <span className="text-slate-400">· {countLabel}건</span>}
          {amountLabel && <span className="text-slate-400">· {amountLabel}</span>}
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
  const hasSp = proto.sp_bets_home != null || proto.sp_bets_draw != null || proto.sp_bets_away != null
  const hasOu = proto.ou_bets_over != null || proto.ou_bets_under != null
  if (!hasMl && !hasOu && !hasSp) return null
  const totalSellLabel = proto.totalSell > 0 ? `총 ${fmtMoney(proto.totalSell)}` : null
  return (
    <div className="mt-2 pt-2 border-t border-slate-100">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-slate-400 tracking-wide">국내 구매율</div>
        {totalSellLabel && <div className="text-[10px] text-slate-400">{totalSellLabel} 판매</div>}
      </div>
      <div className="space-y-1">
        {/* 승패 (ML / 승무패) */}
        {proto.ml_bets_home != null && <PctBar label="홈 승"   pct={proto.ml_bets_home} count={proto.ml_bets_home_count} amount={proto.ml_bets_home_amount} />}
        {proto.ml_bets_draw != null && <PctBar label="무"       pct={proto.ml_bets_draw} count={proto.ml_bets_draw_count} amount={proto.ml_bets_draw_amount} />}
        {proto.ml_bets_away != null && <PctBar label="원정 승"  pct={proto.ml_bets_away} count={proto.ml_bets_away_count} amount={proto.ml_bets_away_amount} />}
        <MarketResult label="승무패" result={proto.ml_result} />
        {/* 핸디캡 (농구) */}
        {hasSp && proto.sp_bets_home != null && <PctBar label="홈 핸디"   pct={proto.sp_bets_home} count={proto.sp_bets_home_count} amount={proto.sp_bets_home_amount} />}
        {hasSp && proto.sp_bets_draw != null && <PctBar label="핸디 무"   pct={proto.sp_bets_draw} count={proto.sp_bets_draw_count} amount={proto.sp_bets_draw_amount} />}
        {hasSp && proto.sp_bets_away != null && <PctBar label="원정 핸디" pct={proto.sp_bets_away} count={proto.sp_bets_away_count} amount={proto.sp_bets_away_amount} />}
        <MarketResult label="핸디" result={proto.sp_result} base={proto.sp_base} />
        {/* 언오버 */}
        {hasOu && proto.ou_bets_over  != null && <PctBar label="오버" pct={proto.ou_bets_over} count={proto.ou_bets_over_count} amount={proto.ou_bets_over_amount} />}
        {hasOu && proto.ou_bets_under != null && <PctBar label="언더" pct={proto.ou_bets_under} count={proto.ou_bets_under_count} amount={proto.ou_bets_under_amount} />}
        <MarketResult label="O/U" result={proto.ou_result} base={proto.ou_base} />
      </div>
    </div>
  )
}

// ── 시그널 유틸 ──────────────────────────────────────────────
function getSignalStrength(score) {
  if (score >= 8) return '최강신호'
  if (score >= 7) return '강신호'
  if (score >= 5) return '보통신호'
  return '관찰'
}

function pushScoredSignal(signals, signal, minScore = 5) {
  if (!signal || signal.score < minScore) return
  signals.push({
    type:       signal.type,
    market:     signal.market,
    pick:       signal.pick,
    strength:   getSignalStrength(signal.score),
    score:      signal.score,
    publicSide: signal.publicSide,
    reason:     Array.isArray(signal.reasons) ? signal.reasons.join(' / ') : signal.reason,
  })
}

function buildSignalContext(game) {
  const proto = game.protoBetting
  const pb    = game.publicBetting
  const op    = game.opening || {}
  return {
    proto, pb, op,
    mlHome:  proto?.ml_bets_home  ?? pb?.ml_bets_home,
    mlAway:  proto?.ml_bets_away  ?? pb?.ml_bets_away,
    mlDraw:  proto?.ml_bets_draw  ?? null,
    spHome:  proto?.sp_bets_home  ?? pb?.sp_bets_home,
    spAway:  proto?.sp_bets_away  ?? pb?.sp_bets_away,
    ouOver:  proto?.ou_bets_over  ?? pb?.ou_bets_over,
    ouUnder: proto?.ou_bets_under ?? pb?.ou_bets_under,
  }
}

function oddsMove(open, cur) {
  return open != null && cur != null ? cur - open : null
}

function validSignalTime(game, sport) {
  const hours = hoursUntil(game.starts_at)
  if (hours == null) return false
  return hours <= 3
}

function isTooCloseToStart(game) {
  const hours = hoursUntil(game.starts_at)
  if (hours == null) return true
  return hours < 0.15  // ~9분
}

function addClosingTimeScore(game, score, reasons) {
  const hours = hoursUntil(game.starts_at)
  if (hours == null || hours < 0) return score
  if (hours <= 3 && hours >= 0.5) {
    score += 1
    reasons.push('핵심 진입 구간')
  } else if (hours <= 0.5 && hours >= 0.15) {
    score += 1
    reasons.push('클로징 근접 구간')
  }
  return score
}

// ── O/U 컨텍스트: 기준점 변동 시 배당변동을 역추세 근거로 쓰지 않음 ──
function getOuLineContext(game, ctx) {
  const { op } = ctx
  const openLine    = op.ou_pts
  const currentLine = game.ou_pts
  const lineChanged = openLine != null && currentLine != null && openLine !== currentLine
  const lineMove    = openLine != null && currentLine != null ? currentLine - openLine : null
  const overMove    = op.ou_over  != null && game.ou_over  != null ? game.ou_over  - op.ou_over  : null
  const underMove   = op.ou_under != null && game.ou_under != null ? game.ou_under - op.ou_under : null
  return { openLine, currentLine, lineChanged, lineMove, overMove, underMove }
}

// ── 야구 기준점 버킷 ──────────────────────────────────────────
function getBaseballTotalBucket(league, total) {
  if (total == null) return { bucket: 'UNKNOWN', label: '기준점 알 수 없음', underReverseScore: 0, overReverseScore: 0 }
  if (league === 'KBO') {
    if (total <= 7.0)                      return { bucket: 'VERY_LOW', label: 'KBO 매우 낮은 기준점', underReverseScore:  2, overReverseScore: -2 }
    if (total >= 7.5 && total <= 8.0)      return { bucket: 'LOW',      label: 'KBO 낮은 기준점',      underReverseScore:  1, overReverseScore: -1 }
    if (total >= 8.5 && total <= 9.0)      return { bucket: 'AVERAGE',  label: 'KBO 평균 기준점',      underReverseScore:  0, overReverseScore:  0 }
    if (total >= 10.5)                     return { bucket: 'VERY_HIGH', label: 'KBO 매우 높은 기준점', underReverseScore: -2, overReverseScore:  2 }
    if (total >= 9.5)                      return { bucket: 'HIGH',      label: 'KBO 높은 기준점',      underReverseScore: -1, overReverseScore:  1 }
  }
  if (league === 'NPB') {
    if (total <= 5.0)                      return { bucket: 'VERY_LOW', label: 'NPB 매우 낮은 기준점', underReverseScore:  2, overReverseScore: -2 }
    if (total <= 5.5)                      return { bucket: 'LOW',      label: 'NPB 낮은 기준점',      underReverseScore:  1, overReverseScore: -1 }
    if (total >= 6.0 && total <= 7.0)      return { bucket: 'NORMAL',   label: 'NPB 보통 기준점',      underReverseScore:  0, overReverseScore:  0 }
    if (total >= 8.5)                      return { bucket: 'VERY_HIGH', label: 'NPB 매우 높은 기준점', underReverseScore: -2, overReverseScore:  2 }
    if (total >= 7.5 && total <= 8.0)      return { bucket: 'HIGH',      label: 'NPB 높은 기준점',      underReverseScore: -1, overReverseScore:  1 }
  }
  if (league === 'MLB') {
    if (total <= 7.5)                      return { bucket: 'LOW',       label: 'MLB 낮은 기준점',      underReverseScore:  1, overReverseScore: -1 }
    if (total >= 8.0 && total <= 9.0)      return { bucket: 'NORMAL',    label: 'MLB 보통 기준점',      underReverseScore:  0, overReverseScore:  0 }
    if (total >= 10.5)                     return { bucket: 'VERY_HIGH',  label: 'MLB 매우 높은 기준점', underReverseScore: -2, overReverseScore:  2 }
    if (total >= 9.5)                      return { bucket: 'HIGH',       label: 'MLB 높은 기준점',      underReverseScore: -1, overReverseScore:  1 }
  }
  return { bucket: 'UNKNOWN', label: `${league || ''} 기준점 분류 없음 ${total}`, underReverseScore: 0, overReverseScore: 0 }
}

function addBaseballTotalBucketScore(game, score, reasons, direction) {
  const bucket = getBaseballTotalBucket(game.league, game.ou_pts)
  reasons.push(`${bucket.label} ${game.ou_pts}`)
  if (direction === 'UNDER_REVERSE') score += bucket.underReverseScore
  if (direction === 'OVER_REVERSE')  score += bucket.overReverseScore
  return { score, reasons }
}

function scoreUnderOddsHolding(underMove, reasons) {
  let score = 0
  if (underMove == null)                           { reasons.push('언더 배당변동 없음'); return score }
  if (underMove <= -0.03)                          { score += 3; reasons.push(`언더 배당↓ ${underMove.toFixed(2)}`) }
  else if (underMove >= -0.02 && underMove <= 0.03){ score += 2; reasons.push(`언더 배당 버팀 ${underMove >= 0 ? '+' : ''}${underMove.toFixed(2)}`) }
  else if (underMove > 0.03 && underMove <= 0.08)  { reasons.push(`언더 배당 소폭↑ ${underMove.toFixed(2)} (애매)`) }
  else if (underMove > 0.08 && underMove <= 0.12)  { score -= 1; reasons.push(`언더 배당↑ ${underMove.toFixed(2)} (약화)`) }
  else if (underMove > 0.12)                        { score -= 3; reasons.push(`언더 배당 크게↑ ${underMove.toFixed(2)} (제외)`) }
  return score
}

function baseballUnderReverseSignal(game, ctx) {
  const signals = []
  const { op, ouOver } = ctx
  if (op.ou_pts == null || game.ou_pts == null || ouOver == null) return signals
  const ouCtx = getOuLineContext(game, ctx)

  // 기준점 상승 = 시장 방향이 오버 → 언더 역추세 차단
  if (ouCtx.lineMove != null && ouCtx.lineMove > 0) return signals

  let score = 0
  let reasons = []

  if (ouOver >= 70) { score += 1; reasons.push(`오버 구매율 ${ouOver}%`) }
  if (ouOver >= 80) { score += 1; reasons.push(`오버 과매수 ${ouOver}%`) }
  if (ouOver >= 90) { score += 1; reasons.push(`오버 극단 과매수 ${ouOver}%`) }
  if (ouCtx.lineMove != null && ouCtx.lineMove < 0) { score += 3; reasons.push(`오버 과매수에도 기준점↓ ${ouCtx.openLine}→${ouCtx.currentLine}`) }
  if (ouCtx.lineMove === 0) { score += 1; reasons.push(`오버 과매수에도 기준점 유지 ${ouCtx.currentLine}`) }

  score += scoreUnderOddsHolding(ouCtx.underMove, reasons)

  // 언더 배당이 너무 크게 밀리면 제외
  if (ouCtx.underMove != null && ouCtx.underMove > 0.12) return signals

  const bucketResult = addBaseballTotalBucketScore(game, score, reasons, 'UNDER_REVERSE')
  score = bucketResult.score
  reasons = bucketResult.reasons

  score = addClosingTimeScore(game, score, reasons)
  pushScoredSignal(signals, { type: 'REVERSE', market: 'O/U', pick: '언더', score, publicSide: `오버 ${ouOver}%`, reasons }, 5)
  return signals
}

// ── FOLLOW 공통 함수 ─────────────────────────────────────────
function favoriteFollowSignal(game, ctx, options = {}) {
  const signals = []
  const { op, mlHome, mlAway } = ctx
  const {
    minScore       = 5,
    favBuyHigh     = 70,
    favOddsDropMin = 0.04,
    dogOddsRiseMin = 0.04,
    favOddsMin     = 1.45,
    favOddsMax     = 1.85,
  } = options

  const homeFav = game.ml_home != null && game.ml_away != null && game.ml_home < game.ml_away
  const awayFav = game.ml_home != null && game.ml_away != null && game.ml_away < game.ml_home
  if (!homeFav && !awayFav) return signals

  const favBuy      = homeFav ? mlHome       : mlAway
  const favOpenOdds = homeFav ? op.ml_home   : op.ml_away
  const favCurOdds  = homeFav ? game.ml_home : game.ml_away
  const dogOpenOdds = homeFav ? op.ml_away   : op.ml_home
  const dogCurOdds  = homeFav ? game.ml_away : game.ml_home

  const favMove = oddsMove(favOpenOdds, favCurOdds)
  const dogMove = oddsMove(dogOpenOdds, dogCurOdds)

  let score = 0
  const reasons = []

  if (favBuy != null && favBuy >= favBuyHigh) { score += 1; reasons.push(`정배 구매율 ${favBuy}%`) }
  if (favBuy != null && favBuy >= 80)          { score += 1; reasons.push(`정배 과매수 시장 인정 ${favBuy}%`) }
  if (favMove != null && favMove <= -favOddsDropMin) { score += 2; reasons.push(`정배 배당↓ ${favMove.toFixed(2)}`) }
  if (favMove != null && favMove <= -0.08)     { score += 1; reasons.push('정배 배당 강하락') }
  if (dogMove != null && dogMove >= dogOddsRiseMin)  { score += 1; reasons.push(`상대 배당↑ +${dogMove.toFixed(2)}`) }
  if (favCurOdds != null && favCurOdds >= favOddsMin && favCurOdds <= favOddsMax) {
    score += 1; reasons.push(`적정배당 ${favCurOdds.toFixed(2)}`)
  }
  if (op.sp_pts != null && game.sp_pts != null && op.sp_pts !== game.sp_pts) {
    const favOpenLine = homeFav ? op.sp_pts   : -op.sp_pts
    const favCurLine  = homeFav ? game.sp_pts : -game.sp_pts
    if (favCurLine < favOpenLine) { score += 2; reasons.push(`핸디라인 정배 유리 ${op.sp_pts}→${game.sp_pts}`) }
  }
  score = addClosingTimeScore(game, score, reasons)

  pushScoredSignal(signals, {
    type: 'FOLLOW', market: 'ML',
    pick: homeFav ? '홈 승' : '원정 승',
    score, publicSide: `정배 ${favBuy}%`, reasons,
  }, minScore)

  return signals
}

function overFollowSignal(game, ctx, options = {}) {
  const signals = []
  const { op, ouOver } = ctx
  const { minScore = 5, overBuyHigh = 70, lineMoveMin = 0.5, oddsDropMin = 0.04 } = options

  if (ouOver == null || op.ou_pts == null || game.ou_pts == null) return signals
  const lineMove = game.ou_pts - op.ou_pts

  let score = 0
  const reasons = []

  if (ouOver >= overBuyHigh) { score += 1; reasons.push(`오버 구매율 ${ouOver}%`) }
  if (ouOver >= 80)          { score += 1; reasons.push(`오버 과매수 시장 인정 ${ouOver}%`) }
  if (lineMove >= lineMoveMin) { score += 2; reasons.push(`기준점↑ ${op.ou_pts}→${game.ou_pts}`) }
  if (Math.abs(lineMove) >= 1.5) { score += 1; reasons.push('기준점 강상승') }
  // 기준점 변동 없을 때만 배당 변동을 FOLLOW 근거로 사용
  if (lineMove === 0) {
    if (op.ou_over  != null && game.ou_over  != null) {
      const overMove = game.ou_over - op.ou_over
      if (overMove <= -oddsDropMin) { score += 2; reasons.push(`오버 배당↓ ${overMove.toFixed(2)}`) }
      if (overMove <= -0.08)        { score += 1; reasons.push('오버 배당 강하락') }
    }
    if (op.ou_under != null && game.ou_under != null) {
      const underMove = game.ou_under - op.ou_under
      if (underMove >= oddsDropMin) { score += 1; reasons.push(`언더 배당↑ +${underMove.toFixed(2)}`) }
    }
  }
  score = addClosingTimeScore(game, score, reasons)

  pushScoredSignal(signals, {
    type: 'FOLLOW', market: 'O/U', pick: '오버',
    score, publicSide: `오버 ${ouOver}%`, reasons,
  }, minScore)

  return signals
}

function underFollowSignal(game, ctx, options = {}) {
  const signals = []
  const { op, ouUnder } = ctx
  const { minScore = 5, underBuyHigh = 70, lineMoveMin = 0.5, oddsDropMin = 0.04 } = options

  if (ouUnder == null || op.ou_pts == null || game.ou_pts == null) return signals
  const lineMove = game.ou_pts - op.ou_pts

  let score = 0
  const reasons = []

  if (ouUnder >= underBuyHigh) { score += 1; reasons.push(`언더 구매율 ${ouUnder}%`) }
  if (ouUnder >= 80)           { score += 1; reasons.push(`언더 과매수 시장 인정 ${ouUnder}%`) }
  if (lineMove <= -lineMoveMin) { score += 2; reasons.push(`기준점↓ ${op.ou_pts}→${game.ou_pts}`) }
  if (Math.abs(lineMove) >= 1.5) { score += 1; reasons.push('기준점 강하락') }
  // 기준점 변동 없을 때만 배당 변동을 FOLLOW 근거로 사용
  if (lineMove === 0) {
    if (op.ou_under != null && game.ou_under != null) {
      const underMove = game.ou_under - op.ou_under
      if (underMove <= -oddsDropMin) { score += 2; reasons.push(`언더 배당↓ ${underMove.toFixed(2)}`) }
      if (underMove <= -0.08)        { score += 1; reasons.push('언더 배당 강하락') }
    }
    if (op.ou_over != null && game.ou_over != null) {
      const overMove = game.ou_over - op.ou_over
      if (overMove >= oddsDropMin) { score += 1; reasons.push(`오버 배당↑ +${overMove.toFixed(2)}`) }
    }
  }
  score = addClosingTimeScore(game, score, reasons)

  pushScoredSignal(signals, {
    type: 'FOLLOW', market: 'O/U', pick: '언더',
    score, publicSide: `언더 ${ouUnder}%`, reasons,
  }, minScore)

  return signals
}

// ── 축구 시그널 ──────────────────────────────────────────────
function soccerReverseSignals(game, ctx) {
  const signals = []
  const { op, mlHome, mlAway, ouOver, ouUnder } = ctx
  const homeFav = game.ml_home != null && game.ml_away != null && game.ml_home < game.ml_away
  const awayFav = game.ml_home != null && game.ml_away != null && game.ml_away < game.ml_home
  const spLineChanged = op.sp_pts != null && game.sp_pts != null && game.sp_pts !== op.sp_pts

  // 홈 정배 역추세 → 원정 플핸
  if (homeFav && mlHome != null && mlHome >= 60) {
    const favMove = oddsMove(op.ml_home, game.ml_home)
    const dogMove = oddsMove(op.ml_away, game.ml_away)
    let score = 0; const reasons = []
    if (mlHome >= 72) { score += 2; reasons.push(`홈 구매율 ${mlHome}%`) }
    else              { score += 1; reasons.push(`홈 구매율 ${mlHome}%`) }
    if (favMove != null && favMove >= 0.05) { score += 2; reasons.push(`홈배당↑ +${favMove.toFixed(2)}`) }
    if (dogMove != null && dogMove <= -0.05) { score += 2; reasons.push(`원정배당↓ ${dogMove.toFixed(2)}`) }
    if (spLineChanged && game.sp_pts > op.sp_pts) { score += 2; reasons.push(`핸디 ${op.sp_pts}→${game.sp_pts} (홈 불리)`) }
    score = addClosingTimeScore(game, score, reasons)
    pushScoredSignal(signals, { type: 'REVERSE', market: 'ML', pick: '원정 플핸', score, publicSide: `홈 ${mlHome}%`, reasons })
  }

  // 원정 정배 역추세 → 홈 플핸
  if (awayFav && mlAway != null && mlAway >= 60) {
    const favMove = oddsMove(op.ml_away, game.ml_away)
    const dogMove = oddsMove(op.ml_home, game.ml_home)
    let score = 0; const reasons = []
    if (mlAway >= 72) { score += 2; reasons.push(`원정 구매율 ${mlAway}%`) }
    else              { score += 1; reasons.push(`원정 구매율 ${mlAway}%`) }
    if (favMove != null && favMove >= 0.05) { score += 2; reasons.push(`원정배당↑ +${favMove.toFixed(2)}`) }
    if (dogMove != null && dogMove <= -0.05) { score += 2; reasons.push(`홈배당↓ ${dogMove.toFixed(2)}`) }
    if (spLineChanged && game.sp_pts < op.sp_pts) { score += 2; reasons.push(`핸디 ${op.sp_pts}→${game.sp_pts} (원정 불리)`) }
    score = addClosingTimeScore(game, score, reasons)
    pushScoredSignal(signals, { type: 'REVERSE', market: 'ML', pick: '홈 플핸', score, publicSide: `원정 ${mlAway}%`, reasons })
  }

  // O/U 역추세 (기준점 변동 없을 때만 배당 변동을 역추세 근거로 사용 / 양방향 배당 참조)
  if (ouOver != null && ouUnder != null && op.ou_pts != null && game.ou_pts != null) {
    const ouCtx = getOuLineContext(game, ctx)
    const { lineMove, overMove, underMove } = ouCtx

    if (ouOver >= 60) {
      let score = 0; const reasons = []
      if (ouOver >= 72) { score += 2; reasons.push(`오버 구매율 ${ouOver}%`) }
      else              { score += 1; reasons.push(`오버 구매율 ${ouOver}%`) }
      if (lineMove != null && lineMove <= -0.25) { score += 2; reasons.push(`기준점↓ ${op.ou_pts}→${game.ou_pts}`) }
      if (lineMove === 0 && overMove  != null && overMove  >= 0.05) { score += 2; reasons.push(`오버배당↑ +${overMove.toFixed(2)}`) }
      if (lineMove === 0 && underMove != null && underMove <= -0.05) { score += 1; reasons.push(`언더배당↓ ${underMove.toFixed(2)}`) }
      score = addClosingTimeScore(game, score, reasons)
      pushScoredSignal(signals, { type: 'REVERSE', market: 'O/U', pick: '언더', score, publicSide: `오버 ${ouOver}%`, reasons })
    }

    if (ouUnder >= 60) {
      let score = 0; const reasons = []
      if (ouUnder >= 72) { score += 2; reasons.push(`언더 구매율 ${ouUnder}%`) }
      else               { score += 1; reasons.push(`언더 구매율 ${ouUnder}%`) }
      if (lineMove != null && lineMove >= 0.25) { score += 2; reasons.push(`기준점↑ ${op.ou_pts}→${game.ou_pts}`) }
      if (lineMove === 0 && underMove != null && underMove >= 0.05) { score += 2; reasons.push(`언더배당↑ +${underMove.toFixed(2)}`) }
      if (lineMove === 0 && overMove  != null && overMove  <= -0.05) { score += 1; reasons.push(`오버배당↓ ${overMove.toFixed(2)}`) }
      score = addClosingTimeScore(game, score, reasons)
      pushScoredSignal(signals, { type: 'REVERSE', market: 'O/U', pick: '오버', score, publicSide: `언더 ${ouUnder}%`, reasons })
    }
  }

  return signals
}

function soccerFollowSignals(game, ctx) {
  return [
    ...favoriteFollowSignal(game, ctx, { minScore: 6, favBuyHigh: 70, favOddsDropMin: 0.04, dogOddsRiseMin: 0.04, favOddsMin: 1.45, favOddsMax: 1.90 }),
    ...overFollowSignal(game,  ctx, { minScore: 5, overBuyHigh: 70,  lineMoveMin: 0.25, oddsDropMin: 0.04 }),
    ...underFollowSignal(game, ctx, { minScore: 5, underBuyHigh: 70, lineMoveMin: 0.25, oddsDropMin: 0.04 }),
  ]
}

// ── 농구 시그널 ──────────────────────────────────────────────
function basketballReverseSignals(game, ctx) {
  const signals = []
  const { op, mlHome, mlAway, spHome, spAway, ouOver, ouUnder } = ctx
  const homeFav = game.ml_home != null && game.ml_away != null && game.ml_home < game.ml_away
  const awayFav = game.ml_home != null && game.ml_away != null && game.ml_away < game.ml_home
  const spLineChanged = op.sp_pts != null && game.sp_pts != null && game.sp_pts !== op.sp_pts

  // ML 역추세
  if (homeFav && mlHome != null && mlHome >= 70) {
    const favMove = oddsMove(op.ml_home, game.ml_home)
    const dogMove = oddsMove(op.ml_away, game.ml_away)
    let score = 0; const reasons = []
    if (mlHome >= 80) { score += 2; reasons.push(`홈 구매율 ${mlHome}%`) }
    else              { score += 1; reasons.push(`홈 구매율 ${mlHome}%`) }
    if (favMove != null && favMove >= 0.04) { score += 2; reasons.push(`홈배당↑ +${favMove.toFixed(2)}`) }
    if (dogMove != null && dogMove <= -0.04) { score += 2; reasons.push(`원정배당↓ ${dogMove.toFixed(2)}`) }
    if (spLineChanged && game.sp_pts > op.sp_pts) { score += 2; reasons.push(`핸디 홈 불리 ${op.sp_pts}→${game.sp_pts}`) }
    score = addClosingTimeScore(game, score, reasons)
    pushScoredSignal(signals, { type: 'REVERSE', market: 'ML', pick: '원정 승', score, publicSide: `홈 ${mlHome}%`, reasons })
  }

  if (awayFav && mlAway != null && mlAway >= 70) {
    const favMove = oddsMove(op.ml_away, game.ml_away)
    const dogMove = oddsMove(op.ml_home, game.ml_home)
    let score = 0; const reasons = []
    if (mlAway >= 80) { score += 2; reasons.push(`원정 구매율 ${mlAway}%`) }
    else              { score += 1; reasons.push(`원정 구매율 ${mlAway}%`) }
    if (favMove != null && favMove >= 0.04) { score += 2; reasons.push(`원정배당↑ +${favMove.toFixed(2)}`) }
    if (dogMove != null && dogMove <= -0.04) { score += 2; reasons.push(`홈배당↓ ${dogMove.toFixed(2)}`) }
    if (spLineChanged && game.sp_pts < op.sp_pts) { score += 2; reasons.push(`핸디 원정 불리 ${op.sp_pts}→${game.sp_pts}`) }
    score = addClosingTimeScore(game, score, reasons)
    pushScoredSignal(signals, { type: 'REVERSE', market: 'ML', pick: '홈 승', score, publicSide: `원정 ${mlAway}%`, reasons })
  }

  // 핸디 역추세: 홈 핸디 구매율 높음 + 홈 핸디라인 약화 → 원정 플핸
  // 기준점 변동 시 배당변동은 자연 조정이므로 역추세 근거로 사용 금지
  if (spHome != null && spAway != null && spLineChanged) {
    if (spHome >= 70 && game.sp_pts > op.sp_pts) {
      let score = 0; const reasons = []
      if (spHome >= 80) { score += 2; reasons.push(`홈핸디 구매율 ${spHome}%`) }
      else              { score += 1; reasons.push(`홈핸디 구매율 ${spHome}%`) }
      score += 3; reasons.push(`핸디라인 홈 약화 ${op.sp_pts}→${game.sp_pts}`)
      score = addClosingTimeScore(game, score, reasons)
      pushScoredSignal(signals, { type: 'REVERSE', market: '핸디', pick: '원정 핸디', score, publicSide: `홈핸디 ${spHome}%`, reasons })
    }

    if (spAway >= 70 && game.sp_pts < op.sp_pts) {
      let score = 0; const reasons = []
      if (spAway >= 80) { score += 2; reasons.push(`원정핸디 구매율 ${spAway}%`) }
      else              { score += 1; reasons.push(`원정핸디 구매율 ${spAway}%`) }
      score += 3; reasons.push(`핸디라인 원정 약화 ${op.sp_pts}→${game.sp_pts}`)
      score = addClosingTimeScore(game, score, reasons)
      pushScoredSignal(signals, { type: 'REVERSE', market: '핸디', pick: '홈 핸디', score, publicSide: `원정핸디 ${spAway}%`, reasons })
    }
  }

  // O/U 역추세 (기준점 변동 없을 때만 배당 변동을 역추세 근거로 사용 / 양방향 배당 참조)
  if (ouOver != null && ouUnder != null && op.ou_pts != null && game.ou_pts != null) {
    const ouCtx = getOuLineContext(game, ctx)
    const { lineMove, overMove, underMove } = ouCtx

    if (ouOver >= 70) {
      let score = 0; const reasons = []
      if (ouOver >= 80) { score += 2; reasons.push(`오버 구매율 ${ouOver}%`) }
      else              { score += 1; reasons.push(`오버 구매율 ${ouOver}%`) }
      if (lineMove != null && lineMove <= -1.5) { score += 2; reasons.push(`기준점↓ ${op.ou_pts}→${game.ou_pts}`) }
      if (lineMove === 0 && overMove  != null && overMove  >= 0.04) { score += 2; reasons.push(`오버배당↑ +${overMove.toFixed(2)}`) }
      if (lineMove === 0 && underMove != null && underMove <= -0.04) { score += 1; reasons.push(`언더배당↓ ${underMove.toFixed(2)}`) }
      score = addClosingTimeScore(game, score, reasons)
      pushScoredSignal(signals, { type: 'REVERSE', market: 'O/U', pick: '언더', score, publicSide: `오버 ${ouOver}%`, reasons })
    }

    if (ouUnder >= 70) {
      let score = 0; const reasons = []
      if (ouUnder >= 80) { score += 2; reasons.push(`언더 구매율 ${ouUnder}%`) }
      else               { score += 1; reasons.push(`언더 구매율 ${ouUnder}%`) }
      if (lineMove != null && lineMove >= 1.5) { score += 2; reasons.push(`기준점↑ ${op.ou_pts}→${game.ou_pts}`) }
      if (lineMove === 0 && underMove != null && underMove >= 0.04) { score += 2; reasons.push(`언더배당↑ +${underMove.toFixed(2)}`) }
      if (lineMove === 0 && overMove  != null && overMove  <= -0.04) { score += 1; reasons.push(`오버배당↓ ${overMove.toFixed(2)}`) }
      score = addClosingTimeScore(game, score, reasons)
      pushScoredSignal(signals, { type: 'REVERSE', market: 'O/U', pick: '오버', score, publicSide: `언더 ${ouUnder}%`, reasons })
    }
  }

  return signals
}

function basketballFollowSignals(game, ctx) {
  return [
    ...favoriteFollowSignal(game, ctx, { minScore: 5, favBuyHigh: 70, favOddsDropMin: 0.04, dogOddsRiseMin: 0.04, favOddsMin: 1.40, favOddsMax: 1.90 }),
    ...overFollowSignal(game,  ctx, { minScore: 5, overBuyHigh: 70,  lineMoveMin: 1.5, oddsDropMin: 0.04 }),
    ...underFollowSignal(game, ctx, { minScore: 5, underBuyHigh: 70, lineMoveMin: 1.5, oddsDropMin: 0.04 }),
  ]
}

// ── 야구 시그널 ──────────────────────────────────────────────
function baseballReverseSignals(game, ctx) {
  const signals = []
  const { op, mlHome, mlAway, ouOver, ouUnder } = ctx
  const homeFav = game.ml_home != null && game.ml_away != null && game.ml_home < game.ml_away
  const awayFav = game.ml_home != null && game.ml_away != null && game.ml_away < game.ml_home

  // ML 역추세
  if (homeFav && mlHome != null && mlHome >= 72) {
    const favMove = oddsMove(op.ml_home, game.ml_home)
    const dogMove = oddsMove(op.ml_away, game.ml_away)
    let score = 0; const reasons = []
    if (mlHome >= 80) { score += 2; reasons.push(`홈 구매율 ${mlHome}%`) }
    else              { score += 1; reasons.push(`홈 구매율 ${mlHome}%`) }
    if (favMove != null && favMove >= 0.04) { score += 2; reasons.push(`홈배당↑ +${favMove.toFixed(2)}`) }
    if (dogMove != null && dogMove <= -0.04) { score += 2; reasons.push(`원정배당↓ ${dogMove.toFixed(2)}`) }
    score = addClosingTimeScore(game, score, reasons)
    pushScoredSignal(signals, { type: 'REVERSE', market: 'ML', pick: '원정 승', score, publicSide: `홈 ${mlHome}%`, reasons })
  }

  if (awayFav && mlAway != null && mlAway >= 72) {
    const favMove = oddsMove(op.ml_away, game.ml_away)
    const dogMove = oddsMove(op.ml_home, game.ml_home)
    let score = 0; const reasons = []
    if (mlAway >= 80) { score += 2; reasons.push(`원정 구매율 ${mlAway}%`) }
    else              { score += 1; reasons.push(`원정 구매율 ${mlAway}%`) }
    if (favMove != null && favMove >= 0.04) { score += 2; reasons.push(`원정배당↑ +${favMove.toFixed(2)}`) }
    if (dogMove != null && dogMove <= -0.04) { score += 2; reasons.push(`홈배당↓ ${dogMove.toFixed(2)}`) }
    score = addClosingTimeScore(game, score, reasons)
    pushScoredSignal(signals, { type: 'REVERSE', market: 'ML', pick: '홈 승', score, publicSide: `원정 ${mlAway}%`, reasons })
  }

  // O/U 언더 역추세 (새 기준: 오버 과매수 + 기준점 상승 없음 + 언더 배당 버팀/하락 + 버킷 점수)
  signals.push(...baseballUnderReverseSignal(game, ctx))

  return signals
}

function baseballFollowSignals(game, ctx) {
  return [
    ...favoriteFollowSignal(game, ctx, { minScore: 5, favBuyHigh: 70, favOddsDropMin: 0.04, dogOddsRiseMin: 0.04, favOddsMin: 1.45, favOddsMax: 1.85 }),
    ...overFollowSignal(game,  ctx, { minScore: 5, overBuyHigh: 70,  lineMoveMin: 0.5, oddsDropMin: 0.04 }),
    ...underFollowSignal(game, ctx, { minScore: 5, underBuyHigh: 70, lineMoveMin: 0.5, oddsDropMin: 0.04 }),
  ]
}

// ── 강정배 역추세 ─────────────────────────────────────────────
function soccerHeavyFavoriteReverseSignal(game, ctx) {
  const signals = []
  const { op, mlHome, mlAway, mlDraw } = ctx
  const homeFav = game.ml_home != null && game.ml_away != null && game.ml_home < game.ml_away
  const awayFav = game.ml_home != null && game.ml_away != null && game.ml_away < game.ml_home
  if (!homeFav && !awayFav) return signals

  const favCurOdds  = homeFav ? game.ml_home : game.ml_away
  const favBuy      = homeFav ? mlHome       : mlAway
  // 강정배 구간 (1.31~1.55)
  if (favCurOdds == null || favCurOdds < 1.31 || favCurOdds > 1.55) return signals

  const favOpenOdds = homeFav ? op.ml_home   : op.ml_away
  const dogOpenOdds = homeFav ? op.ml_away   : op.ml_home
  const dogCurOdds  = homeFav ? game.ml_away : game.ml_home

  const favMove  = oddsMove(favOpenOdds, favCurOdds)
  const dogMove  = oddsMove(dogOpenOdds, dogCurOdds)
  const drawMove = mlDraw != null && op.ml_draw != null ? game.ml_draw - op.ml_draw : null

  let score = 0; const reasons = []
  reasons.push(`강정배 ${favCurOdds.toFixed(2)}`)

  if (favBuy != null && favBuy >= 80)            { score += 1; reasons.push(`정배 구매율 ${favBuy}%`) }
  if (favMove != null && favMove >= 0.06)         { score += 2; reasons.push(`정배 배당↑ +${favMove.toFixed(2)}`) }
  if (favMove != null && favMove >= 0.10)         { score += 1; reasons.push('정배 배당 강상승') }
  if (dogMove != null && dogMove <= -0.06)        { score += 2; reasons.push(`상대 배당↓ ${dogMove.toFixed(2)}`) }
  if (drawMove != null && drawMove <= -0.06)      { score += 2; reasons.push(`무 배당↓ ${drawMove.toFixed(2)}`) }
  if (op.sp_pts != null && game.sp_pts != null && game.sp_pts !== op.sp_pts) {
    const favOpenLine = homeFav ? op.sp_pts   : -op.sp_pts
    const favCurLine  = homeFav ? game.sp_pts : -game.sp_pts
    if (favCurLine > favOpenLine) { score += 3; reasons.push(`핸디라인 정배 불리 ${op.sp_pts}→${game.sp_pts}`) }
  }
  score = addClosingTimeScore(game, score, reasons)

  const pick = homeFav ? '원정 플핸' : '홈 플핸'
  pushScoredSignal(signals, { type: 'REVERSE', market: '핸디', pick, score, publicSide: `정배 ${favBuy}%`, reasons }, 7)
  return signals
}

function basketballHeavyFavoriteReverseSignal(game, ctx) {
  const signals = []
  const { op, mlHome, mlAway, spHome, spAway } = ctx
  const homeFav = game.ml_home != null && game.ml_away != null && game.ml_home < game.ml_away
  const awayFav = game.ml_home != null && game.ml_away != null && game.ml_away < game.ml_home
  if (!homeFav && !awayFav) return signals

  const favCurOdds = homeFav ? game.ml_home : game.ml_away
  if (favCurOdds == null || favCurOdds > 1.55) return signals

  const favBuy      = homeFav ? mlHome     : mlAway
  const favOpenOdds = homeFav ? op.ml_home : op.ml_away
  const dogOpenOdds = homeFav ? op.ml_away : op.ml_home
  const dogCurOdds  = homeFav ? game.ml_away : game.ml_home
  const favSpBuy    = homeFav ? spHome     : spAway

  const favMove = oddsMove(favOpenOdds, favCurOdds)
  const dogMove = oddsMove(dogOpenOdds, dogCurOdds)

  let score = 0; const reasons = []
  reasons.push(`농구 강정배 ${favCurOdds.toFixed(2)}`)

  if (favBuy != null && favBuy >= 80)             { score += 1; reasons.push(`정배 ML 구매율 ${favBuy}%`) }
  if (favMove != null && favMove >= 0.05)          { score += 1; reasons.push(`정배 ML 배당↑ +${favMove.toFixed(2)}`) }
  if (dogMove != null && dogMove <= -0.05)         { score += 1; reasons.push(`상대 ML 배당↓ ${dogMove.toFixed(2)}`) }
  if (favSpBuy != null && favSpBuy >= 70)          { score += 1; reasons.push(`정배 핸디 구매율 ${favSpBuy}%`) }

  if (op.sp_pts != null && game.sp_pts != null && game.sp_pts !== op.sp_pts) {
    const favOpenLine = homeFav ? op.sp_pts   : -op.sp_pts
    const favCurLine  = homeFav ? game.sp_pts : -game.sp_pts
    const spShift = favCurLine - favOpenLine  // 양수 = 정배에게 불리 (스프레드 줄어듦)
    if (spShift > 0) {
      if (spShift >= 1.0) { score += 3; reasons.push(`핸디 정배 약화 ${op.sp_pts}→${game.sp_pts}`) }
      if (spShift >= 2.0) { score += 1; reasons.push('핸디 정배 강약화') }
    }
  }
  score = addClosingTimeScore(game, score, reasons)

  const pick = homeFav ? '원정 플핸' : '홈 플핸'
  pushScoredSignal(signals, { type: 'REVERSE', market: '핸디', pick, score, publicSide: `정배 ${favBuy}%`, reasons }, 6)
  return signals
}

function baseballHeavyFavoriteReverseSignal(game, ctx) {
  const signals = []
  const { op, mlHome, mlAway } = ctx
  const homeFav = game.ml_home != null && game.ml_away != null && game.ml_home < game.ml_away
  const awayFav = game.ml_home != null && game.ml_away != null && game.ml_away < game.ml_home
  if (!homeFav && !awayFav) return signals

  const favCurOdds  = homeFav ? game.ml_home : game.ml_away
  if (favCurOdds == null || favCurOdds > 1.85) return signals
  // 일반 역추세와 겹치지 않게: 1.86 이상은 일반 reverseSignals가 처리
  // 강정배: ≤1.55, 분석 가치: 1.56~1.85 (런라인/ML 조건 다름)

  const favBuy      = homeFav ? mlHome       : mlAway
  const favOpenOdds = homeFav ? op.ml_home   : op.ml_away
  const dogOpenOdds = homeFav ? op.ml_away   : op.ml_home
  const dogCurOdds  = homeFav ? game.ml_away : game.ml_home

  const favMove = oddsMove(favOpenOdds, favCurOdds)
  const dogMove = oddsMove(dogOpenOdds, dogCurOdds)

  // 런라인(+1.5) 배당 변동
  const rlDogOpenOdds = homeFav ? op.sp_away   : op.sp_home
  const rlDogCurOdds  = homeFav ? game.sp_away : game.sp_home
  const rlDogMove = oddsMove(rlDogOpenOdds, rlDogCurOdds)
  const favRlOpenOdds = homeFav ? op.sp_home   : op.sp_away
  const favRlCurOdds  = homeFav ? game.sp_home : game.sp_away
  const favRlMove = oddsMove(favRlOpenOdds, favRlCurOdds)

  let score = 0; const reasons = []
  reasons.push(`야구 강정배 ${favCurOdds.toFixed(2)}`)

  if (favBuy != null && favBuy >= 80)              { score += 1; reasons.push(`정배 구매율 ${favBuy}%`) }
  if (favMove != null && favMove >= 0.05)           { score += 2; reasons.push(`정배 배당↑ +${favMove.toFixed(2)}`) }
  if (favMove != null && favMove >= 0.10)           { score += 1; reasons.push('정배 배당 강상승') }
  if (dogMove != null && dogMove <= -0.05)          { score += 2; reasons.push(`상대 ML 배당↓ ${dogMove.toFixed(2)}`) }
  if (rlDogMove != null && rlDogMove <= -0.05)      { score += 2; reasons.push(`상대 +1.5 배당↓ ${rlDogMove.toFixed(2)}`) }
  if (favRlMove != null && favRlMove >= 0.04)       { score += 1; reasons.push(`정배 -1.5 배당↑ +${favRlMove.toFixed(2)}`) }
  score = addClosingTimeScore(game, score, reasons)

  // 강정배(≤1.55): 런라인 우선 / 분석정배(1.56~1.85): ML 가능
  const isHeavy = favCurOdds <= 1.55
  const dogName = homeFav ? '원정' : '홈'
  const market  = isHeavy ? '런라인' : 'ML'
  const pick    = isHeavy ? `${dogName} +1.5` : `${dogName} 승`
  pushScoredSignal(signals, { type: 'REVERSE', market, pick, score, publicSide: `정배 ${favBuy}%`, reasons }, 6)
  return signals
}

// ── VALUE_DOG: 역배/플핸 탐지 레이어 ─────────────────────────
function valueDogSignal(game, ctx, options = {}) {
  const signals = []
  const { op, mlHome, mlAway } = ctx
  const {
    minWatchScore = 5,
    minMlScore    = 7,
    favBuyHigh    = 78,
    favRiseMin    = 0.05,
    dogDropMin    = 0.05,
  } = options

  const homeFav = game.ml_home != null && game.ml_away != null && game.ml_home < game.ml_away
  const awayFav = game.ml_home != null && game.ml_away != null && game.ml_away < game.ml_home
  if (!homeFav && !awayFav) return signals

  const favBuy      = homeFav ? mlHome       : mlAway
  const dogBuy      = homeFav ? mlAway       : mlHome
  const favOpenOdds = homeFav ? op.ml_home   : op.ml_away
  const favCurOdds  = homeFav ? game.ml_home : game.ml_away
  const dogOpenOdds = homeFav ? op.ml_away   : op.ml_home
  const dogCurOdds  = homeFav ? game.ml_away : game.ml_home

  const favMove = oddsMove(favOpenOdds, favCurOdds)
  const dogMove = oddsMove(dogOpenOdds, dogCurOdds)

  let score = 0; const reasons = []

  if (favBuy != null && favBuy >= favBuyHigh)     { score += 2; reasons.push(`정배 과매수 ${favBuy}%`) }
  if (dogBuy != null) {
    if (dogBuy <= 30)      { score += 1; reasons.push(`역배 구매율 낮음 ${dogBuy}%`) }
    else if (dogBuy > 45)  { score -= 1; reasons.push(`역배 과매수 ${dogBuy}% (약화)`) }
  }
  if (favMove != null && favMove >= favRiseMin)    { score += 2; reasons.push(`정배 배당↑ +${favMove.toFixed(2)}`) }
  if (dogMove != null && dogMove <= -dogDropMin)   { score += 2; reasons.push(`역배 배당↓ ${dogMove.toFixed(2)}`) }
  if (op.sp_pts != null && game.sp_pts != null && game.sp_pts !== op.sp_pts) {
    const favOpenLine = homeFav ? op.sp_pts   : -op.sp_pts
    const favCurLine  = homeFav ? game.sp_pts : -game.sp_pts
    if (favCurLine > favOpenLine) { score += 3; reasons.push(`핸디 정배 불리 ${op.sp_pts}→${game.sp_pts}`) }
  }

  if (score < minWatchScore) return signals

  const dogPick          = homeFav ? '원정 승'  : '홈 승'
  const plusHandicapPick = homeFav ? '원정 플핸' : '홈 플핸'
  let market = score >= minMlScore ? 'ML' : '핸디'
  let pick   = score >= minMlScore ? dogPick : plusHandicapPick

  // 강정배 구간은 ML 대신 보조 마켓
  if (favCurOdds != null && favCurOdds <= 1.55) {
    if (game.sport === 'baseball') {
      market = '런라인'; pick = homeFav ? '원정 +1.5' : '홈 +1.5'
    } else {
      market = '핸디'; pick = plusHandicapPick
    }
  }

  const mode     = score >= minMlScore ? 'CANDIDATE' : 'WATCH'
  const strength = score >= 8 ? '강한 역배 후보' : score >= 6 ? '역배 후보' : '역배 관찰'
  signals.push({
    type: 'VALUE_DOG', mode, market, pick, strength, score,
    publicSide: `정배 ${favBuy}% / 역배 ${dogBuy}%`,
    reason: reasons.join(' / '),
  })
  return signals
}

function soccerValueDogSignals(game, ctx) {
  return valueDogSignal(game, ctx, { minWatchScore: 5, minMlScore: 8, favBuyHigh: 80, favRiseMin: 0.06, dogDropMin: 0.06 })
}

function basketballValueDogSignals(game, ctx) {
  return valueDogSignal(game, ctx, { minWatchScore: 5, minMlScore: 7, favBuyHigh: 78, favRiseMin: 0.05, dogDropMin: 0.05 })
}

function baseballValueDogSignals(game, ctx) {
  return valueDogSignal(game, ctx, { minWatchScore: 5, minMlScore: 6, favBuyHigh: 75, favRiseMin: 0.05, dogDropMin: 0.05 })
}

// ── 메인 시그널 함수 ─────────────────────────────────────────
function pctCandidate(value, market, side, label) {
  const pct = Number(value)
  if (!Number.isFinite(pct)) return null
  return { value: pct, market, side, label }
}

function getTopBetCandidate(ctx) {
  const candidates = [
    pctCandidate(ctx.mlHome, 'ML', 'home', '홈승'),
    pctCandidate(ctx.mlDraw, 'ML', 'draw', '무승부'),
    pctCandidate(ctx.mlAway, 'ML', 'away', '원정승'),
    pctCandidate(ctx.spHome, '핸디', 'home', '홈핸디'),
    pctCandidate(ctx.spAway, '핸디', 'away', '원정핸디'),
    pctCandidate(ctx.ouOver, 'O/U', 'over', '오버'),
    pctCandidate(ctx.ouUnder, 'O/U', 'under', '언더'),
  ].filter(Boolean)

  if (candidates.length === 0) return null
  return candidates.reduce((best, cur) => cur.value > best.value ? cur : best, candidates[0])
}

function makeBuyReverseSignal(candidate, market, pick, reason) {
  return {
    type: 'REVERSE',
    market,
    pick,
    strength: '구매율 역방향',
    score: candidate.value,
    publicSide: `${candidate.label} ${candidate.value}%`,
    reason,
  }
}

function getFavoriteSide(game, ctx) {
  const homeOdds = game.ml_home ?? ctx.op.ml_home
  const awayOdds = game.ml_away ?? ctx.op.ml_away
  if (homeOdds == null || awayOdds == null || homeOdds === awayOdds) return null
  return homeOdds < awayOdds ? 'home' : 'away'
}

function mapTopBetToSignals(game, ctx, candidate) {
  const signals = []
  if (!candidate) return signals

  const favoriteSide = getFavoriteSide(game, ctx)
  const isSoccerLike = game.sport === 'soccer' || game.sport === 'hockey'
  const favoritePick = favoriteSide === 'home' ? '홈 승' : favoriteSide === 'away' ? '원정 승' : null
  const dogSide = favoriteSide === 'home' ? 'away' : favoriteSide === 'away' ? 'home' : null
  const dogMlPick = dogSide === 'home' ? '홈 승' : dogSide === 'away' ? '원정 승' : null
  const dogHandicapPick = dogSide === 'home' ? '홈 플핸' : dogSide === 'away' ? '원정 플핸' : null

  if (candidate.market === 'O/U') {
    signals.push(makeBuyReverseSignal(candidate, 'O/U', candidate.side === 'over' ? '언더' : '오버', '경기 내 최고 구매율 반대'))
    return signals
  }

  if (candidate.market === '핸디') {
    signals.push(makeBuyReverseSignal(candidate, '핸디', candidate.side === 'home' ? '원정 핸디' : '홈 핸디', '경기 내 최고 구매율 반대'))
    return signals
  }

  if (candidate.market !== 'ML') return signals

  if (isSoccerLike) {
    if (candidate.side === 'draw') {
      if (favoritePick) signals.push(makeBuyReverseSignal(candidate, 'ML', favoritePick, '무승부 최고 구매율 -> 정배 승'))
      return signals
    }

    if (candidate.side === favoriteSide) {
      if (dogHandicapPick) signals.push(makeBuyReverseSignal(candidate, '핸디', dogHandicapPick, '정배 최고 구매율 -> 상대 플핸'))
      return signals
    }

    if (favoritePick) signals.push(makeBuyReverseSignal(candidate, 'ML', favoritePick, '역배 최고 구매율 -> 정배 승'))
    return signals
  }

  if (candidate.side === favoriteSide && dogMlPick) {
    signals.push(makeBuyReverseSignal(candidate, 'ML', dogMlPick, '정배 최고 구매율 -> 역배 승'))
    if (dogHandicapPick) signals.push(makeBuyReverseSignal(candidate, '핸디', dogHandicapPick, '정배 최고 구매율 -> 역배 플핸'))
    return signals
  }

  if (candidate.side === 'home') {
    signals.push(makeBuyReverseSignal(candidate, 'ML', '원정 승', '경기 내 최고 구매율 반대'))
    return signals
  }

  if (candidate.side === 'away') {
    signals.push(makeBuyReverseSignal(candidate, 'ML', '홈 승', '경기 내 최고 구매율 반대'))
    return signals
  }

  if (candidate.side === 'draw' && favoritePick) {
    signals.push(makeBuyReverseSignal(candidate, 'ML', favoritePick, '무승부 최고 구매율 -> 정배 승'))
  }

  return signals
}

function publicBetReverseSignals(game, ctx) {
  return mapTopBetToSignals(game, ctx, getTopBetCandidate(ctx))
}

function reverseSignals(game) {
  try {
    return _reverseSignals(game)
  } catch (e) {
    console.error('[reverseSignals] crash for', game?.matchup_id, e)
    return []
  }
}

function _reverseSignals(game) {
  const ctx = buildSignalContext(game)
  return publicBetReverseSignals(game, ctx)
}

function ReverseSignals({ signals }) {
  if (!signals || signals.length === 0) return null
  const sorted = [...signals].sort((a, b) => b.score - a.score)
  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <div className="text-xs font-semibold text-slate-400 tracking-wide mb-2">시그널</div>
      <div className="flex gap-2 flex-wrap">
        {sorted.map((s, i) => {
          const isFollow   = s.type === 'FOLLOW'
          const isValueDog = s.type === 'VALUE_DOG'
          const bgClass    = isFollow ? 'bg-emerald-50 border-emerald-100' : isValueDog ? 'bg-amber-50 border-amber-100' : 'bg-violet-50 border-violet-100'
          const labelClass = isFollow ? 'text-emerald-600' : isValueDog ? 'text-amber-600' : 'text-violet-500'
          const pickClass  = isFollow ? 'text-emerald-800' : isValueDog ? 'text-amber-800' : 'text-violet-800'
          const reasonClass = isFollow ? 'text-emerald-500' : isValueDog ? 'text-amber-500' : 'text-violet-400'
          const typeLabel  = isFollow ? '순방향' : isValueDog ? `역배탐지 ${s.mode === 'CANDIDATE' ? '후보' : '관찰'}` : '역추세'
          return (
            <div key={i} className={`rounded-xl px-3 py-2 border ${bgClass}`}>
              <div className={`text-xs font-medium ${labelClass}`}>
                {typeLabel} · {s.market} · {s.publicSide}
                <span className="ml-1 opacity-60">{s.strength} ({s.score}점)</span>
              </div>
              <div className={`text-sm font-bold mt-0.5 ${pickClass}`}>
                {s.pick}
              </div>
              <div className={`text-xs mt-0.5 ${reasonClass}`}>
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
    return raw.sort((a, b) => (a.game.starts_at > b.game.starts_at ? 1 : -1))
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
        const flag     = LEAGUE_FLAGS[game.league] || '🏟'
        const isFollow = signal.type === 'FOLLOW'
        const h        = hoursUntil(game.starts_at)
        const urgent   = h != null && h <= 1

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
              isFollow ? 'bg-emerald-50 border-emerald-100' : 'bg-violet-50 border-violet-100'
            }`}>
              <div className="flex-1 min-w-0">
                <div className={`text-xs font-semibold mb-0.5 ${isFollow ? 'text-emerald-600' : 'text-violet-500'}`}>
                  {isFollow ? '순방향' : '역추세'} · {signal.market} · {signal.publicSide}
                  {signal.strength && <span className="ml-1 opacity-60">{signal.strength} ({signal.score}점)</span>}
                </div>
                <div className={`text-base font-bold ${isFollow ? 'text-emerald-800' : 'text-violet-800'}`}>
                  {signal.pick}
                </div>
                <div className={`text-xs mt-0.5 ${isFollow ? 'text-emerald-500' : 'text-violet-400'}`}>
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
  const mlHomeHL  = hasAccess && hasPick('ML', '홈') ? 'blue' : null
  const mlAwayHL  = hasAccess && hasPick('ML', '원정') ? 'blue' : null
  const spHomeHL  = hasAccess && hasPick('핸디', '홈') ? 'blue' : null
  const spAwayHL  = hasAccess && hasPick('핸디', '원정') ? 'blue' : null
  const ouOverHL  = hasAccess && hasPick('O/U', '오버') ? 'blue' : null
  const ouUnderHL = hasAccess && hasPick('O/U', '언더') ? 'blue' : null

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

// ── 바카라 탭 (sharpsignal.cloud 완전 동일) ─────────────────
const BACCARAT_API  = 'https://sharpsignal.cloud/api/public/state'
const BAC_WILSON_Z  = 1.645
const BAC_MIN_REL   = 10

// ── dashboard.js / room.js roadItems 로직 그대로 ──
function bacRoadItems(values, rows = 6, tieAsSlash = false) {
  const items = []
  const tieCounts = new Map()
  let lastMain = '', col = 0, row = 0, streakStartCol = 0, lastKey = ''

  values.forEach(value => {
    if (!value) return
    if (tieAsSlash && value === 'T') {
      if (lastKey) tieCounts.set(lastKey, (tieCounts.get(lastKey) || 0) + 1)
      return
    }
    if (!lastMain) {
      lastMain = value; col = 0; row = 0; streakStartCol = 0
    } else if (value === lastMain && row < rows - 1) {
      row += 1
    } else if (value === lastMain) {
      col += 1
    } else {
      col = streakStartCol + 1; row = 0; streakStartCol = col; lastMain = value
    }
    lastKey = `${col}:${row}`
    items.push({ value, col, row, tieCount: 0 })
  })
  items.forEach(item => { item.tieCount = tieCounts.get(`${item.col}:${item.row}`) || 0 })
  return items
}

// ── 도로 차트 컴포넌트 (웹사이트 road-chart CSS 동일) ──
function BacRoadChart({ shoeStr, compact = false }) {
  const rows     = 6
  const minCols  = compact ? 14 : 32
  const maxVals  = compact ? 42 : 300
  const cellSize = compact ? 19 : 28
  const scrollRef = useRef(null)

  const values = [...String(shoeStr || '').toUpperCase()]
    .filter(v => ['P','B','T'].includes(v))
    .slice(-maxVals)

  const counts = values.reduce((a, v) => { a[v] = (a[v]||0)+1; return a }, { P:0, B:0, T:0 })
  const items  = bacRoadItems(values, rows, true) // tieAsSlash=true

  const maxCol     = Math.max(minCols - 1, ...items.map(i => i.col), 0)
  const visibleCols = Math.max(minCols, maxCol + 1)
  const firstCol   = Math.max(0, visibleCols - minCols)
  const shown      = items.filter(i => i.col >= firstCol)

  // 새 데이터 올 때마다 오른쪽 끝으로 자동 스크롤
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
    }
  })

  const gridW = minCols * cellSize
  const gridH = rows  * cellSize

  // 각 마크의 색
  function markBg(v) {
    if (v === 'B') return 'linear-gradient(145deg,#fb7185 0%,#ef4444 56%,#b91c1c 100%)'
    if (v === 'P') return 'linear-gradient(145deg,#60a5fa 0%,#2563eb 58%,#1d4ed8 100%)'
    return 'linear-gradient(145deg,#34d399 0%,#16a34a 60%,#15803d 100%)'
  }

  return (
    <div>
      {/* 요약 */}
      <div style={{ display:'flex', gap: compact ? 10 : 20, marginBottom: compact ? 4 : 10, flexWrap:'wrap' }}>
        <span style={{ color:'#94a3b8', fontWeight:700, fontSize: compact ? '0.7rem' : '0.85rem' }}># {values.length}</span>
        <span style={{ color:'#2563eb', fontWeight:700, fontSize: compact ? '0.7rem' : '0.85rem' }}>P <b>{counts.P}</b></span>
        <span style={{ color:'#dc2626', fontWeight:700, fontSize: compact ? '0.7rem' : '0.85rem' }}>B <b>{counts.B}</b></span>
        <span style={{ color:'#16a34a', fontWeight:700, fontSize: compact ? '0.7rem' : '0.85rem' }}>T <b>{counts.T}</b></span>
      </div>
      {/* 그리드 */}
      <div ref={scrollRef} style={{ overflowX:'auto', borderRadius:8, border:'1px solid #e2e8f0' }}>
        <div style={{
          position:'relative', display:'grid',
          gridTemplateColumns:`repeat(${minCols},${cellSize}px)`,
          gridTemplateRows:`repeat(${rows},${cellSize}px)`,
          width: gridW, height: gridH,
          background:'#ffffff',
          backgroundImage:`linear-gradient(to right,rgba(100,116,139,0.15) 1px,transparent 1px),linear-gradient(to bottom,rgba(100,116,139,0.15) 1px,transparent 1px)`,
          backgroundSize:`${cellSize}px ${cellSize}px`,
        }}>
          {Array.from({ length: rows * minCols }).map((_, i) => (
            <div key={i} style={{ width:cellSize, height:cellSize }} />
          ))}
          {shown.map((item, i) => {
            const sc = item.col - firstCol
            const sz = cellSize - 5
            return (
              <div key={i} style={{
                position:'absolute',
                left: sc * cellSize + 2,
                top:  item.row * cellSize + 2,
                width: sz, height: sz,
                borderRadius:'50%',
                background: markBg(item.value),
                display:'grid', placeItems:'center',
                fontSize: compact ? 7 : 10,
                fontWeight:700, color:'white',
                boxShadow:'0 1px 4px rgba(0,0,0,0.2)',
                overflow:'hidden',
              }}>
                {item.value}
                {item.tieCount > 0 && (
                  <>
                    {/* 슬래시 선 */}
                    <div style={{
                      position:'absolute', left:'50%', top:'50%',
                      transform:'translate(-50%,-50%) rotate(-45deg)',
                      width: sz + 2, height: compact ? 2 : 2.5, borderRadius:999,
                      background:'#16a34a', opacity:0.95, pointerEvents:'none',
                    }} />
                    {/* 타이 횟수 숫자 — 2개 이상일 때만 */}
                    {item.tieCount >= 2 && (
                      <div style={{
                        position:'absolute',
                        right: compact ? -1 : 0,
                        bottom: compact ? -1 : 0,
                        minWidth: compact ? 10 : 13,
                        height: compact ? 10 : 13,
                        borderRadius:999,
                        background:'#16a34a',
                        color:'white',
                        fontSize: compact ? 7 : 9,
                        fontWeight:800,
                        display:'flex', alignItems:'center', justifyContent:'center',
                        lineHeight:1,
                        border: '1px solid white',
                        pointerEvents:'none',
                      }}>
                        {item.tieCount}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// room.js PATTERN_CONFIGS 그대로
const BAC_PATTERN_CONFIGS = [
  { key: 'Custom6Group',     label: '중국점 6군 변형 (Custom Logic)',       color: '#a78bfa' },
  { key: 'Cross2',           label: '2군 교차색 (Cross2)',                  color: '#63cac0' },
  { key: 'Combo6GCross2',    label: '통합 6군+2군 일치 (Combo)',             color: '#818cf8' },
  { key: 'StreakMomentum',   label: 'A) 줄 길이 모멘텀',                    color: '#fbbf24' },
  { key: 'InShoeCond',       label: 'B) 슈 내 조건부 빈도',                  color: '#34d399' },
  { key: 'MACross',          label: 'C) 이동평균 크로스',                    color: '#a78bfa' },
  { key: 'AlternationIndex', label: 'D) 교번 지수',                         color: '#fb7185' },
  { key: 'Autocorrelation',  label: 'E) 자기상관 Lag-1',                    color: '#fb923c' },
  { key: 'EWMA',             label: 'F) 지수 가중 이동평균',                  color: '#22d3ee' },
  { key: 'ZScoreBias',       label: 'G) Z-Score 편향 탐지',                 color: '#a3e635' },
  { key: 'MarkovChain',      label: 'H) 마르코프 체인 (1차)',                color: '#f97316' },
  { key: 'RollingDiff',      label: 'I) 롤링 차이값 모멘텀',                 color: '#14b8a6' },
  { key: 'Ensemble',         label: 'J) 앙상블 투표',                       color: '#ec4899' },
  { key: 'AntiPattern',      label: 'K) 반전 패턴',                         color: '#ef4444' },
  { key: 'MarkovChain2',     label: 'L) 마르코프 체인 (2차)',                color: '#f59e0b' },
  { key: 'MarkovChain3',     label: 'M) 마르코프 체인 (3차)',                color: '#d97706' },
  { key: 'Bigram',           label: 'N) 바이그램 (2-gram)',                  color: '#6ee7b7' },
  { key: 'FourGram',         label: 'O) 포그램 (4-gram)',                   color: '#4ade80' },
  { key: 'BestNGram',        label: 'P) 최적 N-gram (자동선택)',             color: '#86efac' },
  { key: 'RunsTest',         label: 'Q) 런 검정 (Runs Test)',               color: '#67e8f9' },
  { key: 'Bayesian',         label: 'R) 베이지안 추론',                      color: '#c4b5fd' },
  { key: 'EntropyFilter',    label: 'S) 엔트로피 필터',                      color: '#fda4af' },
  { key: 'PhaseDetection',   label: 'T) 슈 페이즈 탐지',                    color: '#fdba74' },
  { key: 'ChangePoint',      label: 'U) 체인지포인트 탐지',                   color: '#fcd34d' },
  { key: 'StreakReversal3',  label: 'V) 줄 반전 (3연속)',                    color: '#f87171' },
  { key: 'StreakReversal4',  label: 'W) 줄 반전 (4연속)',                    color: '#fb923c' },
  { key: 'StreakReversal5',  label: 'X) 줄 반전 (5연속)',                    color: '#fbbf24' },
  { key: 'DoubleConfirm',    label: 'Y) 더블 컨펌 (Ensemble 2연속)',         color: '#e879f9' },
  { key: 'BestTracker',      label: 'Z1) 베스트 추적자 (Best Tracker)',      color: '#38bdf8' },
  { key: 'WinStreakTracker',  label: 'Z2) 연승 추적자 (Win Streak)',          color: '#818cf8' },
]

function bacWilson(wins, total) {
  if (total === 0) return -1
  const p = wins / total
  const z2 = BAC_WILSON_Z * BAC_WILSON_Z
  return (p + z2 / (2 * total) - BAC_WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total)
}

// 패턴 카드 — 라이트 테마
function BacPatternCard({ rank, cfg, data, score }) {
  const pick      = data.pick || ''
  const pickLabel = pick === 'B' ? '🔴 뱅커' : pick === 'P' ? '🔵 플레이어' : '—'
  const wr        = (data.win_rate || 0).toFixed(1)
  const total     = data.total    || 0
  const wins      = data.wins     || 0
  const losses    = data.losses   || 0
  const maxWin    = data.max_win  || 0
  const maxLoss   = data.max_loss || 0
  const curWin    = data.current_win  || 0
  const curLoss   = data.current_loss || 0
  const history   = data.history  || []
  const isRel     = total >= BAC_MIN_REL
  const scoreDisp = (score * 100).toFixed(1)
  const barPct    = Math.min(100, (total / 60) * 100).toFixed(0)
  const col       = cfg.color

  const wrColor    = parseFloat(wr) >= 55 ? '#10b981' : parseFloat(wr) >= 45 ? '#f59e0b' : '#ef4444'
  const scoreColor = score >= 0.5 ? '#10b981' : score >= 0.4 ? '#f59e0b' : '#94a3b8'
  const rankBg     = rank === 1 ? '#fbbf24' : rank <= 3 ? '#94a3b8' : rank <= 5 ? '#b45309' : '#e2e8f0'
  const rankFg     = rank <= 5 ? '#0f172a' : '#64748b'
  const pickColor  = pick === 'B' ? '#dc2626' : pick === 'P' ? '#2563eb' : '#64748b'

  const curStreakEl = curWin > 0
    ? <span style={{ color:'#10b981', fontWeight:700 }}>+{curWin}연승</span>
    : curLoss > 0
    ? <span style={{ color:'#ef4444', fontWeight:700 }}>-{curLoss}연패</span>
    : <span style={{ color:'#94a3b8' }}>-</span>

  return (
    <div style={{
      marginTop: '0.75rem',
      padding: '1rem',
      background: '#ffffff',
      borderRadius: 12,
      border: `1px solid ${col}55`,
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    }}>
      {/* 헤더 */}
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
        <div style={{
          minWidth:28, height:28, borderRadius:'50%',
          background:rankBg, color:rankFg,
          display:'flex', alignItems:'center', justifyContent:'center',
          fontWeight:900, fontSize:'0.75rem', flexShrink:0,
        }}>{rank}</div>
        <div style={{ flex:1, minWidth:0 }}>
          <span style={{ color:col, fontWeight:700, fontSize:'0.85rem' }}>{cfg.label}</span>
          {!isRel && (
            <span style={{
              fontSize:'0.6rem', background:'#fef3c7',
              color:'#92400e', border:'1px solid #fcd34d',
              borderRadius:4, padding:'1px 5px', marginLeft:6,
            }}>참고용({total}건)</span>
          )}
        </div>
        <div style={{ fontSize:'0.72rem', color:'#94a3b8', flexShrink:0 }}>{total}건</div>
      </div>

      {/* 스탯 그리드 */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6 }}>
        {[
          { label:'최종 픽',          value:pickLabel,          color:pickColor,   size:'0.9rem' },
          { label:`적중률 (${total}건)`, value:`${wr}%`,         color:wrColor,     size:'1.1rem' },
          { label:'신뢰점수 ▲정렬',   value:`${scoreDisp}%`,    color:scoreColor,  size:'1rem' },
          { label:'적중 / 미적중',    value:`${wins} / ${losses}`, color:'#334155', size:'0.9rem' },
          { label:'최대 연승/연패',   value:`${maxWin} / ${maxLoss}`, color:'#334155', size:'0.9rem' },
          { label:'현재 흐름',        valueEl:curStreakEl,      size:'0.9rem' },
          ...(data.agreement ? [{ label:'일치율', value:data.agreement, color:'#7c3aed', size:'1rem' }] : []),
        ].map((s, i) => (
          <div key={i} style={{
            background:'#f8fafc', padding:'0.6rem 0.4rem',
            borderRadius:8, textAlign:'center', border:'1px solid #f1f5f9',
          }}>
            <div style={{ fontSize:'0.65rem', color:'#94a3b8', marginBottom:3 }}>{s.label}</div>
            <div style={{ fontSize:s.size, fontWeight:600, color:s.color||'#1e293b' }}>
              {s.valueEl || s.value}
            </div>
          </div>
        ))}
      </div>

      {/* 건수 바 */}
      <div style={{ marginTop:8, height:3, background:'#f1f5f9', borderRadius:9, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${barPct}%`, background:col, borderRadius:9 }} />
      </div>

      {/* 히스토리 도트 */}
      <div style={{ marginTop:'0.75rem' }}>
        <div style={{ color:'#94a3b8', fontSize:'0.75rem', marginBottom:5 }}>이번 슈 배팅 결과</div>
        <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
          {history.length === 0
            ? <span style={{ color:'#94a3b8', fontSize:'0.75rem' }}>데이터 대기중...</span>
            : history.map((h, i) => (
              <div key={i} style={{
                width:22, height:22, borderRadius:'50%',
                background: h === 'O' ? '#10b981' : '#ef4444',
                display:'flex', alignItems:'center', justifyContent:'center',
                fontSize:10, fontWeight:'bold', color:'white', flexShrink:0,
              }}>{h}</div>
            ))
          }
        </div>
      </div>
    </div>
  )
}

// 룸 카드 — 라이트 테마, 픽 배지 제거
function BacRoomCard({ room }) {
  const [open, setOpen] = useState(false)
  const patterns = room.patterns || {}
  const shoe     = room.shoe || ''

  const entries = BAC_PATTERN_CONFIGS
    .map(cfg => {
      const data  = patterns[cfg.key]
      const score = data ? bacWilson(data.wins || 0, data.total || 0) : -1
      return { cfg, data, score }
    })
    .filter(e => e.data && (e.data.total || 0) >= 1)
    .sort((a, b) => b.score - a.score)

  const noData = BAC_PATTERN_CONFIGS
    .map(cfg => ({ cfg, data: patterns[cfg.key] }))
    .filter(e => !e.data || (e.data.total || 0) < 1)

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm mb-3 overflow-hidden">
      {/* 룸 헤더 — 항상 표시 */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="font-semibold text-slate-900 text-sm">{room.name}</div>
            <div className="text-xs text-slate-400 mt-0.5">슈 {shoe.length}판 · 패턴 {entries.length}개</div>
          </div>
        </div>

        {/* 컴팩트 차트 — 항상 표시 */}
        <BacRoadChart shoeStr={shoe} compact={true} />

        {/* 펼치기 버튼 */}
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full mt-3 py-2 text-xs font-semibold text-slate-500 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-center gap-1">
          {open ? '▲ 패턴 닫기' : '▼ 패턴 보기'}
        </button>
      </div>

      {/* 펼쳤을 때: 패턴 카드 */}
      {open && (
        <div className="px-4 pb-4">
          {/* 패턴 카드 */}
          {entries.map((e, i) => (
            <BacPatternCard key={e.cfg.key} rank={i+1} cfg={e.cfg} data={e.data} score={e.score} />
          ))}

          {/* 대기중 */}
          {noData.length > 0 && (
            <div className="mt-4 p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs text-slate-400 mb-2">대기중 (배팅 데이터 없음)</div>
              <div className="flex flex-wrap gap-1.5">
                {noData.map(e => (
                  <span key={e.cfg.key} className="text-xs text-slate-400 bg-white border border-slate-200 px-2 py-0.5 rounded-lg">
                    {e.cfg.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BaccaratTab({ hasAccess, onShowUpgrade, onSignIn, user }) {
  const [state, setState]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)

  async function fetchState() {
    try {
      const res = await fetch(BACCARAT_API)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setState(json)
      setLastUpdate(new Date().toLocaleTimeString('ko-KR'))
      setError(null)
    } catch (e) {
      setError('데이터 로드 실패. 잠시 후 다시 시도해주세요.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchState()
    const timer = setInterval(fetchState, 3000) // 웹사이트 동일 3초
    return () => clearInterval(timer)
  }, [])

  if (!hasAccess) {
    return (
      <div className="px-4 pt-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
        <LockBox
          label="구독 후 바카라 패턴을 이용할 수 있습니다"
          onUnlock={user ? onShowUpgrade : onSignIn}
          isGuest={!user}
        />
      </div>
    )
  }

  return (
    <div className="px-4 py-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-base font-bold text-slate-900">바카라 패턴</div>
          {lastUpdate && <div className="text-xs text-slate-400 mt-0.5">갱신 {lastUpdate}</div>}
        </div>
        <button onClick={fetchState}
          className="text-xs font-semibold text-slate-500 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-full">
          새로고침
        </button>
      </div>

      {loading ? (
        <div className="text-center text-slate-400 py-20 text-sm">불러오는 중...</div>
      ) : error ? (
        <div className="text-center text-rose-400 py-10 text-sm">{error}</div>
      ) : !state?.rooms?.length ? (
        <div className="text-center text-slate-400 py-20 text-sm">룸 데이터 없음</div>
      ) : (
        state.rooms.map(room => <BacRoomCard key={room.id} room={room} />)
      )}
    </div>
  )
}

function MainApp({ user, isAdmin, hasAccess, sub, onSignOut, onSignIn, signInLoading }) {
  const [games, setGames]           = useState([])
  const [tab, setTab]               = useState('all')
  const [subLeague, setSubLeague]   = useState('all')
  const [pastLeague, setPastLeague] = useState('all')
  const [loading, setLoading]       = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [selected, setSelected]     = useState(null)
  const [showAdmin, setShowAdmin]   = useState(false)
  const [showUpgrade, setShowUpgrade] = useState(false)
  const [showMyPage, setShowMyPage] = useState(false)
  const [betmanDirect, setBetmanDirect] = useState([])  // 앱 직접 호출 국내구매율
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

  // 모달 열릴 때 배경 스크롤 방지
  useEffect(() => {
    document.body.style.overflow = selected ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [selected])

  useEffect(() => {
    fetchGames()
    fetchBetmanDirect()
    const timer = setInterval(() => fetchGames(true), 30 * 60 * 1000)
    const betmanTimer = setInterval(() => fetchBetmanDirect(), 5 * 60 * 1000) // 5분마다 실시간 갱신
    // 앱이 백그라운드 → 포그라운드로 돌아올 때 자동 새로고침
    let appStateListener
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) { fetchGames(true); fetchBetmanDirect() }
    }).then(l => { appStateListener = l })
    return () => {
      clearInterval(timer)
      clearInterval(betmanTimer)
      appStateListener?.remove()
    }
  }, [])

  // betman.co.kr 직접 호출 (앱 전용, CapacitorHttp로 CORS 우회)
  async function fetchBetmanDirect() {
    if (!Capacitor.isNativePlatform()) return
    try {
      // 1단계: 현재 G101 회차 조회
      const roundRes = await CapacitorHttp.post({
        url: BETMAN_BUYABLE_API,
        headers: { ...BETMAN_HEADERS, 'Referer': BETMAN_BUYABLE_URL },
        data: { _sbmInfo: { debugMode: 'false' } },
      })
      const protoGames = roundRes.data?.protoGames || []
      const g101 = protoGames.find(g => g.gmId === 'G101')
      if (!g101) return // 판매 중인 G101 회차 없음

      const { gmId, gmTs } = g101
      const referer = `${BETMAN_GAMESLIP}?gmId=${gmId}&gmTs=${gmTs}`

      // 2단계: 경기 데이터 조회
      const gameRes = await CapacitorHttp.post({
        url: BETMAN_GAME_API,
        headers: { ...BETMAN_HEADERS, 'Referer': referer },
        data: { gmId, gmTs: String(gmTs), gameYear: '', _sbmInfo: { debugMode: 'false' } },
      })
      const proto = parseBetmanData(gameRes.data)
      setBetmanDirect(proto)
    } catch (e) {
      console.warn('[betman-direct]', e?.message || e)
    }
  }

  // silent=true 이면 기존 데이터를 유지한 채 백그라운드 갱신 (스크롤 위치 보존)
  async function fetchGames(silent = false, retryCount = 0) {
    if (!silent) setLoading(true)
    let json
    try {
      const res = await fetch(`${GAMES_API}/api/games`)
      json = await res.json()
    } catch (e) {
      // 초기 로드 실패시 최대 3회 재시도 (2초 간격)
      if (!silent && retryCount < 3) {
        setTimeout(() => fetchGames(false, retryCount + 1), 2000)
        return
      }
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
      const orientProto = (p, reversed = false) => {
        if (!p || !reversed) return p
        return {
          ...p,
          home: p.away, away: p.home,
          home_abbr: p.away_abbr, away_abbr: p.home_abbr,
          ml_bets_home: p.ml_bets_away, ml_bets_away: p.ml_bets_home,
          ml_bets_home_count: p.ml_bets_away_count, ml_bets_away_count: p.ml_bets_home_count,
          ml_bets_home_amount: p.ml_bets_away_amount, ml_bets_away_amount: p.ml_bets_home_amount,
          sp_bets_home: p.sp_bets_away, sp_bets_away: p.sp_bets_home,
          sp_bets_home_count: p.sp_bets_away_count, sp_bets_away_count: p.sp_bets_home_count,
          sp_bets_home_amount: p.sp_bets_away_amount, sp_bets_away_amount: p.sp_bets_home_amount,
        }
      }
      const STALE_MS = 36 * 60 * 60 * 1000
      const isRecent = p => !p.updated_at || (Date.now() - new Date(p.updated_at).getTime()) < STALE_MS
      const pinDate = game.starts_at ? game.starts_at.slice(0, 5) : null
      const dateScore = p => {
        if (!pinDate || !p.game_date) return 0
        return p.game_date.slice(5).replace('-', '/') === pinDate ? 2 : 0
      }
      const latestTime = p => p?.updated_at ? new Date(p.updated_at).getTime() || 0 : 0

      // betmanDirect(실시간) + protoData(Supabase fallback) 합쳐서 탐색
      const allProto = [...betmanDirect, ...protoData]

      const pickProto = (filter, reversed = false) => {
        const found = allProto
          .filter(p => filter(p) && isRecent(p))
          .map(p => ({ p, score: dateScore(p) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score || latestTime(b.p) - latestTime(a.p))[0]?.p
        return found ? orientProto(found, reversed) : null
      }

      if (game.league === 'MLB' || game.league === 'NBA') {
        const homeAbbr = TEAM_ABBREV[game.home] || ''
        const awayAbbr = TEAM_ABBREV[game.away] || ''
        if (!homeAbbr || !awayAbbr) return null
        const baseFilter = p =>
          p.sport === protoSport && p.league === game.league &&
          p.home_abbr?.toUpperCase() === homeAbbr.toUpperCase() &&
          p.away_abbr?.toUpperCase() === awayAbbr.toUpperCase()
        const reverseFilter = p =>
          p.sport === protoSport && p.league === game.league &&
          p.home_abbr?.toUpperCase() === awayAbbr.toUpperCase() &&
          p.away_abbr?.toUpperCase() === homeAbbr.toUpperCase()
        return pickProto(baseFilter) || pickProto(reverseFilter, true)
      }
      // KBO/NPB/soccer: home_abbr 직접 비교
      const baseFilter = p =>
        p.sport === protoSport &&
        norm(p.home_abbr) === norm(game.home) &&
        norm(p.away_abbr) === norm(game.away)
      const reverseFilter = p =>
        p.sport === protoSport &&
        norm(p.home_abbr) === norm(game.away) &&
        norm(p.away_abbr) === norm(game.home)
      return pickProto(baseFilter) || pickProto(reverseFilter, true)
    }

    const merged = linesData.filter(g =>
      !/(Games\))/i.test(g.home || '') && !/(Games\))/i.test(g.away || '')
    ).map(g => ({
      ...g,
      opening:       openingsMap[g.matchup_id] || null,
      recentAlerts:  alertsMap[g.matchup_id] ? Object.values(alertsMap[g.matchup_id]) : [],
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
    <div className="min-h-screen bg-slate-50 text-slate-900 max-w-[520px] mx-auto">
      {/* ── 헤더 ── */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-100 px-4 pb-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}>
        <div className="flex justify-between items-center mb-3 gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-shrink-0">
            <img src="/app-icon.png" alt="샤프시그널" className="w-8 h-8 rounded-lg flex-shrink-0" />
            <h1 className="text-lg font-bold text-slate-900 tracking-tight whitespace-nowrap">샤프시그널 어플</h1>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
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
              <button onClick={() => setShowMyPage(true)}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 active:bg-slate-300 transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500">
                  <circle cx="12" cy="8" r="4"/>
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                </svg>
              </button>
            ) : (
              <button onClick={onSignIn}
                disabled={signInLoading}
                className="text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 px-3 py-1.5 rounded-full transition-colors disabled:opacity-60">
                {signInLoading ? '연결 중...' : '로그인'}
              </button>
            )}
          </div>
        </div>

        {/* 조합 탭 - 단독 상단 행 */}
        <div className="flex gap-2 mb-2">
          <button
            onClick={() => { setTab('combo'); setSubLeague('all') }}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all
              ${tab === 'combo'
                ? 'bg-violet-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-500'}`}>
            시그널 픽
          </button>
          <button
            onClick={() => { setTab('baccarat'); setSubLeague('all') }}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all
              ${tab === 'baccarat'
                ? 'bg-rose-500 text-white shadow-sm'
                : 'bg-slate-100 text-slate-500'}`}>
            🃏 바카라패턴
          </button>
          <button
            onClick={() => { setTab('powerball'); setSubLeague('all') }}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all
              ${tab === 'powerball'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'bg-slate-100 text-slate-500'}`}>
            🔮 파워볼패턴
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

        {/* 바카라 서브탭 */}
        {tab === 'baccarat' && (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide mt-2">
            <button className="px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap bg-rose-500 text-white">
              🃏 EV바카라패턴
            </button>
          </div>
        )}

        {/* 파워볼 서브탭 */}
        {tab === 'powerball' && (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide mt-2">
            <button className="px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap bg-emerald-600 text-white">
              🔮 EOS 5분
            </button>
          </div>
        )}

        {/* 서브리그 필터 */}
        {currentSportGroup && subLeagues.length > 1 && tab !== 'combo' && tab !== 'baccarat' && (
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
      {tab === 'baccarat' ? (
        <BaccaratTab
          hasAccess={hasAccess}
          user={user}
          onShowUpgrade={() => setShowUpgrade(true)}
          onSignIn={onSignIn}
        />
      ) : tab === 'powerball' ? (
        <PowerballTab
          hasAccess={hasAccess}
          user={user}
          onShowUpgrade={() => setShowUpgrade(true)}
          onSignIn={onSignIn}
        />
      ) : (
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
      )}

      {selected && <HistoryModal game={selected} onClose={() => setSelected(null)} />}
      {showAdmin && <AdminScreen onClose={() => setShowAdmin(false)} />}
      {showUpgrade && <UpgradeModal onClose={() => setShowUpgrade(false)} />}
      {showMyPage && (
        <MyPage
          user={user}
          sub={sub}
          onSignOut={onSignOut}
          onShowUpgrade={() => { setShowMyPage(false); setShowUpgrade(true) }}
          onClose={() => setShowMyPage(false)}
        />
      )}
    </div>
  )
}

// ── 앱 진입점 (인증 래퍼) ────────────────────────────────────
export default function App() {
  const [user, setUser]             = useState(null)
  const [sub, setSub]               = useState(null)
  const [authReady, setReady]       = useState(false)
  const [showTrialPrompt, setShowTrialPrompt] = useState(false)
  const [signInLoading, setSignInLoading] = useState(false)

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
    if (signInLoading) return
    setSignInLoading(true)
    try {
      const isNative = Capacitor.isNativePlatform()
      const redirectTo = isNative
        ? 'https://pinnacle-bot.vercel.app'
        : `${window.location.origin}`
      // 혹시 열린 브라우저가 있으면 먼저 닫기
      try { await Browser.close() } catch (_) {}
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: isNative },
      })
      if (error) throw error
      if (isNative && data?.url) {
        await Browser.open({ url: data.url, presentationStyle: 'fullscreen' })
      }
    } catch (e) {
      console.error('[signIn]', e)
      alert('로그인 오류: ' + (e?.message || String(e)))
    } finally {
      setSignInLoading(false)
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
    <ErrorBoundary>
      <MainApp
        user={user}
        isAdmin={isAdmin}
        hasAccess={hasAccess}
        sub={sub}
        onSignOut={signOut}
        onSignIn={signInWithGoogle}
        signInLoading={signInLoading}
      />
      {showTrialPrompt && !isAdmin && (
        <TrialPromptModal
          onStart={handleTrialStart}
          onDecline={() => setShowTrialPrompt(false)}
        />
      )}
    </ErrorBoundary>
  )
}
