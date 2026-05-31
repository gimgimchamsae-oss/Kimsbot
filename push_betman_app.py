#!/usr/bin/env python3
# 45에서 export_betman_app.py 실행 → JSON을 104(sharpsignal.cloud)로 푸시.
# 픽창고 기존 betman 파이프라인과 완전 무관 (별도 워크플로).
import os, io, paramiko
KEY = paramiko.Ed25519Key.from_private_key(io.StringIO(os.environ["SSH_KEY"]))
USER = "root"
SRC_HOST = "45.32.250.51"
DST_HOST = "sharpsignal.cloud"
REMOTE = "/tmp/betman_app_games.json"
DEST   = "/app/kimkimbot/betman_app_games.json"

def ssh(host):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=USER, pkey=KEY, timeout=20)
    return c

c1 = ssh(SRC_HOST)
_, out, err = c1.exec_command("cd /app/kimkimbot && ./venv/bin/python3 export_betman_app.py", timeout=120)
print("[45 export]", out.read().decode("utf-8", "replace").strip(), err.read().decode("utf-8", "replace").strip())
sftp1 = c1.open_sftp()
with sftp1.open(REMOTE, "r") as f:
    data = f.read()
sftp1.close(); c1.close()
print("[45] json bytes:", len(data))

c2 = ssh(DST_HOST)
sftp2 = c2.open_sftp()
with sftp2.open(DEST, "w") as f:
    f.write(data)
sftp2.close(); c2.close()
print("[104] uploaded:", len(data), "bytes")
