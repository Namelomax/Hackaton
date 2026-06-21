#!/usr/bin/env python3
"""
Запускает Ollama + HTTP-прокси на :11435 в одном процессе.

Использование:
  python3 ollama_server.py               # обычный запуск
  nohup python3 ollama_server.py &       # фоновый (переживёт закрытие терминала)

Логи Ollama → /tmp/ollama.log
Логи прокси → stdout (перенаправляй при необходимости)

Для автозапуска после перезагрузки добавь в crontab:
  @reboot python3 /path/to/ollama_server.py >> /tmp/ollama_proxy.log 2>&1
"""

import subprocess
import threading
import signal
import sys
import time
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.request
import urllib.error

# ── Настройки ──────────────────────────────────────────────────────────────────
OLLAMA_BASE   = "http://127.0.0.1:11434"
PROXY_PORT    = 11435
MODEL         = os.environ.get("OLLAMA_MODEL", "gemma4:31b")
WATCHDOG_SEC  = 30          # как часто проверять, жива ли Ollama
OLLAMA_LOG    = "/tmp/ollama.log"

def _find_ollama() -> str:
    """Ищет бинарь ollama: сначала в PATH, потом в типичных venv-местах."""
    import shutil
    found = shutil.which("ollama")
    if found:
        return found
    candidates = [
        os.path.expanduser("~/venv/bin/ollama"),
        os.path.expanduser("~/.local/bin/ollama"),
        os.path.expanduser("~/ollama"),
        "/usr/local/bin/ollama",
        "/usr/bin/ollama",
    ]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    raise FileNotFoundError(
        "ollama не найден. Укажи путь вручную: OLLAMA_BIN=/path/to/ollama python3 ollama_server.py"
    )

OLLAMA_BIN = os.environ.get("OLLAMA_BIN") or _find_ollama()
print(f"[ollama] bin={OLLAMA_BIN}", flush=True)

# Заголовки, которые JupyterHub добавляет сам и которые Ollama не понимает
STRIP_HEADERS = {"x-real-ip", "x-forwarded-for", "authorization", "host"}

# ── Прокси-обработчик ──────────────────────────────────────────────────────────
class ProxyHandler(BaseHTTPRequestHandler):
    def do_request(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        hdrs = {k: v for k, v in self.headers.items()
                if k.lower() not in STRIP_HEADERS}
        req = urllib.request.Request(
            f"{OLLAMA_BASE}{self.path}",
            data=body, headers=hdrs, method=self.command,
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() != "transfer-encoding":
                        self.send_header(k, v)
                self.end_headers()
                self.wfile.write(r.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            print(f"[proxy] error: {e}", flush=True)
            try:
                self.send_response(502)
                self.end_headers()
            except Exception:
                pass

    def log_message(self, fmt, *args):
        print(f"[proxy] {self.address_string()} - {fmt % args}", flush=True)

    do_GET = do_POST = do_PUT = do_DELETE = do_OPTIONS = do_PATCH = do_request


# ── Ollama helpers ─────────────────────────────────────────────────────────────
def ollama_alive():
    try:
        urllib.request.urlopen(f"{OLLAMA_BASE}/api/tags", timeout=2)
        return True
    except Exception:
        return False


def start_ollama():
    log = open(OLLAMA_LOG, "a")
    env = os.environ.copy()
    env.setdefault("OLLAMA_DEBUG", "1")
    env.setdefault("OLLAMA_NUM_CTX", "131072")
    proc = subprocess.Popen(
        [OLLAMA_BIN, "serve"],
        stdout=log, stderr=log,
        env=env,
    )
    print(f"[ollama] started  PID={proc.pid}  log={OLLAMA_LOG}", flush=True)
    return proc


def wait_ollama(timeout=90):
    for i in range(timeout):
        if ollama_alive():
            print("[ollama] ready", flush=True)
            return True
        time.sleep(1)
        if i % 15 == 14:
            print(f"[ollama] waiting... {i+1}s", flush=True)
    return False


def pull_model():
    print(f"[ollama] pulling {MODEL} ...", flush=True)
    try:
        subprocess.run([OLLAMA_BIN, "pull", MODEL], check=True, timeout=900)
        print(f"[ollama] model {MODEL} ready", flush=True)
    except subprocess.CalledProcessError as e:
        print(f"[ollama] pull failed: {e}", flush=True)
    except subprocess.TimeoutExpired:
        print("[ollama] pull timeout — model may still be downloading", flush=True)


# ── Watchdog: перезапускает Ollama если упала ──────────────────────────────────
def watchdog(proc_ref: list, interval: int = WATCHDOG_SEC):
    while True:
        time.sleep(interval)
        if not ollama_alive():
            print("[watchdog] Ollama не отвечает — перезапуск...", flush=True)
            try:
                proc_ref[0].terminate()
            except Exception:
                pass
            proc_ref[0] = start_ollama()
            if wait_ollama(60):
                print("[watchdog] Ollama восстановлена", flush=True)
            else:
                print("[watchdog] Ollama не поднялась", flush=True)


# ── Точка входа ───────────────────────────────────────────────────────────────
def main():
    proc_ref = [None]

    if ollama_alive():
        print("[ollama] уже запущена, пропускаем запуск", flush=True)
    else:
        proc_ref[0] = start_ollama()
        if not wait_ollama(90):
            print("[ollama] ERROR: не поднялась за 90 секунд", flush=True)
            sys.exit(1)

    pull_model()

    if proc_ref[0] is not None:
        t = threading.Thread(target=watchdog, args=(proc_ref,), daemon=True)
        t.start()

    server = HTTPServer(("127.0.0.1", PROXY_PORT), ProxyHandler)
    print(f"[proxy] listening on 127.0.0.1:{PROXY_PORT} → {OLLAMA_BASE}", flush=True)

    def shutdown(sig, frame):
        print("\n[main] получен сигнал завершения, останавливаемся...", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()
        if proc_ref[0]:
            proc_ref[0].terminate()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    server.serve_forever()


if __name__ == "__main__":
    main()
