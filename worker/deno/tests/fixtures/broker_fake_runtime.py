#!/usr/bin/env python3
"""A local process fixture, not Docker or network-isolation evidence."""
import json
import os
from pathlib import Path
import signal
import sys
import time

root = Path(__file__).parent
args = sys.argv[1:]
(root / "calls.log").open("a").write(json.dumps(args) + "\n")

def option(flag):
    return args[args.index(flag) + 1]

def file_for(name):
    return root / (name + ".container")

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False

if args[:2] == ["volume", "ls"]:
    if (root / "volume.label").exists():
        print("fixture-owned-socket")
elif args[:2] == ["volume", "create"]:
    (root / "volume.label").write_text(option("--label").split("=", 1)[1])
elif args[:2] == ["volume", "inspect"]:
    print((root / "volume.label").read_text())
elif args[:2] == ["volume", "rm"]:
    (root / "volume.label").unlink()
elif args[0] == "run":
    name = option("--name")
    path = file_for(name)
    if path.exists():
        sys.exit(125)
    path.write_text(json.dumps({"pid": os.getpid(), "owner": option("--label").split("=", 1)[1]}))
    signal.signal(signal.SIGTERM, lambda _s, _f: sys.exit(0))
    try:
        if name.endswith("-init"):
            sys.exit(0)
        if name.endswith("-broker"):
            while True:
                time.sleep(0.01)
        print("synthetic attached worker stream", flush=True)
        sys.exit(7)
    finally:
        if not (name == "fixture-worker" and (root / "keep-stopped-worker").exists()):
            path.unlink(missing_ok=True)
elif args[0] == "exec":
    path = file_for(args[1])
    sys.exit(0 if path.exists() and alive(json.loads(path.read_text())["pid"]) else 1)
elif args[0] == "ps":
    records = []
    for path in root.glob("*.container"):
        data = json.loads(path.read_text())
        if alive(data["pid"]) or "--all" in args:
            records.append({"Names": path.stem, "ID": path.stem, "State": "running"})
    print(json.dumps(records))
elif args[0] == "inspect":
    path = file_for(args[-1])
    if not path.exists():
        sys.exit(1)
    print(json.loads(path.read_text())["owner"])
elif args[0] in ("stop", "kill"):
    path = file_for(args[-1])
    if not path.exists():
        sys.exit(1)
    try:
        os.kill(json.loads(path.read_text())["pid"], signal.SIGTERM)
    except ProcessLookupError:
        sys.exit(1)
elif args[0] == "rm":
    path = file_for(args[-1])
    if path.exists() and alive(json.loads(path.read_text())["pid"]):
        sys.exit(1)
    path.unlink(missing_ok=True)
else:
    sys.exit(2)
