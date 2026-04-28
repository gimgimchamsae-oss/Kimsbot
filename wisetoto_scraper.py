"""
wisetoto.com 배트맨 구매비율 스크래퍼
- Playwright로 프로토 게임 목록 로드 (세션 쿠키 확보)
- get_same_rate_info.htm JSON API로 각 게임 구매비율 취득
- Supabase proto_betting 테이블 저장
"""

import asyncio
import os
import re
import json
import aiohttp
from datetime import datetime, timezone, timedelta
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

KST = timezone(timedelta(hours=9))

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

BASE = "https://www.wisetoto.com"
RATE_INFO_URL = BASE + "/util/gameinfo/get_same_rate_info.htm"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# ── 한글 → 영문 팀명 매핑 ─────────────────────────────────────────

KR_ABBREV = {
    # ── MLB 풀네임 ─────────────────────────────────────────────────
    '볼티모어': 'BAL', '보스턴': 'BOS', '뉴욕Y': 'NYY', '뉴욕M': 'NYM',
    '탬파베이': 'TB', '토론토': 'TOR', '클리블랜드': 'CLE',
    '시카고W': 'CWS', '시카고C': 'CHC', '디트로이트': 'DET',
    '캔자스시티': 'KC', '미네소타': 'MIN', '휴스턴': 'HOU',
    'LA에': 'LAA', 'LA다': 'LAD', '애슬레틱스': 'ATH', '오클랜드': 'ATH',
    '시애틀': 'SEA', '텍사스': 'TEX', '애틀랜타': 'ATL',
    '마이애미': 'MIA', '필라델피아': 'PHI', '워싱턴': 'WSH',
    '밀워키': 'MIL', '신시내티': 'CIN', '피츠버그': 'PIT',
    '세인트루이스': 'STL', '콜로라도': 'COL', '애리조나': 'AZ',
    '샌디에이고': 'SD', '샌프란시스코': 'SF',
    '뉴욕메츠': 'NYM', '뉴욕양키스': 'NYY',
    'LA에인절스': 'LAA', 'LA다저스': 'LAD',
    # ── MLB 와이즈토토 축약명 (4~5자 잘림) ─────────────────────────
    '볼티오리': 'BAL',   # 볼티모어 오리올스
    '보스레드': 'BOS',   # 보스턴 레드삭스
    '뉴욕양키': 'NYY',   # 뉴욕 양키스
    '뉴욕메츠': 'NYM',   # 뉴욕 메츠
    '탬파레이': 'TB',    # 탬파베이 레이즈
    '토론블루': 'TOR',   # 토론토 블루제이스
    '클리가디': 'CLE',   # 클리블랜드 가디언스
    '시카화이': 'CWS',   # 시카고 화이트삭스
    '시카컵스': 'CHC',   # 시카고 컵스
    '디트타이': 'DET',   # 디트로이트 타이거즈
    '캔자로얄': 'KC',    # 캔자스시티 로얄스
    '미네트윈': 'MIN',   # 미네소타 트윈스
    '휴스애스': 'HOU',   # 휴스턴 애스트로스
    'LA에인절': 'LAA',   # LA에인절스
    'LA다저스': 'LAD',   # LA다저스 (full)
    '애슬레틱': 'ATH',   # 애슬레틱스
    '시애매리': 'SEA',   # 시애틀 매리너스
    '텍사레인': 'TEX',   # 텍사스 레인저스
    '애틀브레': 'ATL',   # 애틀랜타 브레이브스
    '마이말린': 'MIA',   # 마이애미 말린스
    '필라필리': 'PHI',   # 필라델피아 필리스
    '워싱내셔': 'WSH',   # 워싱턴 내셔널스
    '밀워브루': 'MIL',   # 밀워키 브루어스
    '신시레즈': 'CIN',   # 신시내티 레즈
    '피츠파이': 'PIT',   # 피츠버그 파이리츠
    '세인카디': 'STL',   # 세인트루이스 카디널스
    '콜로로키': 'COL',   # 콜로라도 로키스
    '애리다이': 'AZ',    # 애리조나 다이아몬드백스
    '샌디파드': 'SD',    # 샌디에이고 파드리스
    '샌프자이': 'SF',    # 샌프란시스코 자이언츠
    # ── NBA 풀네임 ─────────────────────────────────────────────────
    '골든스테이트': 'GSW', 'LA클': 'LAC', 'LA레': 'LAL',
    '댈러스': 'DAL', '덴버': 'DEN', '인디애나': 'IND',
    '멤피스': 'MEM', '뉴올리언스': 'NOP', '뉴욕K': 'NYK',
    '오클라호마': 'OKC', '올랜도': 'ORL', '피닉스': 'PHX',
    '포틀랜드': 'POR', '새크라멘토': 'SAC', '샌안토니오': 'SAS',
    '유타': 'UTA', '브루클린': 'BKN', '샬럿': 'CHA',
    '보스턴 셀틱스': 'BOS', '브루클린 네츠': 'BKN',
    '뉴욕 닉스': 'NYK', '필라델피아 76어스': 'PHI',
    '토론토 랩터스': 'TOR', '골든스테이트 워리어스': 'GSW',
    'LA 클리퍼스': 'LAC', 'LA 레이커스': 'LAL',
    '피닉스 선즈': 'PHX', '새크라멘토 킹스': 'SAC',
    '댈러스 매버릭스': 'DAL', '휴스턴 로케츠': 'HOU',
    '멤피스 그리즐리스': 'MEM', '뉴올리언스 펠리컨스': 'NOP',
    '샌안토니오 스퍼스': 'SAS', '오클라호마 시티 썬더': 'OKC',
    '덴버 너게츠': 'DEN', '미네소타 팀버울브스': 'MIN',
    '포틀랜드 트레일블레이저스': 'POR', '유타 재즈': 'UTA',
    '클리블랜드 캐벌리어스': 'CLE', '인디애나 페이서스': 'IND',
    '시카고 불스': 'CHI', '디트로이트 피스톤스': 'DET',
    '밀워키 벅스': 'MIL', '마이애미 히트': 'MIA',
    '올랜도 매직': 'ORL', '샬럿 호네츠': 'CHA',
    '애틀랜타 호크스': 'ATL', '워싱턴 위저즈': 'WSH',
    # ── NBA 와이즈토토 축약명 ──────────────────────────────────────
    '휴스로케': 'HOU',   # 휴스턴 로케츠
    'LA레이커': 'LAL',   # LA레이커스
    'LA클리퍼': 'LAC',   # LA클리퍼스
    '올랜매직': 'ORL',   # 올랜도 매직
    '디트피스': 'DET',   # 디트로이트 피스톤스
    '피닉선즈': 'PHX',   # 피닉스 선즈
    '오클썬더': 'OKC',   # 오클라호마 시티 썬더
    '덴버너게': 'DEN',   # 덴버 너게츠
    '미네울브': 'MIN',   # 미네소타 팀버울브스
    '보스셀틱': 'BOS',   # 보스턴 셀틱스
    '필라76s': 'PHI',    # 필라델피아 76어스
    '뉴욕닉스': 'NYK',   # 뉴욕 닉스
    '애틀호크': 'ATL',   # 애틀랜타 호크스
    '샌안스퍼': 'SAS',   # 샌안토니오 스퍼스
    '포틀트레': 'POR',   # 포틀랜드 트레일블레이저스
    '골든워리': 'GSW',   # 골든스테이트 워리어스
    '댈러매브': 'DAL',   # 댈러스 매버릭스
    '멤피그리': 'MEM',   # 멤피스 그리즐리스
    '뉴올펠리': 'NOP',   # 뉴올리언스 펠리컨스
    '유타재즈': 'UTA',   # 유타 재즈
    '브루클네': 'BKN',   # 브루클린 네츠
    '샬럿호네': 'CHA',   # 샬럿 호네츠
    '인디페이': 'IND',   # 인디애나 페이서스
    '클리캐벌': 'CLE',   # 클리블랜드 캐벌리어스
    '시카불스': 'CHI',   # 시카고 불스
    '마이히트': 'MIA',   # 마이애미 히트
    '새크킹스': 'SAC',   # 새크라멘토 킹스
    '워싱위저': 'WSH',   # 워싱턴 위저즈
    '토론랩터': 'TOR',   # 토론토 랩터스
    # ── KBO ──────────────────────────────────────────────────────
    '두산': 'Doosan Bears', '두산 베어스': 'Doosan Bears',
    '한화': 'Hanwha Eagles', '한화 이글스': 'Hanwha Eagles',
    'KT': 'KT Wiz', 'KT 위즈': 'KT Wiz',
    'KIA': 'Kia Tigers', 'KIA 타이거즈': 'Kia Tigers',
    '키움': 'Kiwoom Heroes', '키움 히어로즈': 'Kiwoom Heroes',
    'LG': 'LG Twins', 'LG 트윈스': 'LG Twins',
    '롯데': 'Lotte Giants', '롯데 자이언츠': 'Lotte Giants',
    'NC': 'NC Dinos', 'NC 다이노스': 'NC Dinos',
    'SSG': 'SSG Landers', 'SSG 랜더스': 'SSG Landers',
    '삼성': 'Samsung Lions', '삼성 라이온즈': 'Samsung Lions',
    # ── NPB 와이즈토토 축약명 ──────────────────────────────────────
    '세이부': 'Saitama Seibu Lions',
    '닛폰햄': 'Hokkaido Nippon-Ham Fighters',
    '요미우리': 'Yomiuri Giants',
    '히로카프': 'Hiroshima Toyo Carp',
    '야쿠르트': 'Tokyo Yakult Swallows',
    '한신': 'Hanshin Tigers',
    '주니치': 'Chunichi Dragons',
    '요코베이': 'Yokohama Bay Stars',
    '지바롯데': 'Chiba Lotte Marines',
    '라쿠텐': 'Tohoku Rakuten Golden Eagles',
    '오릭스': 'Orix Buffaloes',
    '소프트뱅': 'Fukuoka Softbank Hawks',
    # ── KBL ──────────────────────────────────────────────────────
    '서울SK': 'Seoul SK', '부산KCC': 'Busan KCC', '원주DB': 'Wonju DB',
    '울산현대모비스': 'Ulsan Mobis', '창원LG': 'Changwon LG',
    '고양소노': 'Goyang Sono', '수원KT': 'Suwon KT',
    '안양정관장': 'Anyang Jeonggwanjang',
    '안양정관': 'Anyang Jeonggwanjang',   # 축약형
    '대구한국가스공사': 'Daegu KOGAS',
    '서울삼성': 'Seoul Samsung',
}

KR_SOCCER = {
    # EPL
    '아스널': 'Arsenal', '첼시': 'Chelsea', '리버풀': 'Liverpool',
    '맨체스터시티': 'Manchester City', '맨체스터 시티': 'Manchester City',
    '토트넘홋스퍼': 'Tottenham', '토트넘 홋스퍼': 'Tottenham',
    '뉴캐슬유나이티드': 'Newcastle', '뉴캐슬 유나이티드': 'Newcastle',
    '맨체스터유나이티드': 'Manchester United',
    '웨스트햄유나이티드': 'West Ham', '웨스트햄 유나이티드': 'West Ham',
    '아스톤빌라': 'Aston Villa', '애스턴 빌라': 'Aston Villa', '애스턴빌라': 'Aston Villa',
    '에버턴': 'Everton', '풀럼': 'Fulham',
    '울버햄프턴원더러스': 'Wolverhampton', '울버햄프턴 원더러스': 'Wolverhampton',
    '브렌트퍼드': 'Brentford', '브라이튼': 'Brighton',
    '크리스털팰리스': 'Crystal Palace', '크리스털 팰리스': 'Crystal Palace',
    '노팅엄포리스트': 'Nottingham Forest', '노팅엄 포리스트': 'Nottingham Forest',
    '본머스': 'Bournemouth', '레스터시티': 'Leicester City',
    '사우샘프턴': 'Southampton', '입스위치타운': 'Ipswich Town',
    '입스위치 타운': 'Ipswich Town',
    # La Liga
    '레알마드리드': 'Real Madrid', '바르셀로나': 'Barcelona',
    '아틀레티코마드리드': 'Atletico Madrid', '아틀레티코 마드리드': 'Atletico Madrid',
    '세비야': 'Sevilla', '레알베티스': 'Real Betis',
    '레알소시에다드': 'Real Sociedad', '아틀레틱빌바오': 'Athletic Bilbao',
    '비야레알': 'Villarreal', '발렌시아': 'Valencia',
    '헤타페': 'Getafe', '오사수나': 'Osasuna',
    'RC셀타데비고': 'Celta Vigo', '셀타데비고': 'Celta Vigo',
    'RCD마요르카': 'Mallorca', '마요르카': 'Mallorca',
    'RCD에스파뇰': 'Espanyol', '지로나': 'Girona',
    # Bundesliga
    '바이에른뮌헨': 'Bayern Munich', '바이에른 뮌헨': 'Bayern Munich',
    '도르트문트': 'Borussia Dortmund',
    '바이어04레버쿠젠': 'Bayer Leverkusen', '바이어 04 레버쿠젠': 'Bayer Leverkusen',
    'RB라이프치히': 'RB Leipzig', '프랑크푸르트': 'Eintracht Frankfurt',
    'SC프라이부르크': 'Freiburg', '베르더브레멘': 'Werder Bremen',
    'VfB슈투트가르트': 'VfB Stuttgart', 'VfL볼프스부르크': 'Wolfsburg',
    'TSG1899호펜하임': 'TSG Hoffenheim', '아우크스부르크': 'Augsburg',
    '쾰른': 'FC Koln', '우니온베를린': 'Union Berlin',
    '장크트파울리': 'St. Pauli', '하이덴하임': 'Heidenheim',
    'FSV마인츠05': 'Mainz 05',
    # Serie A
    '유벤투스': 'Juventus', 'AC밀란': 'AC Milan', 'AS로마': 'AS Roma',
    'SSC나폴리': 'Napoli',
    '인테르나치오날레밀라노': 'Inter Milan', '인테르나치오날레 밀라노': 'Inter Milan',
    '볼로냐': 'Bologna',
    '아탈란타BC': 'Atalanta', '아탈란타': 'Atalanta',
    '피오렌티나': 'Fiorentina', 'SS라치오': 'Lazio', '라치오': 'Lazio',
    '토리노': 'Torino', '제노아': 'Genoa', '파르마': 'Parma',
    '엘라스베로나': 'Hellas Verona', 'US레체': 'Lecce',
    '코모1907': 'Como', '칼리아리': 'Cagliari', '우디네세': 'Udinese',
    # Ligue 1
    '파리생제르맹': 'Paris Saint-Germain', '파리 생제르맹': 'Paris Saint-Germain',
    '올랭피크드마르세유': 'Marseille', '올랭피크리옹': 'Lyon',
    'AS모나코': 'Monaco', 'OGC니스': 'Nice', '릴OSC': 'Lille',
    'RC랑스': 'Lens', '스타드렌': 'Rennes', '낭트': 'Nantes',
    '스타드브레스투아29': 'Brest', '툴루즈': 'Toulouse',
    'AJ오세르': 'Auxerre', '앙제SCO': 'Angers',
    # K리그
    'FC서울': 'FC Seoul', '울산HDFC': 'Ulsan HD',
    '전북현대모터스': 'Jeonbuk Hyundai', '포항스틸러스': 'Pohang Steelers',
    '인천유나이티드': 'Incheon United', '강원FC': 'Gangwon',
    '광주FC': 'Gwangju FC', '대전하나시티즌': 'Daejeon Citizen',
    '제주SKFC': 'Jeju United', '김천상무프로축구단': 'Gimcheon Sangmu',
    '수원삼성블루윙즈': 'Suwon Samsung',
    # J리그 J1
    '비셀고베': 'Vissel Kobe', '비셀 고베': 'Vissel Kobe',
    '요코하마F마리노스': 'Yokohama F. Marinos',
    '가와사키프론탈레': 'Kawasaki Frontale',
    '가시마앤틀러스': 'Kashima Antlers',
    '감바오사카': 'Gamba Osaka',
    '우라와레드다이아몬즈': 'Urawa Red Diamonds',
    '나고야그램퍼스': 'Nagoya Grampus',
    '세레소오사카': 'Cerezo Osaka',
    '산프레체히로시마': 'Sanfrecce Hiroshima',
    'FC도쿄': 'FC Tokyo',
    '아비스파후쿠오카': 'Avispa Fukuoka',
    '가시와레이솔': 'Kashiwa Reysol',
    '홋카이도콘사도레삿포로': 'Consadole Sapporo',
    '도쿄베르디': 'Tokyo Verdy',
    'FC마치다젤비아': 'Machida Zelvia',
    '교토상가FC': 'Kyoto Sanga',
    'FC이마바리': 'FC Imabari',
    'V바렌나가사키': 'V-Varen Nagasaki',
    'RB오미야아르디자': 'Omiya Ardija',
    # J리그 J2/J3
    '제프유나이티드지바': 'JEF United Chiba',
    '파지아노오카야마': 'Fagiano Okayama',
    '몬테디오야마가타': 'Montedio Yamagata',
    '미토홀리호크': 'Mito Hollyhock',
    '카탈레도야마': 'Kataller Toyama',
    '블라우블리츠아키타': 'Blaublitz Akita',
    '이와키FC': 'Iwaki FC',
    '후지에다MYFC': 'Fujiedha MYFC',
    # UCL/국제대회 팀 (한글 표기 기준)
    '레알마드리드': 'Real Madrid', 'PSG': 'Paris Saint-Germain',
    '아스날': 'Arsenal', '보루시아도르트문트': 'Borussia Dortmund',
    '이나치오날레밀라노': 'Inter Milan',
    # ── 와이즈토토 EPL 축약명 ─────────────────────────────────────
    '맨체스U': 'Manchester United',   # 맨체스터 유나이티드
    '브렌트퍼': 'Brentford',
    # ── 라리가 ────────────────────────────────────────────────────
    '에스파뇰': 'Espanyol',
    '레반테': 'Levante',
    # ── EFL챔피언십 ───────────────────────────────────────────────
    '사우샘프': 'Southampton',
    '입스위치': 'Ipswich Town',
    # ── UCL (챔피언스리그) ─────────────────────────────────────────
    '바이뮌헨': 'Bayern Munich',
    '이나치오': 'Inter Milan',
    # ── MLS / 미국FA컵 ────────────────────────────────────────────
    'LAFC': 'LAFC', 'LA갤럭시': 'LA Galaxy',
    '샬럿FC': 'Charlotte FC',
    '애틀유나': 'Atlanta United',
    '새너어스': 'San Jose Earthquakes',
    '미네유나': 'Minnesota United',
    '내슈빌SC': 'Nashville SC',
    # ── C챔피언(CONCACAF) ─────────────────────────────────────────
    '티그레스': 'Tigres UANL',
    # ── J1리그 / J1백년 축약명 ───────────────────────────────────
    '도쿄베르': 'Tokyo Verdy',
    '가시마': 'Kashima Antlers',
    '시미즈': 'Shimizu S-Pulse',
    'V바렌나': 'V-Varen Nagasaki',
    '제프유나': 'JEF United Chiba',
    '요코마리': 'Yokohama F. Marinos',
    'C오사카': 'Cerezo Osaka',
    '후쿠오카': 'Avispa Fukuoka',
    '산프히로': 'Sanfrecce Hiroshima',
    '우라와': 'Urawa Red Diamonds',
    '가와사키': 'Kawasaki Frontale',
    '나고야': 'Nagoya Grampus',
    '오카야마': 'Fagiano Okayama',
    '교토상가': 'Kyoto Sanga',
    'G오사카': 'Gamba Osaka',
    '미토': 'Mito Hollyhock',
    '마치다': 'Machida Zelvia',
    '가시와': 'Kashiwa Reysol',
    '삿포로': 'Consadole Sapporo',
    # ── J2/J3리그 / J2J3백년 축약명 ──────────────────────────────
    'RB오미야': 'Omiya Ardija',
    '아키타': 'Blaublitz Akita',
    '야마가타': 'Montedio Yamagata',
    '요코FC': 'Yokohama FC',
    '하치노헤': 'Vanraure Hachinohe',
    '후지에다': 'Fujiedha MYFC',
    '고후': 'Ventforet Kofu',
    '도야마': 'Kataller Toyama',
    '니가타': 'Albirex Niigata',
    '도치기': 'Tochigi SC',
    '이와키': 'Iwaki FC',
    '나가노': 'AC Nagano Parceiro',
    '기후': 'FC Gifu',
    '오이타': 'Oita Trinita',
    '로아소': 'Roasso Kumamoto',
}


def _norm(name: str) -> str:
    return re.sub(r'\s+', ' ', (name or '').strip())


def _en(name: str, sport: str) -> str:
    n = _norm(name)
    if sport == 'soccer':
        return KR_SOCCER.get(n, n)
    return KR_ABBREV.get(n, n)


# ── HTML 파싱 ────────────────────────────────────────────────────

def _sport_from_class(classes: list) -> str:
    for c in (classes or []):
        if c == 'sc': return 'soccer'
        if c == 'bk': return 'basketball'
        if c == 'bs': return 'baseball'
    return 'other'


def _bet_type(ul) -> str:
    """Return rate_kind code: n/y/u/e  or None if we skip this row."""
    if ul.find('li', class_='hm') is not None:
        txt = (ul.find('li', class_='hm') or {}).get_text(strip=True) if hasattr(ul.find('li', class_='hm'), 'get_text') else ''
        if txt == '':
            return 'n'          # 홈승(1x2)
        return 'y'              # 핸디승
    if ul.find('li', class_='hp') is not None:
        return 'y'              # 핸디패
    if ul.find('li', class_='un') is not None:
        return 'u'              # O/U
    if ul.find('li', class_='d5') is not None:
        d5 = ul.find('li', class_='d5')
        if 'SUM' in (d5.get_text(strip=True) if d5 else ''):
            return 'e'          # 홀짝
    return None


def parse_proto_list(html: str) -> list[dict]:
    """proto_list.htm HTML → game row list."""
    soup = BeautifulSoup(html, 'html.parser')
    # Try div.gameinfo first, then body
    container = soup.find('div', class_='gameinfo') or soup
    rows = []
    for ul in container.find_all('ul', recursive=False if container.name == 'div' else True):
        a1 = ul.find('li', class_='a1')
        if not a1:
            continue
        game_no = a1.get_text(strip=True)

        a2 = ul.find('li', class_='a2')
        date_str = a2.get_text(strip=True) if a2 else ''

        a3 = ul.find('li', class_='a3')
        sport = _sport_from_class(a3.get('class', []) if a3 else [])
        if sport == 'other':
            continue

        a4 = ul.find('li', class_='a4')
        league = a4.get_text(strip=True) if a4 else ''

        rate_kind = _bet_type(ul)
        if rate_kind is None:
            continue

        # Home team
        home = ''
        for cls in ('a6', 'a6_un'):
            li = ul.find('li', class_=cls)
            if li:
                sp = li.find('span', class_=['tnb', 'tn'])
                if sp:
                    home = sp.get_text(strip=True)
                    break

        # Away team
        away = ''
        for cls in ('a8', 'a8_un'):
            li = ul.find('li', class_=cls)
            if li:
                sp = li.find('span', class_=['tnb', 'tn'])
                if sp:
                    away = sp.get_text(strip=True)
                    break

        if not home or not away:
            continue

        # year / round from a2 or from a14 onclick
        a14 = ul.find('li', class_='a14')
        year, rnd = '', ''
        if a14:
            oc = a14.get('onclick', '')
            m = re.search(r"'proto'\s*,\s*'(\d{4})'\s*,\s*'(\d+)'", oc)
            if m:
                year, rnd = m.group(1), m.group(2)

        rows.append({
            'game_no': game_no,
            'date': date_str,
            'sport': sport,
            'league': league,
            'rate_kind': rate_kind,
            'home': home,
            'away': away,
            'year': year,
            'round': rnd,
        })
    return rows


# ── 구매비율 JSON 파싱 ────────────────────────────────────────────

def _pct(val) -> int | None:
    if val is None or val == '' or val == 'null':
        return None
    try:
        v = round(float(val))
        return v if 0 <= v <= 100 else None
    except Exception:
        return None


def parse_rate_json(data: dict, rate_kind: str, sport: str = '') -> dict:
    """get_same_rate_info.htm JSON → purchase ratio fields."""
    result = {
        'ml_bets_home': None, 'ml_bets_draw': None, 'ml_bets_away': None,
        'ou_bets_over': None, 'ou_bets_under': None,
        'sp_bets_home': None, 'sp_bets_away': None,
    }
    w = _pct(data.get('w_m_per'))
    d = _pct(data.get('d_m_per'))
    l_ = _pct(data.get('l_m_per'))

    if rate_kind == 'n':        # 홈승(ML)
        result['ml_bets_home'] = w
        # 농구·야구는 무승부 없음 — 해당 % 무시
        result['ml_bets_draw'] = d if sport == 'soccer' else None
        result['ml_bets_away'] = l_
    elif rate_kind == 'y':      # 핸디
        result['sp_bets_home'] = w
        result['sp_bets_away'] = l_
    elif rate_kind == 'u':      # O/U  (w=언더, l=오버 — wisetoto 표기 기준)
        result['ou_bets_under'] = w
        result['ou_bets_over'] = l_
    return result


# ── 메인 로직 ────────────────────────────────────────────────────

async def fetch_rate(session: aiohttp.ClientSession, row: dict) -> dict | None:
    """단일 게임 구매비율 취득."""
    params = {
        'game_year': row['year'],
        'game_round': row['round'],
        'game_no': row['game_no'],
        'rate_kind': row['rate_kind'],
    }
    try:
        async with session.get(RATE_INFO_URL, params=params, timeout=aiohttp.ClientTimeout(total=10)) as res:
            if res.status != 200:
                return None
            data = await res.json(content_type=None)
            return parse_rate_json(data, row['rate_kind'], sport=row['sport'])
    except Exception as e:
        return None


async def scrape(page) -> list[dict]:
    proto_list_html = None

    async def on_response(res):
        nonlocal proto_list_html
        if 'get_proto_list.htm' in res.url:
            try:
                proto_list_html = await res.text()
                print(f'  proto list 수신 ({len(proto_list_html)} chars)')
            except Exception:
                pass

    page.on('response', on_response)

    await page.goto(
        BASE + '/index.htm?tab_type=proto&game_type=pt&game_category=pt1',
        wait_until='domcontentloaded', timeout=60000
    )
    await page.wait_for_timeout(7000)

    if not proto_list_html:
        print('[ERROR] proto list 수신 실패')
        return []

    rows = parse_proto_list(proto_list_html)
    print(f'  게임 행 파싱: {len(rows)}건')

    # year/round 미확인 행 보완 (page title 또는 URL에서)
    current_year, current_round = '', ''
    for r in rows:
        if r['year'] and r['round']:
            current_year, current_round = r['year'], r['round']
            break
    if not current_year:
        # proto list URL에서 추출
        m = re.search(r'game_year=(\d{4}).*?game_round=(\d+)', proto_list_html)
        if m:
            current_year, current_round = m.group(1), m.group(2)
    print(f'  연도={current_year} 회차={current_round}')

    for r in rows:
        if not r['year']:
            r['year'] = current_year
        if not r['round']:
            r['round'] = current_round

    # 쿠키를 aiohttp로 복사
    cookies = await page.context.cookies()
    cookie_jar = aiohttp.CookieJar()
    jar_cookies = {c['name']: c['value'] for c in cookies if 'wisetoto' in c.get('domain', '')}

    headers = {
        'User-Agent': UA,
        'Referer': BASE + '/',
    }

    # 비동기 구매비율 취득
    print(f'  구매비율 취득 중 ({len(rows)}건)...')
    match_map: dict[tuple, dict] = {}
    unmatched = set()

    async with aiohttp.ClientSession(headers=headers, cookies=jar_cookies) as session:
        # 동시 50건 제한 (서버 부하 방지)
        sem = asyncio.Semaphore(50)

        async def fetch_with_sem(row):
            async with sem:
                return row, await fetch_rate(session, row)

        tasks = [fetch_with_sem(r) for r in rows]
        results = await asyncio.gather(*tasks)

    success = 0
    for row, ratio in results:
        if ratio is None:
            continue
        sport = row['sport']
        home_en = _en(row['home'], sport)
        away_en = _en(row['away'], sport)

        # 미매핑 팀명 수집 (축구)
        if sport == 'soccer':
            if home_en == row['home']:
                unmatched.add(f"{row['league']}:{row['home']}")
            if away_en == row['away']:
                unmatched.add(f"{row['league']}:{row['away']}")

        key = (sport, row['league'], row['home'], row['away'])
        if key not in match_map:
            match_map[key] = {
                'sport': sport,
                'league': row['league'],
                'home': row['home'],
                'away': row['away'],
                'home_abbr': home_en,
                'away_abbr': away_en,
                'ml_bets_home': None, 'ml_bets_draw': None, 'ml_bets_away': None,
                'ou_bets_over': None, 'ou_bets_under': None,
                'sp_bets_home': None, 'sp_bets_away': None,
                'updated_at': datetime.now(KST).isoformat(),
            }

        g = match_map[key]
        for k, v in ratio.items():
            if v is not None:
                g[k] = v
        success += 1

    print(f'  구매비율 수신 성공: {success}/{len(rows)}건')
    if unmatched:
        print(f'  [미매핑] {sorted(unmatched)[:20]}')

    records = list(match_map.values())

    # 스포츠별 샘플 출력
    by_sport: dict[str, list] = {}
    for r in records:
        by_sport.setdefault(r['sport'], []).append(r)
    for sport, gs in sorted(by_sport.items()):
        print(f'\n  [{sport.upper()}] {len(gs)}경기')
        for g in gs[:3]:
            if sport == 'soccer':
                print(f'    [{g["league"]}] {g["home"]} vs {g["away"]}')
                print(f'      홈승:{g["ml_bets_home"]}% 무:{g["ml_bets_draw"]}% 원정:{g["ml_bets_away"]}%'
                      f' | O/U오버:{g["ou_bets_over"]}% 언더:{g["ou_bets_under"]}%')
            else:
                print(f'    [{g["league"]}] {g["home"]}({g["home_abbr"]}) vs {g["away"]}({g["away_abbr"]})')
                print(f'      홈:{g["ml_bets_home"]}% 원정:{g["ml_bets_away"]}%'
                      f' | O/U오버:{g["ou_bets_over"]}% 언더:{g["ou_bets_under"]}%')

    return records


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        )
        page = await browser.new_page(
            user_agent=UA,
            viewport={'width': 1280, 'height': 900}
        )

        records = await scrape(page)
        await browser.close()

    print(f'\n총 {len(records)}경기 수집 완료')

    if not records:
        print('데이터 없음')
        return

    # 디버그 저장
    with open('wisetoto_records.json', 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    print('wisetoto_records.json 저장됨')

    if SUPABASE_URL and SUPABASE_KEY:
        try:
            from supabase import create_client
            sb = create_client(SUPABASE_URL, SUPABASE_KEY)
            sb.table('proto_betting').delete().neq('id', 0).execute()
            sb.table('proto_betting').insert(records).execute()
            print('Supabase proto_betting 저장 완료!')
        except Exception as e:
            print(f'Supabase 저장 실패: {e}')
    else:
        print('[로컬] SUPABASE_URL/KEY 미설정 - DB 저장 생략')


if __name__ == '__main__':
    asyncio.run(main())
