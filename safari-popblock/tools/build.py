#!/usr/bin/env python3
"""Generate the network block rules and the userscript.

    python3 tools/build.py

- tools/domains.txt          -> extension/rules/ad_networks.json
- extension/inject.js        -> userscript/popblock.user.js
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"

RESOURCE_TYPES = [
    "main_frame", "sub_frame", "script", "image", "stylesheet", "xmlhttprequest",
    "media", "font", "ping", "websocket", "other",
]

USERSCRIPT_HEADER = """// ==UserScript==
// @name         PopBlock
// @namespace    popblock
// @version      {version}
// @description  Stops pop-ups, pop-unders, tap-jacking redirects, link swapping and notification spam.
// @match        *://*/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==
// Generated from extension/inject.js by tools/build.py - edit that file instead.

"""


def build_rules():
    domains = []
    for line in (ROOT / "tools" / "domains.txt").read_text().splitlines():
        line = line.split("#", 1)[0].strip().lower()
        if line and line not in domains:
            domains.append(line)
    rules = [
        {
            "id": i,
            "priority": 1,
            "action": {"type": "block"},
            "condition": {"urlFilter": f"||{d}^", "resourceTypes": RESOURCE_TYPES},
        }
        for i, d in enumerate(domains, start=1)
    ]
    out = EXT / "rules" / "ad_networks.json"
    out.write_text(json.dumps(rules, indent=1) + "\n")
    print(f"{out.relative_to(ROOT)}: {len(rules)} rules")


def build_userscript():
    version = json.loads((EXT / "manifest.json").read_text())["version"]
    out = ROOT / "userscript" / "popblock.user.js"
    out.write_text(USERSCRIPT_HEADER.format(version=version) + (EXT / "inject.js").read_text())
    print(f"{out.relative_to(ROOT)}: v{version}")


if __name__ == "__main__":
    build_rules()
    build_userscript()
