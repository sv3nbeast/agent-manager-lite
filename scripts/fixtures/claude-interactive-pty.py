"""Private-PTY driver for smoke-claude-code-interactive.ts; no real Terminal UI."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time


def plain_text(data):
    text = data.decode("utf-8", "replace")
    text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b[()][A-Za-z0-9]|\x1b[=><78]", "", text)
    return re.sub(r"\s+", "", text)


def main():
    config = json.load(sys.stdin)
    result = {"workspaceTrustPrompt": False, "apiKeyApprovalPrompt": False,
              "ready": False, "exitCode": None}
    child, master = pty.fork()
    if child == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        os.chdir(config["project"])
        os.execve(config["command"][0], config["command"], config["environment"])
    output = bytearray()
    deadline = time.monotonic() + 45
    stage, exit_sent_at, status = "trust", None, None
    failure = None

    def interrupted(_signal, _frame):
        raise RuntimeError("interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        with open(config["log"], "wb") as log:
            os.chmod(config["log"], 0o600)
            while time.monotonic() < deadline:
                readable, _, _ = select.select([master], [], [], 0.1)
                if readable:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        chunk = b""
                    if chunk:
                        log.write(chunk)
                        log.flush()
                        output.extend(chunk)
                        if len(output) > 2 * 1024 * 1024:
                            raise RuntimeError("output-limit")
                        text = plain_text(output)
                        if stage == "trust" and "Yes,Itrustthisfolder" in text and "Entertoconfirm" in text:
                            if "❯No,exit" not in text:
                                raise RuntimeError("unexpected-trust-default")
                            result["workspaceTrustPrompt"] = True
                            # Let the first render finish attaching its input
                            # handler, then send navigation and confirmation
                            # as separate terminal events.
                            time.sleep(0.4)
                            os.write(master, b"\x1b[B")
                            time.sleep(0.2)
                            os.write(master, b"\r")
                            stage = "key" if config["mode"] == "api_key" else "input"
                        elif stage == "key" and "DoyouwanttousethisAPIkey?" in text and "No(recommended)" in text:
                            if "❯No(recommended)" not in text:
                                raise RuntimeError("unexpected-key-default")
                            result["apiKeyApprovalPrompt"] = True
                            time.sleep(0.4)
                            os.write(master, b"\x1b[A")
                            time.sleep(0.2)
                            os.write(master, b"\r")
                            stage = "input"
                        elif stage == "input" and "APIUsageBilling" in text and "❯" in text:
                            result["ready"] = True
                            time.sleep(0.3)
                            os.write(master, b"/exit\r")
                            stage, exit_sent_at = "exit", time.monotonic()
                    else:
                        _, status = os.waitpid(child, 0)
                        break
                exited, current_status = os.waitpid(child, os.WNOHANG)
                if exited:
                    status = current_status
                    break
                if exit_sent_at and time.monotonic() - exit_sent_at > 8:
                    raise RuntimeError("exit-timeout")
            if status is None:
                raise RuntimeError("timeout-" + stage)
            result["exitCode"] = os.waitstatus_to_exitcode(status)
            if not result["ready"] or result["exitCode"] != 0:
                raise RuntimeError("interactive-startup-failed")
    except Exception as error:
        failure = str(error) if isinstance(error, RuntimeError) else "pty-driver-failed"
    finally:
        if status is None:
            try:
                os.killpg(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(child, 0)
            except ChildProcessError:
                pass
        os.close(master)
    if failure:
        result["failure"] = failure
    print(json.dumps(result), flush=True)
    return 1 if failure else 0


if __name__ == "__main__":
    sys.exit(main())
