#!/usr/bin/env python3
"""Generate the network block rules and the userscript.

    python3 tools/build.py

- tools/domains.txt          -> extension/rules/ad_networks.json
                                and the AD_DOMAINS list in extension/inject.js
- extension/inject.js        -> userscript/popblock.user.js
"""
import json
import re
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


def read_domains():
    domains = []
    for line in (ROOT / "tools" / "domains.txt").read_text().splitlines():
        line = line.split("#", 1)[0].strip().lower()
        if line and line not in domains:
            domains.append(line)
    return domains


def build_rules(domains):
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


def build_inject_domains(domains):
    path = EXT / "inject.js"
    listing = "".join(f"    {json.dumps(d)},\n" for d in domains)
    src, n = re.subn(
        r"(// BEGIN AD DOMAINS[^\n]*\n).*?(\s*// END AD DOMAINS)",
        lambda m: m.group(1) + "  const AD_DOMAINS = [\n" + listing + "  ];" + m.group(2),
        path.read_text(),
        flags=re.S,
    )
    assert n == 1, "AD DOMAINS markers not found in inject.js"
    path.write_text(src)
    print(f"{path.relative_to(ROOT)}: {len(domains)} ad domains")


def build_userscript():
    version = json.loads((EXT / "manifest.json").read_text())["version"]
    out = ROOT / "userscript" / "popblock.user.js"
    out.write_text(USERSCRIPT_HEADER.format(version=version) + (EXT / "inject.js").read_text())
    print(f"{out.relative_to(ROOT)}: v{version}")


if __name__ == "__main__":
    domains = read_domains()
    build_rules(domains)
    build_inject_domains(domains)
    build_userscript()
