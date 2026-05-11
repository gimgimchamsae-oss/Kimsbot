#!/usr/bin/env python3
"""
Fetch football MoneyWay data from Excapper.

The public pages expose prematch/live game lists and per-game market history
directly in HTML, so this script uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from dataclasses import dataclass
from concurrent.futures import ThreadPoolExecutor, as_completed
from html import unescape
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BASE_URL = "https://www.excapper.com/"
DETAIL_URL = "https://www.excapper.com/index.php"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def clean_text(value: str) -> str:
    value = unescape(value)
    value = value.replace("\xa0", " ")
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def money_to_int(value: str) -> int | None:
    digits = re.sub(r"[^\d-]", "", value)
    return int(digits) if digits and digits != "-" else None


def fetch_html(url: str, retries: int = 3) -> str:
    req = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        },
    )
    last_error = ""
    for attempt in range(1, retries + 1):
        try:
            with urlopen(req, timeout=30) as response:
                return response.read().decode("utf-8", errors="replace")
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            last_error = f"HTTP {exc.code}: {detail[:300]}"
            if exc.code not in {429, 500, 502, 503, 504} or attempt == retries:
                break
        except URLError as exc:
            last_error = f"요청 실패: {exc.reason}"
            if attempt == retries:
                break
        time.sleep(attempt * 2)
    raise RuntimeError(last_error)


@dataclass
class GameRow:
    mode: str
    game_id: str
    kickoff: str
    country: str
    league: str
    teams: str
    all_money: str
    all_money_value: int | None
    url: str


class ListingParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.rows: list[GameRow] = []
        self.div_stack: list[str | None] = []
        self.current_section: str | None = None
        self.current_tr_attrs: dict[str, str] | None = None
        self.in_td = False
        self.current_td: list[str] = []
        self.cells: list[str] = []
        self.country = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {key: value or "" for key, value in attrs}
        if tag == "div":
            div_id = attrs_dict.get("id")
            self.div_stack.append(div_id)
            if div_id in {"premach", "live"}:
                self.current_section = "prematch" if div_id == "premach" else "live"
        elif tag == "tr" and self.current_section and "a_link" in attrs_dict.get("class", ""):
            self.current_tr_attrs = attrs_dict
            self.cells = []
            self.country = ""
        elif tag == "td" and self.current_tr_attrs is not None:
            self.in_td = True
            self.current_td = []
        elif tag == "img" and self.in_td and not self.country:
            self.country = attrs_dict.get("alt", "")

    def handle_endtag(self, tag: str) -> None:
        if tag == "td" and self.in_td:
            text = clean_text("".join(self.current_td))
            self.cells.append(self.country or text)
            self.in_td = False
            self.current_td = []
            self.country = ""
        elif tag == "tr" and self.current_tr_attrs is not None:
            if len(self.cells) >= 5 and self.current_section:
                game_id = self.current_tr_attrs.get("game_id", "")
                url = self.current_tr_attrs.get("data-game-link") or f"{BASE_URL}?action=game&id={game_id}"
                self.rows.append(
                    GameRow(
                        mode=self.current_section,
                        game_id=game_id,
                        kickoff=self.cells[0],
                        country=self.cells[1],
                        league=self.cells[2],
                        teams=self.cells[3],
                        all_money=self.cells[4],
                        all_money_value=money_to_int(self.cells[4]),
                        url=url,
                    )
                )
            self.current_tr_attrs = None
        elif tag == "div" and self.div_stack:
            div_id = self.div_stack.pop()
            if div_id in {"premach", "live"}:
                self.current_section = None

    def handle_data(self, data: str) -> None:
        if self.in_td:
            self.current_td.append(data)

    def handle_entityref(self, name: str) -> None:
        if self.in_td:
            self.current_td.append(" " if name == "emsp" else f"&{name};")

    def handle_charref(self, name: str) -> None:
        if self.in_td:
            self.current_td.append(f"&#{name};")


class DetailParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.title = ""
        self.league = ""
        self.market_tabs: dict[str, str] = {}
        self.rows: list[dict[str, Any]] = []
        self.current_rows: list[dict[str, Any]] = []
        self.div_stack: list[str | None] = []
        self.current_tab: str | None = None
        self.in_chart_item = False
        self.in_chart_title = False
        self.in_chart_coef = False
        self.chart_title: list[str] = []
        self.chart_coef: list[str] = []
        self.in_h1 = False
        self.in_h3 = False
        self.in_market_link: str | None = None
        self.text_buffer: list[str] = []
        self.in_td = False
        self.current_td: list[str] = []
        self.current_cells: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {key: value or "" for key, value in attrs}
        classes = set(attrs_dict.get("class", "").split())
        if tag == "div":
            div_id = attrs_dict.get("id")
            self.div_stack.append(div_id)
            if div_id and div_id.startswith("tab_content_"):
                self.current_tab = div_id
            if self.current_tab and "charts-bk__item" in classes:
                self.in_chart_item = True
                self.chart_title = []
                self.chart_coef = []
            elif self.in_chart_item and "charts-bk__item-title" in classes:
                self.in_chart_title = True
                self.text_buffer = []
            elif self.in_chart_item and "charts-bk__item-coef" in classes:
                self.in_chart_coef = True
                self.text_buffer = []
        elif tag == "a" and attrs_dict.get("data-tab", "").startswith("tab_content_"):
            self.in_market_link = attrs_dict["data-tab"]
            self.text_buffer = []
        elif tag == "h1":
            self.in_h1 = True
            self.text_buffer = []
        elif tag == "h3":
            self.in_h3 = True
            self.text_buffer = []
        elif tag == "tr" and self.current_tab:
            self.current_cells = []
        elif tag == "td" and self.current_cells is not None:
            self.in_td = True
            self.current_td = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self.in_market_link:
            self.market_tabs[self.in_market_link] = clean_text("".join(self.text_buffer))
            self.in_market_link = None
            self.text_buffer = []
        elif tag == "h1" and self.in_h1:
            self.title = clean_text("".join(self.text_buffer))
            self.in_h1 = False
            self.text_buffer = []
        elif tag == "h3" and self.in_h3:
            text = clean_text("".join(self.text_buffer))
            if text and "Value Bets" not in text:
                self.league = text
            self.in_h3 = False
            self.text_buffer = []
        elif tag == "div" and self.in_chart_title:
            self.chart_title.append(clean_text("".join(self.text_buffer)))
            self.in_chart_title = False
            self.text_buffer = []
        elif tag == "div" and self.in_chart_coef:
            self.chart_coef.append(clean_text("".join(self.text_buffer)))
            self.in_chart_coef = False
            self.text_buffer = []
        elif tag == "div" and self.in_chart_item:
            self._add_current_card()
            self.in_chart_item = False
        elif tag == "td" and self.in_td:
            self.current_cells.append(clean_text("".join(self.current_td)))
            self.in_td = False
            self.current_td = []
        elif tag == "tr" and self.current_cells is not None:
            self._add_row(self.current_cells)
            self.current_cells = None
        elif tag == "div" and self.div_stack:
            div_id = self.div_stack.pop()
            if div_id == self.current_tab:
                self.current_tab = None

    def handle_data(self, data: str) -> None:
        if self.in_market_link or self.in_h1 or self.in_h3 or self.in_chart_title or self.in_chart_coef:
            self.text_buffer.append(data)
        if self.in_td:
            self.current_td.append(data)

    def handle_entityref(self, name: str) -> None:
        text = " " if name == "emsp" else f"&{name};"
        if self.in_market_link or self.in_h1 or self.in_h3 or self.in_chart_title or self.in_chart_coef:
            self.text_buffer.append(text)
        if self.in_td:
            self.current_td.append(text)

    def handle_charref(self, name: str) -> None:
        text = f"&#{name};"
        if self.in_market_link or self.in_h1 or self.in_h3 or self.in_chart_title or self.in_chart_coef:
            self.text_buffer.append(text)
        if self.in_td:
            self.current_td.append(text)

    def _add_row(self, cells: list[str]) -> None:
        if len(cells) < 11:
            return
        if cells[0] not in {"premach", "live"}:
            return
        tab = self.current_tab or ""
        self.rows.append(
            {
                "game": self.title,
                "league": self.league,
                "market_group": self.market_tabs.get(tab, tab),
                "type": cells[0],
                "date": cells[1],
                "runner": cells[2],
                "summ": cells[3],
                "change": cells[4],
                "time": cells[5],
                "score": cells[6],
                "odds": cells[7],
                "change_percent": cells[8],
                "all": cells[9],
                "percent_money_on_market": cells[10],
            }
        )

    def _add_current_card(self) -> None:
        runner = clean_text(" ".join(self.chart_title))
        coef = clean_text(" ".join(self.chart_coef))
        if not runner or not coef:
            return
        match = re.match(r"^(.+?)\s*-\s*([0-9.]+)\s*$", coef)
        if not match:
            return
        summ, odds = match.groups()
        market_group = self.market_tabs.get(self.current_tab or "", self.current_tab or "")
        self.current_rows.append(
            {
                "game": self.title,
                "league": self.league,
                "market_group": market_group,
                "type": "current",
                "date": "",
                "runner": runner,
                "summ": summ,
                "change": "",
                "time": "",
                "score": "",
                "odds": odds,
                "change_percent": "",
                "all": "",
                "percent_money_on_market": "",
            }
        )


def parse_listing(html: str) -> list[GameRow]:
    parser = ListingParser()
    parser.feed(html)
    return parser.rows


def parse_detail(html: str, game_id: str) -> list[dict[str, Any]]:
    parser = DetailParser()
    parser.feed(html)
    rows = parser.current_rows or parser.rows
    for row in rows:
        row["game_id"] = game_id
    return rows


def output_rows(rows: list[dict[str, Any]], fmt: str, output: str | None) -> None:
    if fmt == "json":
        text = json.dumps(rows, ensure_ascii=False, indent=2)
        if output:
            with open(output, "w", encoding="utf-8") as file:
                file.write(text + "\n")
        else:
            print(text)
        return

    if fmt == "csv":
        fieldnames: list[str] = []
        for row in rows:
            for key in row.keys():
                if key not in fieldnames:
                    fieldnames.append(key)
        target = open(output, "w", newline="", encoding="utf-8-sig") if output else sys.stdout
        try:
            writer = csv.DictWriter(target, fieldnames=fieldnames)
            if fieldnames:
                writer.writeheader()
                writer.writerows(rows)
        finally:
            if output:
                target.close()
        return

    if not rows:
        print("데이터가 없습니다.")
        return

    columns: list[str] = []
    for row in rows:
        for key in row.keys():
            if key not in columns:
                columns.append(key)
    widths = [min(max(len(str(row.get(col, ""))) for row in rows + [{col: col}]), 42) for col in columns]
    print(" | ".join(col[:width].ljust(width) for col, width in zip(columns, widths)))
    print("-+-".join("-" * width for width in widths))
    for row in rows:
        values = [str(row.get(col, ""))[:width].ljust(width) for col, width in zip(columns, widths)]
        print(" | ".join(values))


def list_games(args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.games_csv:
        with open(args.games_csv, newline="", encoding="utf-8-sig") as file:
            games = list(csv.DictReader(file))
        if args.mode != "all":
            games = [game for game in games if game.get("mode") == args.mode]
        if args.limit:
            games = games[: args.limit]
        return games

    try:
        games = parse_listing(fetch_html(BASE_URL))
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from exc
    if args.mode != "all":
        games = [game for game in games if game.mode == args.mode]
    if args.limit:
        games = games[: args.limit]
    return [
        {
            "mode": game.mode,
            "game_id": game.game_id,
            "kickoff": game.kickoff,
            "country": game.country,
            "league": game.league,
            "teams": game.teams,
            "all_money": game.all_money,
            "all_money_value": game.all_money_value,
            "url": game.url,
        }
        for game in games
    ]


def add_game_metadata(rows: list[dict[str, Any]], game: dict[str, Any]) -> list[dict[str, Any]]:
    for row in rows:
        row["mode"] = game.get("mode", "")
        row["kickoff"] = game.get("kickoff", "")
        row["country"] = game.get("country", "")
        row["listing_league"] = game.get("league", "")
        row["listing_teams"] = game.get("teams", "")
        row["all_money"] = game.get("all_money", "")
    return rows


def filter_markets(rows: list[dict[str, Any]], markets: list[str] | None) -> list[dict[str, Any]]:
    if not markets:
        return rows
    wanted = {market.strip().lower() for market in markets if market.strip()}
    return [
        row for row in rows
        if str(row.get("market_group", "")).strip().lower() in wanted
    ]


def latest_runner_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for row in rows:
        key = (
            str(row.get("game_id", "")),
            str(row.get("market_group", "")).strip().lower(),
            str(row.get("runner", "")).strip().lower(),
        )
        if key in seen:
            continue
        seen.add(key)
        latest.append(row)
    return sorted(latest, key=runner_sort_key)


def runner_sort_key(row: dict[str, Any]) -> tuple[str, str, int, str]:
    market = str(row.get("market_group", ""))
    code = str(row.get("runner_code", row.get("runner", ""))).upper()
    if market.lower() == "match odds":
        order = {"1": 1, "X": 2, "2": 3}.get(code, 99)
    else:
        order = {"NO": 1, "YES": 2}.get(code, 99)
    return (
        str(row.get("game_id", "")),
        market,
        order,
        str(row.get("runner", "")),
    )


def normalize_runner_names(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for row in rows:
        row["runner_code"] = row.get("runner", "")
        if str(row.get("market_group", "")).lower() != "match odds":
            continue
        teams = str(row.get("game", "")).split(" - ", 1)
        home = teams[0] if teams else ""
        away = teams[1] if len(teams) > 1 else ""
        code = str(row.get("runner", "")).upper()
        if code == "1" and home:
            row["runner"] = home
        elif code == "X":
            row["runner"] = "DRAW"
        elif code == "2" and away:
            row["runner"] = away
    return rows


def compact_market_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    order: list[tuple[str, str, str]] = []
    for row in latest_runner_rows(rows):
        key = (
            str(row.get("game_id", "")),
            str(row.get("game", "")),
            str(row.get("market_group", "")),
        )
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append(row)

    compact: list[dict[str, Any]] = []
    for game_id, game, market_group in order:
        runners = grouped[(game_id, game, market_group)]
        item: dict[str, Any] = {
            "game_id": game_id,
            "mode": runners[0].get("mode", ""),
            "country": runners[0].get("country", ""),
            "kickoff": runners[0].get("kickoff", ""),
            "game": game,
            "league": runners[0].get("league", ""),
            "market_group": market_group,
            "all_money": runners[0].get("all_money", ""),
        }
        for index, runner in enumerate(runners, start=1):
            item[f"market{index}_runner"] = runner.get("runner", "")
            item[f"market{index}_odds"] = runner.get("odds", "")
            item[f"market{index}_summ"] = runner.get("summ", "")
            item[f"market{index}_percent"] = runner.get("percent_money_on_market", "")
        compact.append(item)
    return compact


def detail_rows(game_id: str, markets: list[str] | None = None) -> list[dict[str, Any]]:
    html = fetch_html(f"{DETAIL_URL}?{urlencode({'action': 'game', 'id': game_id})}")
    return normalize_runner_names(filter_markets(parse_detail(html, game_id), markets))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Excapper 축구 MoneyWay 데이터를 가져옵니다.")
    parser.add_argument("--game-id", help="상세 조회할 Excapper/Betfair game_id")
    parser.add_argument(
        "--markets",
        default="",
        help="상세 조회 시 가져올 마켓명 콤마 구분. 예: \"Match Odds,Both teams to Score?\"",
    )
    parser.add_argument(
        "--latest-only",
        action="store_true",
        help="상세 조회 결과에서 마켓/선택지별 최신 Summ 한 줄만 남기기",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="최신값을 경기+마켓당 한 줄로 펼쳐서 출력",
    )
    parser.add_argument(
        "--mode",
        choices=["prematch", "live", "all"],
        default="all",
        help="목록 조회 시 경기 상태 필터",
    )
    parser.add_argument("--limit", type=int, default=20, help="목록 출력 개수. 0이면 전체")
    parser.add_argument(
        "--games-csv",
        help="이미 저장한 경기 목록 CSV를 사용해 상세 조회. 예: excapper_games_all.csv",
    )
    parser.add_argument(
        "--details",
        action="store_true",
        help="목록 상위 N개 경기의 상세 구매율까지 가져오기",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=6,
        help="상세 조회 병렬 요청 수",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=1.0,
        help="workers=1일 때 상세 요청 사이 대기 초",
    )
    parser.add_argument(
        "--format",
        choices=["table", "json", "csv"],
        default="table",
        help="출력 형식",
    )
    parser.add_argument("--output", help="csv/json 저장 경로")
    return parser.parse_args()


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args()
    if args.limit == 0:
        args.limit = None
    markets = [market.strip() for market in args.markets.split(",") if market.strip()]

    if args.game_id:
        rows = detail_rows(args.game_id, markets)
    elif args.details:
        games = list_games(args)
        rows = []
        workers = max(1, args.workers)
        if workers == 1:
            for game in games:
                try:
                    rows.extend(add_game_metadata(detail_rows(str(game["game_id"]), markets), game))
                except BaseException as exc:
                    print(
                        f"상세 조회 실패 game_id={game['game_id']}: {exc}",
                        file=sys.stderr,
                    )
                if args.delay > 0:
                    time.sleep(args.delay)
        else:
            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {
                    executor.submit(detail_rows, str(game["game_id"]), markets): game
                    for game in games
                }
                for future in as_completed(futures):
                    game = futures[future]
                    try:
                        rows.extend(add_game_metadata(future.result(), game))
                    except BaseException as exc:
                        print(
                            f"상세 조회 실패 game_id={game['game_id']}: {exc}",
                            file=sys.stderr,
                        )
    else:
        rows = list_games(args)

    if args.latest_only or args.compact:
        rows = latest_runner_rows(rows)
    if args.compact:
        rows = compact_market_rows(rows)

    output_rows(rows, args.format, args.output)


if __name__ == "__main__":
    main()
