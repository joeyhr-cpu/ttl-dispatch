# TTL Dispatch: truck sales CRM

A copy of g7-dispatch.netlify.app (G7 Leasing v5), with the same pages, deal stages and data model. Salesmen sign in with their own accounts, which Joey manages. Drivers get a separate public ads page.

- **App (salesmen, login required):** https://joeyhr-cpu.github.io/ttl-dispatch/
- **Driver ads page (public):** https://joeyhr-cpu.github.io/ttl-dispatch/ads.html. A single truck is at `ads.html#<unit>`.

| Page | What it shows |
|---|---|
| Dashboard | Due today, open deals, trucks for sale; sold strip with collected, remaining and monthly run-rate (admins only); pipeline strip; insights (🔊 read aloud, 📢 batch SMS, 📺 wallboard, 📄 weekly report, theme); this week; recent activity; due and overdue list; global search; shortcuts D, T, P, N and / |
| Trucks | Term and status chips, sortable table, add/edit truck, photos with lightbox, ad link, flyer, CSV export |
| Deals | Kanban Working → Assigned → Agreement out → Down payment → Ready → Active lease, with drag and drop and a "My deals" toggle. Deal sheet with tabs Overview (checklist, follow-ups, notes), Payments (installments, escrow), Received (sold-truck payment log) and Activity |
| Sold Trucks | Totals, 12-month cash-flow forecast, portfolio health, status filter (Active / Accident / Returned / Paid off), add sold truck, log payments, CSV export |
| Follow-ups | Overdue / Today / Next 7 days / Later / Done, each with a tick box to mark done |
| Drivers | Fleet chips (TTL / DT / VKL / G7), contact status, cards or table, call / SMS / WhatsApp, add and edit, export |
| KPI | Commission per agent (month / year / all time) and leaderboard |
| Settings | Fees & terms (admins edit), Deal calculator, Users (admins invite, edit and disable) |

## How it works

```
GitHub Pages (docs/)         Firebase (project ttl-dispatch, free plan)
  index.html  — app shell  ─►  Auth: one login per user
  ads.html    — public     ─►  Firestore: trucks, drivers, deals, users, activity, config
                                public_trucks + public_config  (ads page only)
Claude: tools/dispatch.py  ─►  same Firestore, with a service-account key
```

**No data is in the page source.** The site only contains code. CRM data is downloaded after sign-in, and `firestore.rules` lets a signed-in person read it only if `users/{uid}` exists with `active: true`.

**The ads page reads `public_trucks` only:** unit, year, make, model, miles, weekly payment, term, APU, warranty, engine, transmission and photos.
- `public_trucks` has no driver, deal, cost or salesman fields.
- The app and `dispatch.py publish` rebuild it from the trucks that are for sale.

**Roles:**
- Admins see costs and money totals, edit fees, manage users and can delete records.
- Sales users can add and edit trucks, drivers and deals.
- Costs are hidden from sales users on screen. The rules let any active user read every field of a truck, so cost is hidden, not protected. Ask Claude if it must be truly private.

**Users:**
- Admin opens Settings → Users → Invite user. The person gets an email to set their own password.
- To disable someone, untick "Can log in". They lose access at once.

**Both Joey and Claude edit.** Edits in the app save live and every open screen updates. Claude's changes land in the same place.

## Daily check (scheduled task `dispatch-daily-check`, 8:30 AM)

It runs `dispatch.py check --telegram`. The result goes to Joey's Telegram Saved Messages, and `config/meta.checked_at` is updated (shown in the app's top bar). It does seven things:
1. Checks the app and the ads page are online.
2. Checks that no driver names appear in the public page source.
3. Syncs **mileage** for every truck from the Datatruck odometer.
4. Rebuilds the public ads list.
5. Validates the data: bad VINs, missing drivers or trucks, duplicates, units on two open deals, and that an admin exists.
6. Backs up all collections to `backups/YYYY-MM-DD.json` on this PC (30 days kept, never committed).
7. Lists today's items: overdue follow-ups, cold deals, sold trucks with no payment in 14+ days, and for-sale trucks without photos.

## Claude's tool: `tools/dispatch.py`

Run it with `C:\Users\Joey\claude\tools\.venv\Scripts\python.exe`. The key is `C:\Users\Joey\claude\tools\dispatch-firebase-key.json`; it is secret and never committed. In PowerShell, pass JSON with `--file` or pipe it in with `--file -`.

```
dispatch.py list trucks|drivers|deals|users|activity|fees [--filter fleet=TTL] [--full]
dispatch.py get deals S-1001
dispatch.py upsert trucks --file trucks.json      # object or list; merged by unit / id
dispatch.py upsert fees --file fees.json
dispatch.py note S-1001 "text"   |  task S-1001 "text" --due 2026-11-02  |  done S-1001 T-1
dispatch.py stage S-1001 downpayment
dispatch.py pay S-1003 --amount 650 --date 2026-10-28 --method zelle [--weeks 1]
dispatch.py delete drivers D-105 --yes
dispatch.py user someone@x.com --role admin|sales [--name N] [--sales yes|no] [--disable]
dispatch.py miles [--dry-run]  |  publish  |  validate  |  backup  |  restore FILE --yes
dispatch.py check [--telegram] [--no-site]
dispatch.py init                                  # one-time defaults on a new project
```

Use `DISPATCH_DATA_DIR=<folder>` to run the tool against local JSON files for testing.

**Code changes:** run `tools\publish.ps1 -Message "..."`. It refuses to publish if demo data or a key file is staged.

**Firestore rules:** they are in `firestore.rules`. Paste them in Firebase console → Firestore → Rules → Publish.

## Data model

- **trucks/{unit}:** unit, year, make, model, vin, miles, miles_synced, price_total, weekly, term_weeks, cost, apu, warranty, engine, trans, salesman, status (null / on_hold / sold), location, photos[], notes.
- **drivers/{D-###}:** name, phone, email, fleet, position (LO / OO / C), pay, cdl, tenure, salesman, notes.
- **deals/{S-####}:**
  - Deal fields: driver_id, unit, stage, plan (standard / split / warranty), agent_id, gross, agreement_sent, agreement_signed, escrow_paid, installments[{n, amount, due, paid, paid_date}], activated, notes[{ts, who, body}], tasks[{id, body, due, done, done_at}], created.
  - A sold truck is a deal with `sold: {date, status, acq_cost, loan, down, weekly, term_months, weeks_paid, payments[{date, amount, method, note}]}`.
  - Collected = down payment + the larger of (logged payments) and (weekly × weeks_paid).
- **users/{uid}:** name, email, role (admin / sales), is_sales, active.
- **config/fees:** commission, dispatch, mile, admin, trailer, ins, oci, esc, payout, contact_phone.
- **config/meta:** checked_at, miles_synced_at.

## What to send Claude, per section

A screenshot, a sheet or a list in chat all work. **Bold** fields are required.

- **Trucks for sale:** **unit**, **year**, make/model, VIN, total price, weekly payment, term (weeks), our cost, APU, warranty, engine and transmission, salesman, photo links, location. Miles come from Datatruck automatically.
- **Drivers:** **full name**, **fleet**, phone, email, position, pay, CDL and experience, tenure, salesman.
- **Sold trucks:** **unit**, **driver name**, **sold date**, acquisition cost, loan amount, down payment, weekly payment, term (months), weeks paid so far, status (Active / Accident / Returned / Paid off), sales agent, and payment history if you have it.
- **Open deals:** **driver**, **stage**, truck unit, plan, sales agent, agreement sent and signed dates, escrow paid, installments paid, follow-ups, notes.
- **Salesmen to invite:** name, email, admin or sales.
- **Fees:** the defaults are G7's: commission $1,000, dispatch 15%, mileage 9¢, admin $300, trailer $250, insurance $500, OCI $50, escrow $2,500, payout 85%. Also send the phone number to show on the ads page.

## Local preview

The `.claude/launch.json` entry "dispatch-app" serves `docs/` on port 8765. If `config.js` has no projectId and `docs/data.json` exists, the app runs in **demo mode**, where edits stay in memory only. Delete `docs/data.json` before publishing (`publish.ps1` enforces this).
