"""TTL Dispatch data tool: Claude's script interface to the web app's Firestore data.

The app (docs/) and this tool read and write the same Firestore collections:
trucks (doc id = unit), drivers (D-###), deals (S-####), users (uid), activity,
config/fees, config/meta, and the public ads copy public_trucks + public_config/site.
Credentials: OAuth consent by Joey (`dispatch.py login`, once), token in tools/dispatch-oauth-token.json.
The taylorfreight.com org blocks service-account keys, so there is no key file. Never commit either file.
Set DISPATCH_DATA_DIR to run against local JSON files instead (testing).

Examples:
  dispatch.py list trucks [--filter fleet=TTL] [--full]
  dispatch.py get deals S-1001
  dispatch.py upsert trucks --file trucks.json      (object or list; merged by unit / id)
  dispatch.py upsert fees --file fees.json
  dispatch.py note S-1001 "Driver asked to move payment to Friday"
  dispatch.py task S-1001 "Collect installment #3" --due 2026-10-30
  dispatch.py done S-1001 T-3
  dispatch.py stage S-1001 downpayment
  dispatch.py pay S-1001 --amount 650 --date 2026-10-28 --method zelle --weeks 1
  dispatch.py delete trucks 6501 --yes
  dispatch.py user joey@x.com --role admin --name Joey     (profile for an existing login)
  dispatch.py miles [--dry-run]           (odometers from Datatruck -> trucks.miles)
  dispatch.py publish                     (refresh public ads collection)
  dispatch.py validate
  dispatch.py backup                      (all collections -> backups/YYYY-MM-DD.json)
  dispatch.py restore backups/2026-10-29.json --yes
  dispatch.py check [--telegram]          (daily: miles, publish, backup, health report)

On Windows PowerShell pass JSON with --file (or pipe it: $json | dispatch.py upsert trucks --file -);
inline --json loses its quotes there.
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = Path(r"C:\Users\Joey\claude\tools")
PROJECT = "ttl-dispatch"
# OAuth desktop client (from the ttl-dispatch Google Cloud project) and the token Joey's consent produces.
# Both are secrets: they live in tools/, never in the repo.
OAUTH_CLIENT = TOOLS / "dispatch-oauth-client.json"
OAUTH_TOKEN = TOOLS / "dispatch-oauth-token.json"
SCOPES = ["https://www.googleapis.com/auth/datastore", "https://www.googleapis.com/auth/firebase",
          "https://www.googleapis.com/auth/identitytoolkit"]
BACKUPS = ROOT / "backups"
TG = TOOLS / "tg.cmd"
SITE_URL = "https://joeyhr-cpu.github.io/ttl-dispatch/"

COLLECTIONS = {"trucks": "unit", "drivers": "id", "deals": "id", "users": "id"}
PREFIX = {"drivers": ("D-", 101), "deals": ("S-", 1001)}
STAGES = ["working", "assigned", "agreement", "downpayment", "ready", "active"]
SOLD_STATUSES = ["Active", "Reserved", "Accident", "Returned", "Paid off"]
FLEETS = ["TTL", "DT", "VKL", "G7"]
PLANS = ["standard", "split", "warranty"]
PUBLIC_TRUCK_FIELDS = ["unit", "year", "make", "model", "miles", "weekly", "term_weeks", "price_total", "apu", "warranty", "engine", "trans", "photos", "gallery_url"]
DEFAULT_FEES = {"dispatch": 15, "mile": 0.09, "admin": 300, "trailer": 250, "ins": 500, "oci": 50, "esc": 2500, "payout": 85, "commission": 1000, "contact_phone": ""}
CHECK_STALE_DAYS = 2


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def today():
    return dt.date.today().isoformat()


# ---------------------------------------------------------------- backends
def get_credentials():
    """OAuth user credentials from `dispatch.py login` (the org blocks service-account keys)."""
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    if not OAUTH_TOKEN.exists():
        sys.exit(f"not logged in: run `dispatch.py login` (needs {OAUTH_CLIENT.name}, see README)")
    creds = Credentials.from_authorized_user_file(str(OAUTH_TOKEN), SCOPES)
    if not creds.valid:
        creds.refresh(Request())
        OAUTH_TOKEN.write_text(creds.to_json(), encoding="utf-8")
    return creds


class IdentityToolkit:
    """The two Firebase Auth admin calls `user` needs, over REST with the OAuth credentials."""
    class UserNotFoundError(Exception):
        pass

    def __init__(self, creds):
        from google.auth.transport.requests import AuthorizedSession
        self.s = AuthorizedSession(creds)
        self.base = f"https://identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts"

    def get_user_by_email(self, email):
        r = self.s.post(self.base + ":lookup", json={"email": [email]})
        r.raise_for_status()
        users = r.json().get("users") or []
        if not users:
            raise self.UserNotFoundError(email)
        return type("U", (), {"uid": users[0]["localId"]})

    def update_user(self, uid, disabled):
        self.s.post(self.base + ":update", json={"localId": uid, "disableUser": disabled}).raise_for_status()


class FirestoreStore:
    def __init__(self):
        from google.cloud import firestore
        creds = get_credentials()
        self.db = firestore.Client(project=PROJECT, credentials=creds)
        self.auth = IdentityToolkit(creds)

    def all(self, coll):
        return [d.to_dict() | ({"id": d.id} if coll == "users" else {}) for d in self.db.collection(coll).stream()]

    def get(self, coll, key):
        d = self.db.collection(coll).document(str(key)).get()
        return d.to_dict() if d.exists else None

    def put(self, coll, key, doc, merge=True):
        self.db.collection(coll).document(str(key)).set(doc, merge=merge)

    def remove(self, coll, key):
        self.db.collection(coll).document(str(key)).delete()

    def activity(self, limit=200):
        from google.cloud import firestore
        q = self.db.collection("activity").order_by("ts", direction=firestore.Query.DESCENDING).limit(limit)
        return [d.to_dict() for d in q.stream()]

    def log(self, what, who="Claude"):
        self.db.collection("activity").add({"ts": now_iso(), "who": who, "what": what})


class JsonStore:
    """Same interface over a folder of JSON files (DISPATCH_DATA_DIR) for offline tests."""
    def __init__(self, folder):
        self.dir = Path(folder)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.auth = None

    def _file(self, coll):
        return self.dir / f"{coll}.json"

    def _load(self, coll):
        p = self._file(coll)
        return json.loads(p.read_text(encoding="utf-8-sig")) if p.exists() else ({} if coll in ("config", "public_config") else [])

    def _save(self, coll, obj):
        self._file(coll).write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")

    def all(self, coll):
        if coll in ("public_trucks",):
            return list(self._load(coll))
        return self._load(coll)

    def get(self, coll, key):
        if coll in ("config", "public_config"):
            return self._load(coll).get(key)
        f = COLLECTIONS.get(coll, "unit")
        return next((x for x in self._load(coll) if str(x.get(f)) == str(key)), None)

    def put(self, coll, key, doc, merge=True):
        if coll in ("config", "public_config"):
            c = self._load(coll)
            c[key] = {**c.get(key, {}), **doc} if merge else doc
            return self._save(coll, c)
        f = COLLECTIONS.get(coll, "unit")
        items = self._load(coll)
        cur = next((x for x in items if str(x.get(f)) == str(key)), None)
        if cur and merge:
            cur.update(doc)
        else:
            if cur:
                items.remove(cur)
            items.append(doc)
        self._save(coll, items)

    def remove(self, coll, key):
        f = COLLECTIONS.get(coll, "unit")
        self._save(coll, [x for x in self._load(coll) if str(x.get(f)) != str(key)])

    def activity(self, limit=200):
        return self._load("activity")[:limit]

    def log(self, what, who="Claude"):
        a = self._load("activity")
        a.insert(0, {"ts": now_iso(), "who": who, "what": what})
        self._save("activity", a[:500])


_store = None


def store():
    global _store
    if _store is None:
        _store = JsonStore(os.environ["DISPATCH_DATA_DIR"]) if os.environ.get("DISPATCH_DATA_DIR") else FirestoreStore()
    return _store


def fees():
    return {**DEFAULT_FEES, **(store().get("config", "fees") or {})}


# ---------------------------------------------------------------- helpers
def next_id(items, prefix, start):
    nums = [int(str(x.get("id", ""))[len(prefix):]) for x in items
            if str(x.get("id", "")).startswith(prefix) and str(x.get("id", ""))[len(prefix):].isdigit()]
    return f"{prefix}{max(nums, default=start - 1) + 1}"


def norm_unit(u):
    return int(u) if str(u).isdigit() else u


def deal_label(d, drivers=None):
    drivers = drivers if drivers is not None else store().all("drivers")
    name = next((x.get("name") for x in drivers if x.get("id") == d.get("driver_id")), d.get("driver_id"))
    unit = f" — <b>Unit {d['unit']}</b>" if d.get("unit") not in (None, "") else ""
    return f"<b>{name}</b>{unit}"


def get_deal(key):
    d = store().get("deals", key)
    if not d:
        sys.exit(f"deal not found: {key}")
    return d


def save_deal(d, what):
    d["updated"] = now_iso()
    store().put("deals", d["id"], d, merge=False)
    store().log(what)


def truck_status(t, deals):
    u = str(t.get("unit"))
    mine = [d for d in deals if str(d.get("unit")) == u]
    if any(d.get("sold") and (d["sold"].get("status") or "Active") != "Returned" for d in mine) or t.get("status") == "sold":
        return "sold"
    if any(d.get("stage") == "active" for d in mine):
        return "sold"
    if any(d.get("stage") != "working" and not d.get("sold") for d in mine):
        return "pipeline"
    if t.get("status") == "on_hold":
        return "hold"
    return "available"


def read_payload(a):
    # Windows PowerShell 5 strips quotes from native-exe args, so prefer --file (or --file - for stdin)
    if a.json:
        return a.json
    if a.file == "-":
        return sys.stdin.buffer.read().decode("utf-8-sig")
    return Path(a.file).read_text(encoding="utf-8-sig")


# ---------------------------------------------------------------- commands
def cmd_list(a):
    if a.coll == "activity":
        for x in store().activity(50):
            print(f"{x['ts'][:16]}  {x['who']}: {re.sub('<[^>]+>', '', x['what'])}")
        return
    if a.coll in ("fees", "meta"):
        print(json.dumps(fees() if a.coll == "fees" else store().get("config", "meta"), indent=2))
        return
    items = store().all(a.coll)
    for f in a.filter or []:
        k, _, v = f.partition("=")
        items = [x for x in items if str(x.get(k, "")).lower() == v.lower()]
    for x in sorted(items, key=lambda x: str(x.get(COLLECTIONS[a.coll]))):
        if a.full:
            print(json.dumps(x, ensure_ascii=False, default=str))
        else:
            keys = [k for k in ("unit", "id", "name", "email", "role", "driver_id", "stage", "year", "miles", "fleet", "phone", "status") if k in x]
            print("  ".join(f"{k}={x[k]}" for k in keys))
    print(f"-- {len(items)} {a.coll}", file=sys.stderr)


def cmd_get(a):
    rec = store().get(a.coll, a.key)
    if not rec:
        sys.exit(f"not found: {a.coll} {a.key}")
    print(json.dumps(rec, indent=2, ensure_ascii=False, default=str))


def cmd_upsert(a):
    payload = json.loads(read_payload(a))
    if a.coll == "fees":
        store().put("config", "fees", payload)
        if "contact_phone" in payload:
            store().put("public_config", "site", {"contact_phone": payload["contact_phone"]})
        store().log("updated fees & terms")
        print("fees updated")
        return
    recs = payload if isinstance(payload, list) else [payload]
    field = COLLECTIONS[a.coll]
    items = store().all(a.coll)
    drivers = store().all("drivers") if a.coll == "deals" else None
    for rec in recs:
        if a.coll == "trucks":
            if rec.get("unit") in (None, ""):
                sys.exit("trucks need 'unit'")
            rec["unit"] = norm_unit(rec["unit"])
        key = rec.get(field)
        cur = next((x for x in items if str(x.get(field)) == str(key)), None) if key is not None else None
        rec["updated"] = now_iso()
        if cur:
            store().put(a.coll, key, rec)
            what = f"updated <b>Unit {key}</b>" if a.coll == "trucks" else f"updated {a.coll[:-1]} {deal_label({**cur, **rec}, drivers) if a.coll == 'deals' else '<b>' + str(cur.get('name', key)) + '</b>'}"
            print(f"updated {a.coll} {key}")
        else:
            if key is None:
                if a.coll not in PREFIX:
                    sys.exit(f"{a.coll} need '{field}'")
                key = rec["id"] = next_id(items, *PREFIX[a.coll])
            rec.setdefault("created", now_iso())
            if a.coll == "deals":
                rec.setdefault("stage", "active" if rec.get("sold") else "working")
                rec.setdefault("notes", [])
                rec.setdefault("tasks", [])
            store().put(a.coll, key, rec, merge=False)
            items.append(rec)
            what = f"added <b>Unit {key}</b>" if a.coll == "trucks" else f"added {a.coll[:-1]} {deal_label(rec, drivers) if a.coll == 'deals' else '<b>' + str(rec.get('name', key)) + '</b>'}"
            print(f"added {a.coll} {key}")
        store().log(what)
    if a.coll in ("trucks", "deals"):
        publish(quiet=True)
    problems = validate(quiet=True)
    if problems:
        print("WARNING validation:\n  " + "\n  ".join(problems))


def cmd_delete(a):
    if not a.yes:
        sys.exit("refusing to delete without --yes")
    rec = store().get(a.coll, a.key)
    if not rec:
        sys.exit(f"not found: {a.coll} {a.key}")
    store().remove(a.coll, a.key)
    store().log(f"removed {a.coll[:-1]} <b>{rec.get('name') or a.key}</b>")
    if a.coll in ("trucks", "deals"):
        publish(quiet=True)
    print(f"deleted {a.coll} {a.key}")


def cmd_note(a):
    d = get_deal(a.deal)
    d.setdefault("notes", []).append({"ts": now_iso(), "who": a.who, "body": a.text})
    save_deal(d, f"logged note on {deal_label(d)}")
    print("note added")


def cmd_task(a):
    d = get_deal(a.deal)
    tasks = d.setdefault("tasks", [])
    tid = next_id(tasks, "T-", 1)
    tasks.append({"id": tid, "body": a.text, "due": a.due or today(), "done": False, "kind": a.kind})
    save_deal(d, f"added follow-up on {deal_label(d)}: {a.text}")
    print(f"task {tid} added")


def cmd_done(a):
    d = get_deal(a.deal)
    t = next((x for x in d.get("tasks", []) if x["id"] == a.task), None)
    if not t:
        sys.exit("task not found")
    t.update(done=True, done_at=now_iso())
    save_deal(d, f"closed follow-up on {deal_label(d)}: {t['body']}")
    print("done")


def cmd_pay(a):
    d = get_deal(a.deal)
    sold = d.setdefault("sold", {})
    sold.setdefault("payments", []).append({"date": a.date or today(), "amount": a.amount, "method": a.method, "note": a.note or ""})
    sold["weeks_paid"] = (sold.get("weeks_paid") or 0) + a.weeks
    save_deal(d, f"recorded payment ${a.amount:,.0f} on {deal_label(d)}")
    print("payment recorded")


def cmd_stage(a):
    if a.stage not in STAGES:
        sys.exit(f"stage must be one of {STAGES}")
    d = get_deal(a.deal)
    d["stage"] = a.stage
    if a.stage == "active":
        d.setdefault("activated", now_iso())
    save_deal(d, f"moved {deal_label(d)} to {a.stage}")
    publish(quiet=True)
    print("stage set")


def cmd_user(a):
    """Create/update the app profile for a login. Logins themselves are made in the app (Invite user) or Firebase console."""
    s = store()
    if not s.auth:
        sys.exit("user needs Firestore")
    try:
        u = s.auth.get_user_by_email(a.email)
    except s.auth.UserNotFoundError:
        sys.exit(f"no login for {a.email}: create it in Firebase console > Authentication > Add user, or Invite user in the app")
    prof = {"id": u.uid, "email": a.email, "active": not a.disable}
    if a.name:
        prof["name"] = a.name
    if a.role:
        prof["role"] = a.role
    cur = s.get("users", u.uid) or {}
    prof.setdefault("name", cur.get("name") or a.email.split("@")[0])
    prof.setdefault("role", cur.get("role") or "sales")
    prof["is_sales"] = cur.get("is_sales", True) if a.sales is None else a.sales == "yes"
    s.put("users", u.uid, prof)
    if a.disable:
        s.auth.update_user(u.uid, disabled=True)
    s.log(f"set user <b>{prof['name']}</b> ({prof['role']}{', disabled' if a.disable else ''})")
    print(f"user {a.email}: {prof}")


# ---------------------------------------------------------------- public ads + mileage
def publish(quiet=False):
    """public_trucks = for-sale trucks, whitelisted fields only (the ads page reads this)."""
    s = store()
    deals = s.all("deals")
    want = {str(t["unit"]): {k: t[k] for k in PUBLIC_TRUCK_FIELDS if t.get(k) is not None}
            for t in s.all("trucks") if truck_status(t, deals) == "available"}
    have = {str(x.get("unit")) for x in s.all("public_trucks")}
    for u in have - set(want):
        s.remove("public_trucks", u)
    for u, doc in want.items():
        s.put("public_trucks", u, doc, merge=False)
    s.put("public_config", "site", {"contact_phone": fees().get("contact_phone", "")})
    if not quiet:
        print(f"public ads: {len(want)} trucks ({len(have - set(want))} removed)")
    return len(want)


def datatruck_odometers():
    sys.path.insert(0, str(TOOLS / "datatruck"))
    import dt as dtmod
    c = dtmod.Datatruck()
    out, page = {}, 1
    while True:
        r = c.call("GET", "/v2/truck/truck/", page=page, page_size=200)
        for t in r["results"]:
            u = str(t.get("unit_number") or "").strip().rstrip(".").lstrip("0")
            if u and t.get("odometer") is not None:
                out.setdefault(u, (t["odometer"], t.get("status")))
        if not r.get("next"):
            return out
        page += 1


def sync_miles(dry=False):
    s = store()
    odo = datatruck_odometers()
    changed, missing = [], []
    for t in s.all("trucks"):
        u = str(t["unit"]).lstrip("0")
        if u not in odo:
            missing.append(u)
            continue
        miles = round(odo[u][0])
        if miles != t.get("miles"):
            changed.append((u, t.get("miles"), miles))
            if not dry:
                s.put("trucks", u, {"miles": miles, "miles_synced": now_iso()})
    if changed and not dry:
        s.log(f"synced mileage from Datatruck for {len(changed)} truck(s)")
    if not dry:
        s.put("config", "meta", {"miles_synced_at": now_iso()})
    return changed, missing


def cmd_miles(a):
    changed, missing = sync_miles(a.dry_run)
    for u, old, new in changed:
        print(f"Unit {u}: {old} -> {new}")
    print(f"{len(changed)} changed{' (dry run)' if a.dry_run else ''}; not in Datatruck: {', '.join(missing) or 'none'}")
    if changed and not a.dry_run:
        publish(quiet=True)


def cmd_publish(a):
    publish()


# ---------------------------------------------------------------- photos (truck gallery site)
GALLERY = "https://truck-gallery-a56f2b.netlify.app"
MAX_PHOTOS = 12


def _get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ttl-dispatch"}), timeout=60) as r:
        return json.loads(r.read())


def gallery_index():
    """{unit (no leading zeros): gallery truck}, plus {vin: truck}."""
    by_unit, by_vin = {}, {}
    for t in _get_json(f"{GALLERY}/api/trucks"):
        if t.get("unit"):
            by_unit[str(t["unit"]).lstrip("0") or "0"] = t
        if t.get("vin"):
            by_vin[t["vin"].upper()] = t
    return by_unit, by_vin


def gallery_photos(key):
    d = _get_json(f"{GALLERY}/api/trucks/{urllib.parse.quote(key, safe='')}")
    photos = sorted(d.get("photos", []), key=lambda p: p.get("takenAt") or "")
    return [f"{GALLERY}/api/img/{p['id']}" for p in photos[:MAX_PHOTOS]], f"{GALLERY}/t/{urllib.parse.quote(key, safe='')}"


def gallery_match(t, by_unit, by_vin):
    vin = str(t.get("vin") or "").upper()
    return by_vin.get(vin) if vin in by_vin else by_unit.get(str(t.get("unit")).lstrip("0"))


def sync_photos(dry=False):
    """Fill photos + gallery_url for trucks the gallery knows (by VIN, else unit). Returns units updated."""
    s = store()
    by_unit, by_vin = gallery_index()
    changed = []
    for t in s.all("trucks"):
        g = gallery_match(t, by_unit, by_vin)
        if not g:
            continue
        if t.get("photos_count") == g.get("count") and t.get("gallery_url"):
            continue
        urls, link = gallery_photos(g["key"])
        changed.append(str(t["unit"]))
        if not dry:
            s.put("trucks", t["unit"], {"photos": urls, "gallery_url": link, "photos_count": g.get("count")})
    if changed and not dry:
        s.log(f"updated photos from the truck gallery for {len(changed)} truck(s)")
    return changed


def cmd_photos(a):
    ch = sync_photos(a.dry_run)
    print(f"{len(ch)} truck(s) {'would get' if a.dry_run else 'got'} photos: {', '.join(ch) or 'none'}")
    if ch and not a.dry_run:
        publish(quiet=True)


# ---------------------------------------------------------------- validation
def validate(quiet=False):
    s = store()
    p = []
    trucks, drivers, deals, users = (s.all(c) for c in ("trucks", "drivers", "deals", "users"))
    units = [str(t.get("unit")) for t in trucks]
    dids = {x["id"] for x in drivers}
    uids = {x["id"] for x in users}
    for t in trucks:
        vin = str(t.get("vin") or "")
        if vin and len(vin) != 17:
            p.append(f"Unit {t.get('unit')}: VIN '{vin}' is not 17 characters")
        if t.get("salesman") and t["salesman"] not in uids:
            p.append(f"Unit {t.get('unit')}: unknown salesman {t['salesman']}")
    for x in drivers:
        if x.get("fleet") and x["fleet"] not in FLEETS:
            p.append(f"{x['id']}: fleet '{x['fleet']}' not in {FLEETS}")
    names = [str(x.get("name", "")).strip().lower() for x in drivers]
    p += [f"possible duplicate driver '{n}'" for n in sorted({n for n in names if n and names.count(n) > 1})]
    for d in deals:
        tag = d.get("id")
        if d.get("stage") not in STAGES:
            p.append(f"{tag}: bad stage {d.get('stage')}")
        if d.get("driver_id") not in dids:
            p.append(f"{tag}: driver {d.get('driver_id')} not in drivers")
        if d.get("unit") not in (None, "") and str(d["unit"]) not in units:
            p.append(f"{tag}: Unit {d.get('unit')} not in trucks")
        if d.get("plan") and d["plan"] not in PLANS:
            p.append(f"{tag}: plan {d['plan']} not in {PLANS}")
        sold = d.get("sold")
        if sold and sold.get("status") and sold["status"] not in SOLD_STATUSES:
            p.append(f"{tag}: sold status {sold['status']} not in {SOLD_STATUSES}")
    live = [str(d["unit"]) for d in deals if d.get("unit") not in (None, "") and (d.get("sold") or {}).get("status") != "Returned"]
    p += [f"Unit {u} is on more than one open deal" for u in sorted({u for u in live if live.count(u) > 1})]
    if not any(u.get("role") == "admin" and u.get("active") is not False for u in users):
        p.append("no active admin user")
    if not quiet:
        print("\n".join(p) if p else "OK - no problems")
    return p


def cmd_validate(a):
    sys.exit(1 if validate() else 0)


# ---------------------------------------------------------------- backup
def backup():
    s = store()
    b = {c: s.all(c) for c in (*COLLECTIONS, "public_trucks")}
    b["config"] = {"fees": s.get("config", "fees"), "meta": s.get("config", "meta")}
    b["activity"] = s.activity(500)
    BACKUPS.mkdir(exist_ok=True)
    out = BACKUPS / f"{today()}.json"
    out.write_text(json.dumps(b, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    for old in sorted(BACKUPS.glob("*.json"))[:-30]:  # keep 30 days
        old.unlink()
    return out


def cmd_backup(a):
    print(f"backup written: {backup()}")


def cmd_restore(a):
    if not a.yes:
        sys.exit("restore overwrites every record in the backup - pass --yes")
    b = json.loads(Path(a.file).read_text(encoding="utf-8"))
    s = store()
    for coll, field in COLLECTIONS.items():
        for rec in b.get(coll, []):
            s.put(coll, rec[field], rec, merge=False)
    for k, v in (b.get("config") or {}).items():
        if v:
            s.put("config", k, v, merge=False)
    s.log(f"restored data from backup {Path(a.file).name}")
    publish()
    print("restored")


# ---------------------------------------------------------------- daily check
def http_ok(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Cache-Control": "no-cache"}), timeout=30) as r:
            return r.status == 200, r.read().decode("utf-8", "replace")
    except Exception as e:
        return False, str(e)


def cmd_check(a):
    lines, bad = [], False
    s = store()
    # 1. site + ads page up, and the published page carries no CRM data
    if not a.no_site:
        ok, body = http_ok(SITE_URL)
        lines.append(f"{'OK' if ok else 'FAIL'} app online: {SITE_URL}")
        bad |= not ok
        ok2, _ = http_ok(SITE_URL + "ads.html")
        lines.append(f"{'OK' if ok2 else 'FAIL'} driver ads page online")
        bad |= not ok2
        names = [d.get("name") for d in s.all("drivers") if d.get("name") and len(d["name"]) > 5]
        leaked = [n for n in names if n in body]
        if leaked:
            lines.append(f"FAIL driver names found in public page source: {', '.join(leaked[:3])}")
            bad = True
    # 2. mileage from Datatruck
    try:
        changed, missing = sync_miles()
        lines.append(f"OK mileage synced from Datatruck: {len(changed)} updated" + (f"; not in Datatruck: {', '.join(missing[:10])}" if missing else ""))
        lines += [f"  - Unit {u}: {o if o is not None else '?'} -> {n:,} mi" for u, o, n in changed[:10]]
    except SystemExit as e:
        lines.append(f"FAIL mileage sync: {e}")
        bad = True
    except Exception as e:
        lines.append(f"FAIL mileage sync: {e}")
        bad = True
    # 2b. photos from the truck gallery
    try:
        ch = sync_photos()
        lines.append(f"OK photos synced from the truck gallery: {len(ch)} truck(s) updated")
    except Exception as e:
        lines.append(f"WARN photo sync: {e}")
    # 3. public ads in step with inventory
    n = publish(quiet=True)
    lines.append(f"OK ads page shows {n} for-sale truck(s)")
    # 4. data problems
    problems = validate(quiet=True)
    if problems:
        bad = True
        lines.append(f"FAIL {len(problems)} data problem(s):")
        lines += ["  - " + x for x in problems[:15]]
    else:
        lines.append("OK data validates")
    # 5. backup
    lines.append(f"OK backup {backup().name}")
    lines += ["", "Today:"] + ["  - " + x for x in insights()]
    s.put("config", "meta", {"checked_at": now_iso(), "check_ok": not bad})
    report = f"TTL Dispatch daily check {today()}: {'PROBLEMS' if bad else 'all good'}\n" + "\n".join(lines)
    print(report)
    if a.telegram:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write(report)
        subprocess.run([str(TG), "send", "me", "--text-file", f.name], check=True)
        os.unlink(f.name)
    sys.exit(1 if bad else 0)


def insights():
    s = store()
    deals, drivers, trucks = s.all("deals"), s.all("drivers"), s.all("trucks")
    name = {d["id"]: d.get("name") for d in drivers}
    td = today()
    out = []
    tasks = [(d, t) for d in deals for t in d.get("tasks", []) if not t.get("done")]
    overdue = [(d, t) for d, t in tasks if t.get("due", "9") < td]
    due = [(d, t) for d, t in tasks if t.get("due") == td]
    if overdue:
        out.append(f"{len(overdue)} overdue follow-up(s): " + "; ".join(f"{name.get(d['driver_id'], '?')}: {t['body']}" for d, t in overdue[:5]))
    if due:
        out.append(f"{len(due)} follow-up(s) due today")
    week_ago = (dt.date.today() - dt.timedelta(days=7)).isoformat()
    cold = [d for d in deals if d.get("stage") == "working" and not d.get("sold") and max([n.get("ts", "") for n in d.get("notes", [])] + [d.get("created", "")]) < week_ago]
    if cold:
        out.append(f"{len(cold)} working deal(s) cold 7+ days: " + ", ".join(name.get(d["driver_id"], "?") for d in cold[:5]))
    two_weeks = (dt.date.today() - dt.timedelta(days=14)).isoformat()
    late = [d for d in deals if d.get("sold") and (d["sold"].get("status") or "Active") == "Active"
            and (pays := sorted(p.get("date", "") for p in d["sold"].get("payments", []))) and pays[-1] < two_weeks]
    if late:
        out.append(f"{len(late)} sold truck(s) with no payment in 14+ days: " + ", ".join(f"Unit {d.get('unit')}" for d in late[:8]))
    forsale = [t for t in trucks if truck_status(t, deals) == "available"]
    nophoto = [t for t in forsale if not t.get("photos")]
    if nophoto:
        out.append(f"{len(nophoto)} for-sale truck(s) without photos")
    sold = [d for d in deals if d.get("sold")]
    out.append(f"totals: {len(trucks)} trucks ({len(forsale)} for sale), {len(drivers)} drivers, {len([d for d in deals if not d.get('sold') and d.get('stage') != 'active'])} open deals, {len(sold)} sold")
    return out


def cmd_login(a):
    """One-time: opens Google consent in the browser; Joey clicks Allow; the refresh token is saved to tools/."""
    from google_auth_oauthlib.flow import InstalledAppFlow
    if not OAUTH_CLIENT.exists():
        sys.exit(f"missing {OAUTH_CLIENT} (Google Cloud console > APIs & Services > Credentials > OAuth client, Desktop app)")
    flow = InstalledAppFlow.from_client_secrets_file(str(OAUTH_CLIENT), SCOPES)
    creds = flow.run_local_server(port=0, open_browser=True, access_type="offline", prompt="consent",
                                  login_hint="joey@taylorfreight.com",
                                  success_message="TTL Dispatch tool is connected. You can close this tab.")
    OAUTH_TOKEN.write_text(creds.to_json(), encoding="utf-8")
    print(f"saved {OAUTH_TOKEN.name}")


def cmd_init(a):
    """One-time setup on a new Firebase project: default fees, meta, public config."""
    s = store()
    if not s.get("config", "fees"):
        s.put("config", "fees", DEFAULT_FEES)
    s.put("config", "meta", {"app": "TTL Dispatch", "site_url": SITE_URL, "created": now_iso()})
    s.put("public_config", "site", {"contact_phone": fees().get("contact_phone", ""), "app": "TTL Dispatch"})
    print("initialised config/fees, config/meta, public_config/site")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    colls = list(COLLECTIONS)
    s = sp.add_parser("list"); s.add_argument("coll", choices=colls + ["activity", "fees", "meta"]); s.add_argument("--filter", action="append"); s.add_argument("--full", action="store_true"); s.set_defaults(f=cmd_list)
    s = sp.add_parser("get"); s.add_argument("coll", choices=colls); s.add_argument("key"); s.set_defaults(f=cmd_get)
    s = sp.add_parser("upsert", help="add or merge-update records (JSON object or list)"); s.add_argument("coll", choices=colls + ["fees"])
    g = s.add_mutually_exclusive_group(required=True); g.add_argument("--json"); g.add_argument("--file"); s.set_defaults(f=cmd_upsert)
    s = sp.add_parser("delete"); s.add_argument("coll", choices=colls); s.add_argument("key"); s.add_argument("--yes", action="store_true"); s.set_defaults(f=cmd_delete)
    s = sp.add_parser("note"); s.add_argument("deal"); s.add_argument("text"); s.add_argument("--who", default="Claude"); s.set_defaults(f=cmd_note)
    s = sp.add_parser("task"); s.add_argument("deal"); s.add_argument("text"); s.add_argument("--due"); s.add_argument("--kind", default="general"); s.set_defaults(f=cmd_task)
    s = sp.add_parser("done"); s.add_argument("deal"); s.add_argument("task"); s.set_defaults(f=cmd_done)
    s = sp.add_parser("pay"); s.add_argument("deal"); s.add_argument("--amount", type=float, required=True); s.add_argument("--date"); s.add_argument("--method", default="settlement"); s.add_argument("--note"); s.add_argument("--weeks", type=int, default=1); s.set_defaults(f=cmd_pay)
    s = sp.add_parser("stage"); s.add_argument("deal"); s.add_argument("stage"); s.set_defaults(f=cmd_stage)
    s = sp.add_parser("user"); s.add_argument("email"); s.add_argument("--name"); s.add_argument("--role", choices=["admin", "sales"]); s.add_argument("--sales", choices=["yes", "no"]); s.add_argument("--disable", action="store_true"); s.set_defaults(f=cmd_user)
    s = sp.add_parser("miles"); s.add_argument("--dry-run", action="store_true"); s.set_defaults(f=cmd_miles)
    s = sp.add_parser("publish"); s.set_defaults(f=cmd_publish)
    s = sp.add_parser("photos"); s.add_argument("--dry-run", action="store_true"); s.set_defaults(f=cmd_photos)
    s = sp.add_parser("validate"); s.set_defaults(f=cmd_validate)
    s = sp.add_parser("backup"); s.set_defaults(f=cmd_backup)
    s = sp.add_parser("restore"); s.add_argument("file"); s.add_argument("--yes", action="store_true"); s.set_defaults(f=cmd_restore)
    s = sp.add_parser("check"); s.add_argument("--telegram", action="store_true"); s.add_argument("--no-site", action="store_true"); s.set_defaults(f=cmd_check)
    s = sp.add_parser("init"); s.set_defaults(f=cmd_init)
    s = sp.add_parser("login"); s.set_defaults(f=cmd_login)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
