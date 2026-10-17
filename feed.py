"""Job Scout feed — every IT role.

Runs on GitHub Actions. Collects IT jobs (every IT field, entry to mid level,
including roles named outside "IT" — see it_roles.py) from sources that block
Google's servers and writes feed/tech.json, which the Job Scout sheet reads.

Sources:
  • Indeed Canada and LinkedIn, through JobSpy
  • Government of Canada Job Bank (its search pages, newest first)
  • Employer career sites with RSS feeds (SuccessFactors): Rogers, Bell, TELUS,
    Hydro One, OPG, Toronto Hydro, Canada Post, Purolator, Bombardier,
    University of Toronto, Halton Region

Only jobs posted in the last 24 hours are searched for. They're kept for 48 hours,
merged across runs, so a run where a board blocks us doesn't empty the feed.
The same job found on several boards is kept once (same company, title and city).
"""
import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path
from urllib.parse import quote_plus

import requests

from it_roles import SEARCH_TERMS, is_it_role

LOCATION = "Toronto, ON"
PROVINCE = "ON"
SEARCH_HOURS = 24
KEEP_HOURS = 48
RESULTS_PER_SEARCH = {"indeed": 60, "linkedin": 30}
OUT = Path(__file__).parent / "feed"
UA = {"User-Agent": "Mozilla/5.0 (JobScout class feed; +https://github.com/black-s1k/jobscout-feed)"}
HTML = dict(UA, Accept="text/html")  # Job Bank returns 500 if Accept mentions JSON
ET = timezone(timedelta(hours=-4))

# Every IT field (it_roles.py is the same file as the job agent's src/it_roles.py).
FEED_NAME = "tech"
TERM_WORKERS = 5  # searches run side by side; more starts tripping Indeed's rate limit

# Glassdoor, Google Jobs and ZipRecruiter fail inside JobSpy for Canada (checked Oct 1 2026).
JOBSPY_SITES = ["indeed", "linkedin"]
SITE_LABEL = {"indeed": "Indeed", "linkedin": "LinkedIn"}

# Employer career sites (SAP SuccessFactors) that publish an RSS feed, newest first.
# Each feed returns the 20 newest matches, so every search term is tried too.
CAREER_RSS = {
    "jobs.rogers.com": "Rogers", "jobs.bce.ca": "Bell", "careers.telus.com": "TELUS",
    "jobs.hydroone.com": "Hydro One", "jobs.opg.com": "OPG", "jobs.torontohydro.com": "Toronto Hydro",
    "jobs.canadapost.ca": "Canada Post", "careers.purolator.com": "Purolator", "jobs.bombardier.com": "Bombardier",
    "jobs.utoronto.ca": "University of Toronto", "careers.halton.ca": "Halton Region",
}

DEFAULT_PLACE = {"careers.halton.ca": "Oakville, ON, CA"}  # its feed leaves the location out

PROVINCES = {"ON": "Ontario", "BC": "British Columbia", "AB": "Alberta", "QC": "Quebec", "MB": "Manitoba", "SK": "Saskatchewan",
             "NS": "Nova Scotia", "NB": "New Brunswick", "NL": "Newfoundland and Labrador", "PE": "Prince Edward Island"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def clean(s):
    s = "" if s is None else str(s)
    return "" if s.lower() in ("nan", "none", "nat") else re.sub(r"\s+", " ", unescape(s)).strip()


# ── Sources ────────────────────────────────────────────────────────────────

# LinkedIn rate-limits quickly: its searches run one at a time, a few seconds apart,
# and only for the first few search terms.
LINKEDIN_LOCK = threading.Lock()
LINKEDIN_TERMS = 8


def jobspy_search(site, term):
    if site == "linkedin":
        with LINKEDIN_LOCK:
            time.sleep(4)
            return _jobspy_search(site, term)
    return _jobspy_search(site, term)


def _jobspy_search(site, term):
    from jobspy import scrape_jobs
    df = scrape_jobs(
        site_name=[site], search_term=term, location=LOCATION, distance=50,
        results_wanted=RESULTS_PER_SEARCH[site], hours_old=SEARCH_HOURS,
        country_indeed="Canada", verbose=0,
    )
    jobs = []
    for r in df.to_dict("records"):
        posted = r.get("date_posted")
        posted = posted.isoformat() if hasattr(posted, "isoformat") else clean(posted)
        if not posted:
            continue  # no date, can't tell fresh from stale
        loc = ", ".join(p for p in (clean(r.get("city")), clean(r.get("state"))) if p) or clean(r.get("location"))
        if r.get("is_remote") is True and "remote" not in loc.lower():
            loc = f"{loc} (remote)".strip()
        jobs.append({"title": clean(r.get("title")), "company": clean(r.get("company")), "location": loc,
                     "posted": posted, "link": clean(r.get("job_url")), "source": SITE_LABEL[site]})
    return jobs


def jobbank_search(term):
    """Job Bank's own search pages (25 per page, newest first). Its RSS feed returns only a handful."""
    jobs = []
    for page in (1, 2, 3):
        url = (f"https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring={quote_plus(term)}"
               f"&fprov={PROVINCE}&sort=D&page={page}")
        r = requests.get(url, headers=HTML, timeout=30)
        r.raise_for_status()
        batch = []
        for a in re.findall(r'<article id="article-\d+".*?</article>', r.text, re.S):
            href = re.search(r'<a[^>]+href="(/jobsearch/jobposting/[^"#?;]+)', a)
            title = re.search(r'class="noctitle"[^>]*>([^<]+)', a)
            when = re.search(r'<li class="date">\s*([^<\n]+)', a)
            if not (href and title and when):
                continue
            try:
                posted = datetime.strptime(clean(when.group(1)), "%B %d, %Y").date().isoformat()
            except ValueError:
                continue
            biz = re.search(r'class="business"[^>]*>([^<]+)', a)
            loc = re.search(r'class="location"[^>]*>.*?<span class="wb-inv">Location</span>(.*?)</li>', a, re.S)
            where = re.sub(r"\s*\((\w\w)\)", lambda m: f", {PROVINCES.get(m.group(1), m.group(1))}", clean(re.sub(r"<[^>]+>", " ", loc.group(1)))) if loc else ""
            t = clean(title.group(1))
            batch.append({"title": t[:1].upper() + t[1:], "company": clean(biz.group(1)) if biz else "",
                          "location": f"{where}, Canada" if where else "Canada", "posted": posted,
                          "link": "https://www.jobbank.gc.ca" + href.group(1), "source": "Job Bank"})
        jobs += batch
        # Newest first: stop once a page reaches jobs older than the search window.
        if len(batch) < 25 or not batch or posted_time(batch[-1]["posted"]) < now() - timedelta(hours=SEARCH_HOURS + 24):
            break
        time.sleep(0.5)
    return jobs


def career_rss(host, term=""):
    url = (f"https://{host}/services/rss/job/?locale=en_US&keywords={quote_plus(term)}"
           "&sortColumn=referencedate&sortDirection=desc")
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    jobs = []
    for it in r.text.split("<item>")[1:]:
        title = clean(re.sub(r"<!\[CDATA\[|\]\]>", "", (re.search(r"<title>(.*?)</title>", it, re.S) or [None, ""])[1]))
        link = clean((re.search(r"<link>(.*?)</link>", it, re.S) or [None, ""])[1])
        pub = clean((re.search(r"<pubDate>(.*?)</pubDate>", it, re.S) or [None, ""])[1])
        if not (title and link and pub):
            continue
        # Titles look like "Sales Associate (Mississauga, ON, CA)"
        m = re.match(r"(.*)\(([^()]*)\)\s*$", title)
        name, where = (clean(m.group(1)), clean(m.group(2))) if m else (title, "")
        try:
            posted = parsedate_to_datetime(pub).isoformat()
        except (TypeError, ValueError):
            continue
        jobs.append({"title": name, "company": CAREER_RSS[host], "location": where or DEFAULT_PLACE.get(host, ""), "posted": posted,
                     "link": link, "source": f"{CAREER_RSS[host]} careers"})
    return jobs


# ── Freshness and de-duplication ───────────────────────────────────────────

def now():
    return datetime.now(timezone.utc)


def posted_time(p):
    """Datetime for a posted value; date-only values count as noon (Toronto time) that day."""
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", p):
            return min(datetime.fromisoformat(p).replace(hour=12, tzinfo=ET), now())
        d = datetime.fromisoformat(p.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


COMPANY_ALIASES = {"royalbankof": "rbc", "rbcroyalbank": "rbc", "bankofmontreal": "bmo", "torontodominionbank": "td",
                   "tdbank": "td", "bankofnovascotia": "scotiabank", "canadianimperialbankofcommerce": "cibc",
                   "amazoncom": "amazon", "amazonwebservices": "amazon", "bellcanada": "bell", "bce": "bell"}
LOCATION_WORDS = r"(remote|hybrid|on-?site|in[- ]office|canada|ontario|toronto|gta|mississauga|brampton|markham|vaughan|ottawa|waterloo|hamilton|[a-z .]+,\s*(on|bc|ab|qc))"


def company_key(c):
    k = re.sub(r"\b(inc|ltd|llc|corp|corporation|co|limited|plc|the|canada|group|financial|holdings)\b\.?", "", c.lower())
    k = re.sub(r"[^a-z0-9]", "", k)
    return COMPANY_ALIASES.get(k, k)


def title_key(t):
    t = t.lower()
    t = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", t)                          # (Hybrid), [Remote]
    t = re.sub(rf"\s+[-–|@]\s+{LOCATION_WORDS}.*$", " ", t)              # " - Toronto, ON"
    t = re.sub(r"\b(full|part)[- ]time\b|\b(contract|permanent|temporary|temp|hybrid|remote|on-?site)\b", " ", t)
    return re.sub(r"[^a-z0-9]", "", t)


def city_key(loc):
    return re.sub(r"[^a-z]", "", (loc or "").lower().split(",")[0])


def dup_key(j):
    return f"{company_key(j.get('company', ''))}|{title_key(j.get('title', ''))}|{city_key(j.get('location'))}"


# ── Run ────────────────────────────────────────────────────────────────────

def run_all(terms):
    found, stats, lock = [], {}, threading.Lock()

    def add(label, fn):
        try:
            jobs = fn()
        except Exception as e:  # one blocked source shouldn't stop the rest
            log(f"  {label}: {type(e).__name__}: {str(e)[:120]}")
            jobs = []
        with lock:
            stats[label] = stats.get(label, 0) + len(jobs)
            found.extend(jobs)

    def one(i, term):
        for site in JOBSPY_SITES:
            if site == "linkedin" and i >= LINKEDIN_TERMS:
                continue
            add(SITE_LABEL[site], lambda: jobspy_search(site, term))
            time.sleep(1)
        add("Job Bank", lambda: jobbank_search(term))

    with ThreadPoolExecutor(max_workers=TERM_WORKERS) as pool:
        list(pool.map(lambda a: one(*a), enumerate(terms)))
    with ThreadPoolExecutor(max_workers=6) as pool:
        queries = [(h, t) for h in CAREER_RSS for t in [""] + terms]
        for res in pool.map(lambda q: safe(career_rss, *q), queries):
            stats["Employer career sites"] = stats.get("Employer career sites", 0) + len(res)
            found.extend(res)
    it = [j for j in found if is_it_role(j.get("title", ""))]
    stats["kept as IT"] = len(it)
    return it, stats


def safe(fn, *args):
    try:
        return fn(*args)
    except Exception as e:
        log(f"  {fn.__name__}{args}: {type(e).__name__}: {str(e)[:100]}")
        return []


def merge(field, fresh):
    path = OUT / f"{field}.json"
    old = json.loads(path.read_text())["jobs"] if path.exists() else []
    cutoff = now() - timedelta(hours=KEEP_HOURS)
    by_link, by_key = {}, {}
    for j in old + fresh:  # newer runs win
        t = posted_time(j.get("posted", ""))
        if not (j.get("link") and j.get("title") and t and t >= cutoff and is_it_role(j["title"])):
            continue
        k = dup_key(j)
        if k in by_key and by_key[k] != j["link"]:
            continue  # same job already found on another board
        by_key[k] = j["link"]
        by_link[j["link"]] = j
    return sorted(by_link.values(), key=lambda j: posted_time(j["posted"]), reverse=True)


def main():
    OUT.mkdir(exist_ok=True)
    started = now()
    fresh, stats = run_all(sys.argv[1:] or SEARCH_TERMS)  # terms on the command line: a quick test run
    jobs = merge(FEED_NAME, fresh)
    (OUT / f"{FEED_NAME}.json").write_text(json.dumps({"updated": started.isoformat(timespec="seconds"), "jobs": jobs}, ensure_ascii=False, indent=0))
    # The per-field files (finance, health…) are gone: this feed is IT only now.
    for old in OUT.glob("*.json"):
        if old.stem not in (FEED_NAME, "status"):
            old.unlink()
    status = {"updated": started.isoformat(timespec="seconds"), "fields": {FEED_NAME: {"found_this_run": stats, "in_feed": len(jobs)}},
              "seconds": round((now() - started).total_seconds())}
    (OUT / "status.json").write_text(json.dumps(status, indent=1))
    log(f"{sum(v for k, v in stats.items() if k != 'kept as IT')} found this run {stats} · {len(jobs)} in feed")


if __name__ == "__main__":
    main()
