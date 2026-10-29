"""One-time Firebase setup with the service-account key (safe to re-run).

1. Reads the web app config and writes docs/config.js (the config is public by design).
2. Adds the GitHub Pages domain to Authentication > Authorized domains.
3. Deploys firestore.rules.
"""
import json
import sys
from pathlib import Path

from google.auth.transport.requests import AuthorizedSession

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dispatch import get_credentials, PROJECT  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PAGES_DOMAIN = "joeyhr-cpu.github.io"


def ok(r, what):
    if r.status_code >= 300:
        sys.exit(f"{what}: HTTP {r.status_code} {r.text[:400]}")
    return r.json() if r.text else {}


def main():
    project = PROJECT
    s = AuthorizedSession(get_credentials())

    apps = ok(s.get(f"https://firebase.googleapis.com/v1beta1/projects/{project}/webApps"), "list web apps").get("apps", [])
    if not apps:
        sys.exit("no web app registered")
    cfg = ok(s.get(f"https://firebase.googleapis.com/v1beta1/{apps[0]['name']}/config"), "web config")
    web = {k: cfg[k] for k in ("apiKey", "authDomain", "projectId", "appId", "storageBucket", "messagingSenderId") if k in cfg}
    js = ROOT / "docs" / "config.js"
    js.write_text("// Firebase web config: public by design (security is enforced by firestore.rules, not by hiding this).\n"
                  f"window.FIREBASE_CONFIG = {json.dumps(web, indent=2)};\n"
                  'window.APP_NAME = "TTL Dispatch";\nwindow.APP_BRAND = "TTL";\n', encoding="utf-8")
    print(f"wrote {js} for project {web['projectId']}")

    url = f"https://identitytoolkit.googleapis.com/admin/v2/projects/{project}/config"
    conf = ok(s.get(url), "auth config")
    domains = conf.get("authorizedDomains", [])
    if PAGES_DOMAIN not in domains:
        ok(s.patch(url, params={"updateMask": "authorizedDomains"}, json={"authorizedDomains": domains + [PAGES_DOMAIN]}), "add domain")
        print(f"authorized domain added: {PAGES_DOMAIN}")
    else:
        print("authorized domain already present")

    rules = (ROOT / "firestore.rules").read_text(encoding="utf-8")
    rs = ok(s.post(f"https://firebaserules.googleapis.com/v1/projects/{project}/rulesets",
                   json={"source": {"files": [{"name": "firestore.rules", "content": rules}]}}), "create ruleset")
    rel = f"projects/{project}/releases/cloud.firestore"
    r = s.patch(f"https://firebaserules.googleapis.com/v1/{rel}", json={"release": {"name": rel, "rulesetName": rs["name"]}})
    if r.status_code == 404:
        r = s.post(f"https://firebaserules.googleapis.com/v1/projects/{project}/releases", json={"name": rel, "rulesetName": rs["name"]})
    ok(r, "release rules")
    print(f"firestore rules deployed ({rs['name'].rsplit('/', 1)[-1]})")


if __name__ == "__main__":
    main()
