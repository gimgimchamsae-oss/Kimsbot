import os
import threading
from flask import Flask

app = Flask(__name__)


@app.route("/")
def health():
    return "OK", 200


@app.route("/run", methods=["GET", "POST"])
def trigger():
    def _run():
        try:
            from monitor import run
            run()
        except Exception as e:
            print(f"[오류] {e}", flush=True)

    threading.Thread(target=_run, daemon=True).start()
    return "ok", 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
