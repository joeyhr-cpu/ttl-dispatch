"""Import Joey's truck sheets into TTL Dispatch (dry run unless --yes).

Sources (read-only):
  - For-sale list:  sheet 1fMbzZOz...  tab "Sheet1"  (Status, No, Year, Miles, Total Price, Weekly term, ..., Weekly amount, Owner name, Got the truck)
  - Sold list:      sheet 1SsHO8Xt...  tab "Copy of Sold Trucks"
Enriched with Datatruck (VIN, make, model, odometer) and the truck gallery (photos).
SSN / EIN columns are never read into the app.
"""
import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, r"C:\Users\Joey\claude\tools\sheets")
import dispatch as D  # noqa: E402

FORSALE = ("1fMbzZOzx4lYNQ8qA6zb40IN6Hg-K4-Zxv6Gaioqh-As", "Sheet1")
SOLD = ("1SsHO8Xt5r_LznY09xqs7wA5947ouLIGXLycaNTq-FkY", "Copy of Sold Trucks")


def money(v):
    v = str(v or "").strip()
    if not v or v.upper() == "TBA":
        return None
    v = v.split("/")[0]  # "$5000/$5000" -> received part
    v = re.sub(r"[^\d.\-]", "", v.replace(" ", ""))
    try:
        return float(v) if v not in ("", "-", ".") else None
    except ValueError:
        return None


def num(v):
    m = money(v)
    return int(m) if m is not None and m == int(m) else m


def months(v):
    m = re.search(r"\d+", str(v or ""))
    return int(m.group()) if m else None


def date(v):
    v = str(v or "").strip()
    for f in ("%m.%d.%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(v, f).date().isoformat()
        except ValueError:
            pass
    return None


def unit_of(v):
    v = str(v or "").strip()
    return int(v) if v.isdigit() else (v or None)


def phone(v):
    d = re.sub(r"\D", "", str(v or ""))
    d = d[1:] if len(d) == 11 and d[0] == "1" else d
    return f"({d[:3]}) {d[3:6]}-{d[6:]}" if len(d) == 10 else (str(v).strip() or None)


def rows(sheet, tab):
    import sheets  # tools/sheets/sheets.py — Joey's Google OAuth
    return sheets.client().open_by_key(sheet).worksheet(tab).get_all_values()


def datatruck():
    sys.path.insert(0, str(D.TOOLS / "datatruck"))
    import dt
    c = dt.Datatruck()
    out, page = {}, 1
    while True:
        r = c.call("GET", "/v2/truck/truck/", page=page, page_size=200)
        for t in r["results"]:
            u = str(t.get("unit_number") or "").strip().rstrip(".").lstrip("0")
            if u and u not in out:
                out[u] = t
        if not r.get("next"):
            return out
        page += 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true")
    a = ap.parse_args()
    warn = []
    dtk = datatruck()
    by_unit, by_vin = D.gallery_index()

    def enrich(t):
        d = dtk.get(str(t["unit"]).lstrip("0"))
        if d:
            vin = (d.get("vin") or "").strip().upper()
            if len(vin) == 17:
                if t.get("vin") and t["vin"] != vin:
                    warn.append(f"Unit {t['unit']}: sheet VIN {t['vin']} != Datatruck {vin} (using Datatruck)")
                t["vin"] = vin
            # Datatruck spells these many ways (Frht, FRHT, CASCADIA...); the fleet is Freightliner Cascadia
            t.setdefault("make", "Freightliner")
            t.setdefault("model", "Cascadia")
            t.setdefault("year", d.get("year"))
        g = D.gallery_match(t, by_unit, by_vin)
        if g:
            t["photos"], t["gallery_url"] = D.gallery_photos(g["key"])
            t["photos_count"] = g.get("count")
        return {k: v for k, v in t.items() if v not in (None, "")}

    # ---- for-sale sheet
    fs = rows(*FORSALE)
    hdr = fs[0]
    col = {h.strip(): i for i, h in enumerate(hdr)}
    got = {}
    trucks = {}
    for r in fs[1:]:
        r += [""] * (len(hdr) - len(r))
        u = unit_of(r[col["No"]])
        if not u:
            continue
        status = r[col["Status"]].strip().lower()
        if status == "sold":
            got[str(u)] = r[col["Got the truck"]].strip().lower()
        trucks[str(u)] = {"unit": u, "year": num(r[col["Year"]]), "miles": num(r[col["Miles as of Sep 2026"]]),
                          "price_total": money(r[col["Total Price"]]), "term_weeks": num(r[col["Weekly term"]]),
                          "weekly": money(r[col["Weekly amount"]]), "sheet_status": status}

    # ---- sold sheet
    sd = rows(*SOLD)
    hi = next(i for i, r in enumerate(sd) if r and r[0].strip() == "Customer name")
    h = [c.strip() for c in sd[hi]]
    c = {name: h.index(name) for name in h if name}
    drivers, deals = {}, []
    for r in sd[hi + 1:]:
        r += [""] * (len(h) - len(r))
        name = r[0].strip()
        u = unit_of(r[c["Unit"]])
        if not name or name == "Total" or not u or str(u).upper() == "TBA":
            if name and name not in ("Total", "Sold trucks") and not name.startswith(("Total", "Downpayment", "Purchase", "Company")):
                warn.append(f"skipped sold row '{name}': no unit yet")
            continue
        ph = phone(r[c["Phone"]])
        key = name.lower().split()
        key = " ".join(key)
        same = drivers.get(key)
        if same and ph and same.get("phone") and same["phone"] != ph:
            key = f"{key}|{ph}"
            warn.append(f"two different phones for '{name}' - kept as two drivers")
        drv = drivers.setdefault(key, {"name": " ".join(name.split()), "phone": ph, "position": "LO", "fleet": "G7"})
        if ph and not drv.get("phone"):
            drv["phone"] = ph
        # "Got the truck: Not yet" in the for-sale sheet = sold but not delivered -> Reserved column of the pipeline
        reserved = got.get(str(u)) == "not yet"
        status = r[c["Status"]].strip().title() or "Active"
        if status == "Reserved":
            status = "Active"
        if status not in D.SOLD_STATUSES:
            warn.append(f"Unit {u}: status '{status}' -> Active")
            status = "Active"
        sold = {"date": date(r[c["Contract Date"]]), "status": status, "price": money(r[c["Acquisition Price"]]),
                "acq_cost": money(r[c["Cost"]]) if "Cost" in c else None, "down": money(r[c["Received Downpaymetn"]]),
                "down_invoiced": money(r[c["Invoiced Downpayment"]]), "loan": money(r[c["Loan amount"]]),
                "paid_to_date": money(r[c["Total Payments"]]), "weekly": money(r[c["Weekly payments"]]),
                "term_months": months(r[c["Term"]]), "weeks_paid": money(r[c["Paid weeks"]]), "payments": []}
        sold = {k: v for k, v in sold.items() if v not in (None, "")}
        sold.setdefault("payments", [])
        if not sold.get("loan") and sold.get("price") is not None:
            sold["loan"] = sold["price"] - (sold.get("down") or 0)
        deals.append({"_drv": key, "unit": u, "seller": r[c["Seller"]].strip() or None, "sold": sold, "reserved": reserved,
                      "_truck": {"unit": u, "year": num(r[c["Year"]]), "vin": (r[c["VIN"]].strip().upper() or None)}})

    # ---- merge into records
    s = D.store()
    existing_t = {str(t["unit"]) for t in s.all("trucks")}
    existing_d = {(d.get("name", "").lower(), d.get("phone")): d for d in s.all("drivers")}
    if existing_t or s.all("deals"):
        warn.append(f"app already has {len(existing_t)} trucks - existing records are merged, not duplicated")
    sold_units = {str(d["unit"]) for d in deals}
    out_trucks = []
    for u, t in trucks.items():
        st = t.pop("sheet_status")
        if st == "for sale" and u in sold_units:
            warn.append(f"Unit {u} is 'For sale' in the for-sale sheet but on a sold contract - check")
        out_trucks.append(enrich(t))
    for d in deals:
        u = str(d["unit"])
        if u not in trucks:
            out_trucks.append(enrich({k: v for k, v in d["_truck"].items() if v}))
        else:
            for t in out_trucks:
                if str(t["unit"]) == u and not t.get("vin") and d["_truck"].get("vin"):
                    t["vin"] = d["_truck"]["vin"]

    drv_ids = {}
    all_drivers = s.all("drivers")
    out_drivers = []
    for k, v in drivers.items():
        cur = existing_d.get((v["name"].lower(), v.get("phone")))
        did = cur["id"] if cur else D.next_id(all_drivers + out_drivers, "D-", 101)
        rec = {"id": did, **{x: y for x, y in v.items() if y}}
        out_drivers.append(rec)
        drv_ids[k] = did
    all_deals = s.all("deals")
    have = {(x.get("driver_id"), str(x.get("unit"))): x for x in all_deals}
    out_deals = []
    for d in deals:
        did = drv_ids[d["_drv"]]
        cur = have.get((did, str(d["unit"])))
        rid = cur["id"] if cur else D.next_id(all_deals + out_deals, "S-", 1001)
        if d["reserved"]:
            terms = {k: v for k, v in d["sold"].items() if k not in ("status", "payments")}
            out_deals.append({"id": rid, "driver_id": did, "unit": d["unit"], "stage": "reserved", "seller": d["seller"],
                              "terms": terms, "notes": [], "tasks": []})
        else:
            out_deals.append({"id": rid, "driver_id": did, "unit": d["unit"], "stage": "active", "seller": d["seller"],
                              "activated": d["sold"].get("date"), "sold": d["sold"], "notes": [], "tasks": []})

    forsale = [t for t in out_trucks if str(t["unit"]) in trucks and str(t["unit"]) not in sold_units]
    print(f"trucks: {len(out_trucks)} ({len(forsale)} for sale), with photos: {sum(1 for t in out_trucks if t.get('photos'))}, with VIN: {sum(1 for t in out_trucks if t.get('vin'))}")
    print(f"drivers: {len(out_drivers)}   sold deals: {len(out_deals)}  ({', '.join(f'{k} {sum(1 for d in out_deals if d.get("sold", {}).get("status") == k)}' for k in D.SOLD_STATUSES)}, reserved {sum(1 for d in out_deals if d['stage'] == 'reserved')})")
    no_photo = [str(t["unit"]) for t in forsale if not t.get("photos")]
    print(f"for-sale trucks without gallery photos: {', '.join(no_photo) or 'none'}")
    for w in warn:
        print("NOTE", w)
    if not a.yes:
        print("dry run - nothing written (add --yes)")
        return
    for t in out_trucks:
        t["updated"] = D.now_iso()
        s.put("trucks", t["unit"], t)
    for r in out_drivers:
        s.put("drivers", r["id"], r)
    for r in out_deals:
        r = {k: v for k, v in r.items() if v is not None}
        r.setdefault("created", D.now_iso())
        s.put("deals", r["id"], r, merge=False)
    s.log(f"imported {len(out_trucks)} trucks, {len(out_drivers)} drivers and {len(out_deals)} sold trucks from Joey's sheets")
    n = D.publish(quiet=True)
    print(f"written. ads page now lists {n} trucks")


if __name__ == "__main__":
    main()
