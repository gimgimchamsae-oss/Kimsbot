"""
Render Web Service 진입점
cron-job.org가 /run 엔드포인트를 5분마다 호출
"""

import os
import sys
import io
from flask import Flask

app = Flask(__name__)


@app.route("/")
def health():
    return "OK", 200


@app.route("/run")
def trigger():
    try:
        # stdout 캡처 방지 — 출력은 Render 로그로만
        from monitor import run
        run()
        return "ok", 200
    except Exception as e:
        print(f"[오류] {e}", flush=True)
        return "error", 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
