"""
Render Web Service 진입점
Flask로 HTTP 포트 유지 + 백그라운드 스레드에서 5분마다 monitor.run() 실행
"""

import os
import time
import threading
from flask import Flask
from monitor import run

app = Flask(__name__)


@app.route("/")
def health():
    return "OK", 200


def _loop():
    while True:
        try:
            run()
        except Exception as e:
            print(f"[루프 오류] {e}")
        time.sleep(300)  # 5분


if __name__ == "__main__":
    t = threading.Thread(target=_loop, daemon=True)
    t.start()
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
