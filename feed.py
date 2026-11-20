"""Job Scout feed: every IT job in Canada, internship to mid level.

Runs on GitHub Actions (.github/workflows/feed.yml): a quick run every 10 minutes and a
full run every 30. Collects IT jobs (every IT field, including roles named outside "IT":
see it_roles.py) from sources Google's servers can't reach, and writes feed/tech.json,
which Job Scout sheets read and filter by their own settings.

Sources:
  • Indeed Canada and LinkedIn, through JobSpy: Canada-wide plus the biggest cities
  • Fully remote US jobs from Indeed (hybrid and on-site US jobs are dropped), marked
    country "US" so a sheet can drop them with its Work style setting
  • Government of Canada Job Bank (its search pages, newest first, all provinces)
  • Employer career sites with RSS feeds (SuccessFactors): Rogers, Bell, TELUS, Scotiabank,
    Deloitte, EY, SAP, Hydro One, OPG, Canada Post, Bombardier, City of Toronto…
  • Employer hiring systems read directly, so jobs arrive before they reach the job boards:
    banks, insurers, pension funds, the Big 4 and big tech on Workday, Ford on Oracle,
    OpenText on Phenom, KPMG, Microsoft and IBM's own job APIs, BC Public Service
  • Tech companies on Greenhouse, Lever, Ashby and SmartRecruiters

Everywhere in Canada, Quebec included. French-language and part-time IT jobs are kept
(marked `french` / `part_time`). Senior, lead, manager and executive titles are dropped,
and so are jobs asking for more than MAX_YEARS years of experience.

Searches ask for jobs posted in the last 48 hours; jobs stay in the feed for 3 days, merged
across runs, so a run where a board blocks us doesn't empty the feed. The same job found on
several boards is kept once (same company, title and city), preferring the employer's own link.

`python feed.py` runs everything; `python feed.py quick` reads only the employers' own
boards; `python feed.py auto` does a full run when the last one was 28+ minutes ago, else
a quick one; `python feed.py check` fails when a source has found nothing 3 runs in a row.

The sources, employer lists, de-duplication and years-of-experience reading are adapted from
github.com/sagarh12/canada-jobs-feed (MIT License, Copyright (c) 2026 Sagarpreet Hooda).
"""
import json
import os
import random
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

SEARCH_HOURS = 48
KEEP_HOURS = 72
MAX_YEARS = 5  # internship to mid level: jobs asking for more years than this are dropped
TIME_BUDGET = 8 * 60  # seconds; searches not started by then are skipped this run
QUICK_BUDGET = 3 * 60  # the 10-minute employer-only run
FULL_EVERY = 28 * 60  # auto mode: a full run when the last one was at least this long ago (seconds)
OUT = Path(__file__).parent / "feed"
UA = {"User-Agent": "Mozilla/5.0 (Job Scout feed; +https://github.com/nruppatel16/jobscout-feed)"}
HTML = dict(UA, Accept="text/html")  # Job Bank returns 500 if Accept mentions JSON
ET = timezone(timedelta(hours=-4))

# Every IT field (it_roles.py), plus early-career and French searches.
EARLY_TERMS = [
    "new grad software", "software intern", "software developer co-op", "data analyst intern", "data science intern",
    "IT co-op", "cybersecurity intern", "computer science student", "summer student technology",
    "new graduate software engineer", "entry level data analyst", "junior IT analyst", "technical support analyst",
]
FRENCH_TERMS = ["développeur", "analyste TI", "technicien informatique", "soutien technique", "stagiaire informatique"]
TERMS = list(dict.fromkeys(SEARCH_TERMS + EARLY_TERMS + FRENCH_TERMS))
PLACES = ["Canada", "Toronto, ON", "Montréal, QC", "Ottawa, ON", "Waterloo, ON", "Vancouver, BC", "Calgary, AB",
          "Edmonton, AB", "Québec, QC", "Winnipeg, MB", "Halifax, NS"]
US = "United States"  # searched for fully remote jobs only
# Canada-wide searches return the most; city searches catch what those miss.
RESULTS_PER_SEARCH = {"indeed": {"Canada": 100, US: 50, "city": 50}, "linkedin": {"Canada": 50, US: 25, "city": 25}}
NOT_REMOTE = re.compile(r"\bhybrid\b|\bon-?site\b|\bin[- ]office\b|\bin[- ]person\b", re.I)
# Glassdoor, Google Jobs and ZipRecruiter fail inside JobSpy for Canada.
SITE_LABEL = {"indeed": "Indeed", "linkedin": "LinkedIn"}
RSS_TERMS_PER_RUN = 25  # full runs search each RSS site for this many terms, a different sample each run

# Employer career sites (SAP SuccessFactors) that publish an RSS feed, newest first.
# Each feed returns the 20 newest matches, so every search term is searched too.
CAREER_RSS = {
    "jobs.rogers.com": "Rogers", "jobs.bce.ca": "Bell", "careers.telus.com": "TELUS",
    "jobs.hydroone.com": "Hydro One", "jobs.opg.com": "OPG", "jobs.torontohydro.com": "Toronto Hydro",
    "jobs.canadapost.ca": "Canada Post", "careers.purolator.com": "Purolator", "jobs.bombardier.com": "Bombardier",
    "jobs.utoronto.ca": "University of Toronto", "careers.halton.ca": "Halton Region",
    "jobs.scotiabank.com": "Scotiabank", "careers.deloitte.ca": "Deloitte",
    "careers.ieso.ca": "IESO", "jobs.transalta.com": "TransAlta", "jobs.toronto.ca": "City of Toronto",
    "careers.cmhc-schl.gc.ca": "CMHC", "careers.auroramj.com": "Aurora Cannabis",
}
TECH_ONLY_RSS = {"careers.ieso.ca", "jobs.transalta.com", "jobs.toronto.ca", "careers.auroramj.com", "careers.pcl.com"}
# Global employers on SuccessFactors: their RSS can't filter by country, so they're
# searched by Canadian city names instead (the keyword matches the job's location).
GLOBAL_RSS = {"careers.ey.com": "EY", "careers.sap.com": "SAP", "careers.celestica.com": "Celestica", "careers.pcl.com": "PCL Construction"}
CITY_KEYWORDS = ["Canada", "Toronto", "Vancouver", "Calgary", "Ottawa", "Edmonton", "Waterloo", "Halifax", "Winnipeg"]

# Employer boards on Workday: (name, host, site[, TECH_ONLY]). Each is read newest first.
# Boards for worldwide employers are narrowed to Canada with their own location filter.
TECH_ONLY = True  # automotive, utility and health employers: tech roles only, no other student jobs
WORKDAY = [
    ("RBC", "rbc.wd3", "RBCGLOBAL1"), ("RBC", "rbc.wd3", "rbcearlytalent1"),
    ("TD", "td.wd3", "TD_Bank_Careers"), ("CIBC", "cibc.wd3", "search"), ("CIBC", "cibc.wd3", "campus"),
    ("BMO", "bmo.wd3", "External"), ("Desjardins", "desjardins.wd10", "Desjardins"),
    ("Manulife", "manulife.wd3", "MFCJH_Jobs"), ("Sun Life", "sunlife.wd3", "Experienced-Jobs"),
    ("Sun Life", "sunlife.wd3", "Campus"), ("Intact", "intactfc.wd3", "intactfc"), ("iA Financial", "ia.wd3", "professional"),
    ("Ontario Teachers'", "otppb.wd3", "OntarioTeachers_Careers"), ("OMERS", "omers.wd3", "OMERS_External"),
    ("HOOPP", "hoopp.wd10", "HOOPP"), ("HOOPP", "hoopp.wd10", "HOOPPStudent"), ("Interac", "interac.wd3", "Interac"),
    ("Moneris", "moneris.wd3", "Moneris"), ("Fidelity Canada", "fil.wd3", "fidelitycanada"),
    ("Mastercard", "mastercard.wd1", "CorporateCareers"),
    ("PwC", "pwc.wd3", "Global_Experienced_Careers"),  # its campus board has no Canadian jobs
    ("BDO", "bdo.wd3", "BDO"), ("Raymond Chabot Grant Thornton", "rcgt.wd3", "External"),
    ("Thomson Reuters", "thomsonreuters.wd5", "External_Career_Site"), ("NVIDIA", "nvidia.wd5", "NVIDIAExternalCareerSite"),
    ("Salesforce", "salesforce.wd12", "External_Career_Site"), ("Intel", "intel.wd1", "External"),
    ("Cisco", "cisco.wd5", "Cisco_Careers"), ("Ciena", "ciena.wd5", "Careers"), ("Autodesk", "autodesk.wd1", "Ext"),
    ("CDW", "cdw.wd5", "Careers"), ("CAE", "cae.wd3", "career"),
    ("Canadian Tire", "canadiantirecorporation.wd3", "Enterprise_External_Careers_Site"),
    ("Enbridge", "enbridge.wd3", "enbridge_careers"), ("Cenovus", "cenovus.wd3", "careers"),
    # Automotive
    ("General Motors", "generalmotors.wd5", "Careers_GM", TECH_ONLY), ("Magna", "magna.wd3", "Magna", TECH_ONLY),
    ("Nissan Canada", "alliance.wd3", "NissanPrivateExternal", TECH_ONLY), ("BlackBerry", "bb.wd3", "BlackBerry", TECH_ONLY),
    ("BlackBerry QNX", "bb.wd3", "QNX", TECH_ONLY), ("BlackBerry", "bb.wd3", "Student", TECH_ONLY),
    # Utilities and energy
    ("Hydro Ottawa", "hydroottawa.wd3", "hydro_ottawa_careersite", TECH_ONLY), ("Bruce Power", "brucepower.wd3", "BrucePower", TECH_ONLY),
    ("Capital Power", "capitalpower.wd10", "External", TECH_ONLY), ("ENMAX", "enmax.wd3", "ENMAXCareers", TECH_ONLY),
    # Health: hospitals, pharma, medical technology and distribution
    ("Sinai Health", "shn.wd10", "SHN_External_Career_Site", TECH_ONLY), ("Southlake Health", "southlake.wd10", "Southlake", TECH_ONLY),
    ("Oak Valley Health", "oakvalleyhealth.wd10", "OakValleyHealth", TECH_ONLY), ("CHEO", "cheo.wd10", "External_Site", TECH_ONLY),
    ("St. Joseph's Hamilton", "stjoes.wd10", "STJOESHAM", TECH_ONLY),
    ("Public Health Ontario", "publichealthontario.wd10", "PHOCareerSite", TECH_ONLY),
    ("McKesson Canada", "mckesson.wd3", "External_Careers", TECH_ONLY), ("Medtronic", "medtronic.wd1", "MedtronicCareers", TECH_ONLY),
    ("Roche", "roche.wd3", "roche-ext", TECH_ONLY), ("Pfizer", "pfizer.wd1", "PfizerCareers", TECH_ONLY),
    ("Johnson & Johnson", "jj.wd5", "JJ", TECH_ONLY), ("GSK", "gsk.wd5", "GSKCareers", TECH_ONLY),
    ("AstraZeneca", "astrazeneca.wd3", "Careers", TECH_ONLY), ("Sanofi", "sanofi.wd3", "SanofiCareers", TECH_ONLY),
    ("Baxter", "baxter.wd1", "baxter", TECH_ONLY), ("Philips", "philips.wd3", "jobs-and-careers", TECH_ONLY),
    ("Abbott", "abbott.wd5", "abbottcareers", TECH_ONLY), ("Stryker", "stryker.wd1", "StrykerCareers", TECH_ONLY),
    ("Novartis", "novartis.wd3", "Novartis_Careers", TECH_ONLY),
    # More big tech
    ("Adobe", "adobe.wd5", "external_experienced"), ("HP", "hp.wd5", "ExternalCareerSite"), ("PayPal", "paypal.wd1", "jobs"),
    # Telecom, retail, aviation
    ("TELUS Health", "lifeworks.wd3", "External"), ("Loblaw", "myview.wd3", "Careers", TECH_ONLY),
    ("Best Buy Canada", "bestbuycanada.wd3", "BestBuyCA_Career", TECH_ONLY), ("NAV CANADA", "navcanada.wd10", "NAV_Careers", TECH_ONLY),
]
# Employer boards on Oracle Recruiting: (name, API host, site, public job page prefix), narrowed to Canada.
ORACLE = [("Ford", "efds.fa.em5.oraclecloud.com", "CX_1", "https://apply.ford.com/en/sites/CX_1/job/")]
WORKDAY_PAGES = 10  # 20 jobs a page; reading stops sooner once jobs are older than the search window

# Tech companies' public job boards: {board id: name}. Each returns every open job at once.
GREENHOUSE = {
    "geotab": "Geotab", "d2l": "D2L", "hootsuite": "Hootsuite", "tenstorrent": "Tenstorrent", "ritual": "Ritual",
    "fellow": "Fellow", "diligent": "Diligent", "stackadapt": "StackAdapt", "flipp": "Flipp", "lyft": "Lyft",
    "stripe": "Stripe", "databricks": "Databricks", "cloudflare": "Cloudflare", "datadog": "Datadog",
    "twilio": "Twilio", "okta": "Okta", "instacart": "Instacart", "coinbase": "Coinbase", "robinhood": "Robinhood",
    "samsara": "Samsara", "pinterest": "Pinterest", "dropbox": "Dropbox", "affirm": "Affirm", "figma": "Figma",
    "brex": "Brex", "scaleai": "Scale AI", "anthropic": "Anthropic", "abnormalsecurity": "Abnormal Security",
    "asana": "Asana", "bitwarden": "Bitwarden", "braze": "Braze", "carta": "Carta", "chainguard": "Chainguard",
    "circleci": "CircleCI", "collibra": "Collibra", "cribl": "Cribl", "dataiku": "Dataiku", "discord": "Discord",
    "elastic": "Elastic", "expel": "Expel", "faire": "Faire", "fivetran": "Fivetran", "gitlab": "GitLab",
    "grafanalabs": "Grafana Labs", "gusto": "Gusto", "honeycomb": "Honeycomb", "lattice": "Lattice",
    "launchdarkly": "LaunchDarkly", "mercury": "Mercury", "mixpanel": "Mixpanel", "mongodb": "MongoDB",
    "monzo": "Monzo", "netlify": "Netlify", "pagerduty": "PagerDuty", "planetscale": "PlanetScale",
    "reddit": "Reddit", "securityscorecard": "SecurityScorecard", "shakepay": "Shakepay",
    "sigmacomputing": "Sigma Computing", "storyblok": "Storyblok", "tailscale": "Tailscale", "tines": "Tines",
    "toast": "Toast", "tulip": "Tulip", "vercel": "Vercel", "wizinc": "Wiz", "zscaler": "Zscaler",
}
ASHBY = {
    "wealthsimple": "Wealthsimple", "cohere": "Cohere", "1password": "1Password", "koho": "KOHO",
    "benevity": "Benevity", "jobber": "Jobber", "lightspeedhq": "Lightspeed", "thinkific": "Thinkific",
    "float": "Float", "neofinancial": "Neo Financial", "top-hat": "Top Hat", "sonder": "Sonder",
    "trulioo": "Trulioo", "clearco": "Clearco", "hopper": "Hopper", "miovision": "Miovision",
    "procurify": "Procurify", "visier": "Visier", "snowflake": "Snowflake", "plaid": "Plaid", "notion": "Notion",
    "ramp": "Ramp", "openai": "OpenAI", "amplitude": "Amplitude", "anyscale": "Anyscale", "cerebras": "Cerebras",
    "clickhouse": "ClickHouse", "drata": "Drata", "hex": "Hex", "iterable": "Iterable", "kira": "Kira",
    "linear": "Linear", "loopio": "Loopio", "nerdwallet": "NerdWallet", "nubank": "Nubank",
    "perplexity": "Perplexity", "pinecone": "Pinecone", "replit": "Replit", "sanity": "Sanity",
    "secureframe": "Secureframe", "semgrep": "Semgrep", "sentry": "Sentry", "snyk": "Snyk", "socket": "Socket",
    "supabase": "Supabase", "temporal": "Temporal", "vanta": "Vanta", "webflow": "Webflow", "zapier": "Zapier",
}
LEVER = {
    "pointclickcare": "PointClickCare", "wattpad": "Wattpad", "waveapps": "Wave", "achievers": "Achievers",
    "magnetforensics": "Magnet Forensics", "wishpond": "Wishpond", "arcadia": "Arcadia", "policyme": "PolicyMe",
    "sophos": "Sophos", "waabi": "Waabi",
}
SMARTRECRUITERS = {"Ubisoft2": "Ubisoft", "Visa": "Visa", "BoschGroup": "Bosch"}
# Phenom career sites: their search page embeds the newest jobs. (name, search page)
PHENOM = [("OpenText", "https://careers.opentext.com/us/en")]
US_PLACE = re.compile(r"\b(united states|usa|u\.s\.a?\.?|us)\b", re.I)

# Stricter, for TECH_ONLY employers: "security" alone is a guard, "technician" a pharmacy or lab tech.
TECH_ROLE = re.compile(
    r"\b(software|developer|programmer|data|analytics|business intelligence|bi|it|information technology|cloud|"
    r"cyber|cybersecurity|information security|soc|network|systems? (analyst|administrator|engineer)|infrastructure|"
    r"help ?desk|service desk|desktop support|technical support|qa|quality assurance analyst|test (engineer|analyst)|"
    r"web|full[- ]stack|front[- ]?end|back[- ]?end|devops|sre|machine learning|ai|database|digital|application|"
    r"embedded|firmware|automation engineer|informatics|ehr|epic)\b", re.I)
CANADA = re.compile(r"\bcanada\b|,\s*CA\b|\bCA[-,]|\b(" + "|".join(["ontario", "quebec", "québec", "british columbia",
    "colombie-britannique", "alberta", "manitoba", "saskatchewan", "nova scotia", "new brunswick", "newfoundland",
    "prince edward island", "yukon", "northwest territories", "nunavut", "toronto", "montr[eé]al", "vancouver", "calgary",
    "ottawa", "edmonton", "waterloo", "kitchener", "mississauga", "markham", "winnipeg", "halifax", "quebec city"]) + r")\b", re.I)

DEFAULT_PLACE = {"careers.halton.ca": "Oakville, ON, CA"}  # its feed leaves the location out

# Same as the sheet's titleLevel(): senior and executive titles are dropped,
# unless the title is also a student or new-grad role ("Product Owner Co-op").
SENIOR = re.compile(r"\b(senior|sr|lead|principal|staff|manager|supervisor|architect|superintendent|expert|chief|"
                    r"ceo|cfo|cto|coo|cio|cmo|president|vp|svp|evp|founder|co-founder|owner|partner|director|"
                    r"head of|general manager|managing director)\b", re.I)
SENIOR_LEVEL = re.compile(r"\b(III|IV|V)\b")  # case matters: "V" is a level, "v" isn't
EARLY = re.compile(r"\b(intern|interns|internship|co-?op|coop|student|new grad|graduate|entry[- ]level|junior|jr|"
                   r"campus|early talent|trainee|apprentice|work term|summer)\b", re.I)


def is_senior(title):
    return bool(SENIOR.search(title) or SENIOR_LEVEL.search(title)) and not EARLY.search(title)


# A description that requires French (an asset / preferred doesn't count). Kept, but marked.
FRENCH_REQUIRED = re.compile(
    r"bilingu(al|alism|e)\b[^.;]{0,60}\b(english|french|anglais|fran[cç]ais)\b"
    r"|\b(english|anglais)\s*(and|&|et)\s*(french|fran[cç]ais)\b[^.;]{0,40}\b(required|mandatory|essential|must|obligatoire)"
    r"|\b(fluen\w*|proficien\w*|command|mastery|knowledge)\s+(in|of)\s+(the\s+)?french\b"
    r"|\bfrench\b[^.;]{0,30}\b(required|mandatory|essential|is a must|a requirement)\b"
    r"|\b(required|mandatory|essential|must)\b[^.;]{0,40}\bfrench\b"
    r"|\bfrench[- ]speaking\b|\bma[iî]trise (du|de la langue) fran[cç]ais|\bbilingue\b", re.I)
NOT_REQUIRED_NEAR = re.compile(r"\b(asset|preferred|nice to have|bonus|atout|an advantage|desirable|considered a plus|is a plus)\b", re.I)


def french_required(text):
    for m in FRENCH_REQUIRED.finditer(text or ""):
        if not NOT_REQUIRED_NEAR.search(text[m.start():m.end() + 50]):
            return True
    return False


# Part-time jobs are kept, but marked; a job offered as either part-time or full-time isn't part-time.
PART_TIME = re.compile(r"\bpart[- ]?time\b|\btemps partiel\b", re.I)
FULL_TIME = re.compile(r"\bfull[- ]?time\b|\bcontract\b|\btemps plein\b", re.I)
PART_TIME_DESC = re.compile(r"\b(this is an?|is an?|hiring an?|seeking an?|for an?)\s+(permanent\s+|temporary\s+|casual\s+)?part[- ]time\s+"
                            r"(position|role|job|opportunity|employee|basis)\b|\bpart[- ]time\s+\(\d", re.I)


def part_time(*types, description=""):
    """True for a part-time-only job: its job type(s) or title say part-time and not full-time or contract,
    or its description says it's a part-time position."""
    text = " ".join(t for t in types if t)
    if PART_TIME.search(text) and not FULL_TIME.search(text):
        return True
    return bool(PART_TIME_DESC.search(description or "")) and not FULL_TIME.search(description or "")


def left_out(j):
    """Non-IT titles, senior titles and jobs asking for more than MAX_YEARS years aren't kept."""
    title = j.get("title", "")
    return not is_it_role(title) or is_senior(title) or (j.get("years") or 0) > MAX_YEARS

PROVINCES = {"ON": "Ontario", "BC": "British Columbia", "AB": "Alberta", "QC": "Quebec", "MB": "Manitoba", "SK": "Saskatchewan",
             "NS": "Nova Scotia", "NB": "New Brunswick", "NL": "Newfoundland and Labrador", "PE": "Prince Edward Island",
             "YT": "Yukon", "NT": "Northwest Territories", "NU": "Nunavut"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def clean(s):
    s = "" if s is None else str(s)
    return "" if s.lower() in ("nan", "none", "nat") else re.sub(r"\s+", " ", unescape(s)).strip()


# ── Years of experience (same rules as yearsAsked() in the Job Scout script) ──

YEAR_WORDS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
_N = r"(\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten)"
_SPAN = r"\s*(?:\(\d{1,2}\)\s*)?(?:\+|plus)?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?"
YEAR_PATTERNS = [
    # "3+ years of experience", "two (2) years' related experience", "2-4 years of hands-on experience"
    re.compile(rf"\b{_N}{_SPAN}(?:years?|yrs?)\b[^.;:!?]{{0,60}}?\bexperience", re.I | re.A),
    # "5+ years of professional software development", "3 years of industry work"
    re.compile(rf"\b{_N}{_SPAN}(?:years?|yrs?)'?\s+(?:of\s+)?(?:professional|relevant|related|hands-on|industry|progressive|working|work|post-graduate)\b", re.I | re.A),
    # "experience: 3+ years", "experience of at least 2 years"
    re.compile(rf"\bexperience\b[^.;!?]{{0,40}}?\b{_N}{_SPAN}(?:years?|yrs?)\b", re.I | re.A),
    # "Minimum 2 years in a software role", "2+ years developing web applications": no word "experience",
    # so only with "minimum / at least / requires" before or "+" after (not "over 10 years in business").
    re.compile(rf"(?:\b(?:minimum(?:\s+of)?|min\.?|at\s+least|requires?|required|must\s+have)\s+{_N}{_SPAN}|\b{_N}\s*(?:\+|plus)\s*)"
               rf"(?:years?|yrs?)'?\s+(?:as\s+an?|in\s+an?|in\s+the|in|developing|building|designing|working|programming|"
               rf"coding|supporting|administering|managing)\b", re.I | re.A),
]
NOT_REQUIRED_BEFORE = re.compile(r"\b(within|last|past|less than|under|up to|no more than|maximum of|max\.?|fewer than)\s*(the\s*)?(last\s*)?$", re.I)
NOT_REQUIRED_AFTER = re.compile(r"^[^.;!?]{0,40}\b(preferred|is an asset|an asset|nice to have|is a bonus|bonus)\b", re.I)


def years_asked(text):
    """Most years of experience a description requires, or None if it names none.
    "0-2 years" counts as 0; "less than 2 years", "graduated within 2 years" and
    "3 years preferred / an asset" don't count as requirements. An ellipsis ends a
    sentence, so "1 year… 3 years is an asset" asks for 1."""
    t = re.sub(r"\s+", " ", str(text or "")).replace("…", ".")
    most = None
    for pattern in YEAR_PATTERNS:
        for m in pattern.finditer(t):
            if NOT_REQUIRED_BEFORE.search(t[max(0, m.start() - 30):m.start()]):
                continue
            if NOT_REQUIRED_AFTER.search(t[m.end():m.end() + 60]):
                continue
            word = next(g for g in m.groups() if g).lower()
            y = YEAR_WORDS[word] if word in YEAR_WORDS else int(word)
            if y <= 15:  # bigger numbers are company history, not requirements
                most = max(most or 0, y)
    return most


def jobbank_years(experience):
    """Job Bank's own Experience field: "Will train", "Less than 1 year", "2 years to less than 3 years"..."""
    e = clean(experience).lower()
    if not e:
        return None
    if "will train" in e or "asset" in e or e.startswith("less than"):
        return 0
    m = re.match(r"(\d{1,2})\s*(?:years?|months?)", e)
    if not m:
        return None
    return 0 if "month" in m.group(0) else int(m.group(1))


# ── Sources ────────────────────────────────────────────────────────────────

def jobspy_search(site, term, place):
    from jobspy import scrape_jobs
    us = place == US
    # Indeed can't combine its remote filter with the date filter, so "remote" goes in the search instead.
    df = scrape_jobs(
        site_name=[site], search_term=f"{term} remote" if us and site == "indeed" else term, location=place, distance=50,
        results_wanted=RESULTS_PER_SEARCH[site].get(place, RESULTS_PER_SEARCH[site]["city"]),
        hours_old=SEARCH_HOURS, country_indeed="USA" if us else "Canada", is_remote=us, verbose=0,
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
        description = re.sub(r"[\\*_#`]", "", clean(r.get("description")))  # markdown marks
        title = clean(r.get("title"))
        if us:
            # Fully remote only: marked remote, and nothing in it says hybrid or on-site.
            if not (r.get("is_remote") is True or re.search(r"\bremote\b", f"{title} {loc}", re.I)):
                continue
            if NOT_REMOTE.search(f"{title} {loc} {description}"):
                continue
            loc = "Remote · United States"
        jobs.append({"title": title, "company": clean(r.get("company")), "location": loc,
                     "posted": posted, "link": clean(r.get("job_url")), "source": SITE_LABEL[site],
                     "apply": clean(r.get("job_url_direct")),  # the employer's own application page, when the board gives it
                     "country": "US" if us else "CA", "years": years_asked(description) if description else None,
                     "french": french_required(description),
                     "part_time": part_time(clean(r.get("job_type")).replace("parttime", "part-time").replace("fulltime", "full-time"),
                                            description=description)})
    return jobs


def jobbank_search(term):
    """Job Bank's own search pages, all of Canada (25 per page, newest first)."""
    jobs = []
    for page in (1, 2, 3, 4):
        url = f"https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring={quote_plus(term)}&sort=D&page={page}"
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
                          "link": "https://www.jobbank.gc.ca" + href.group(1), "source": "Job Bank", "years": None})
        jobs += batch
        # Newest first: stop once a page reaches jobs older than the search window.
        if len(batch) < 25 or posted_time(batch[-1]["posted"]) < now() - timedelta(hours=SEARCH_HOURS + 24):
            break
        time.sleep(0.5)
    return jobs


def jobbank_posting(link):
    """(years, french, part_time) from a Job Bank posting: its Experience field (or description),
    Languages field and employment terms."""
    r = requests.get(link, headers=HTML, timeout=30)
    r.raise_for_status()
    text = re.search(r'property="description">(.*?)</span>', r.text, re.S)
    text = clean(re.sub(r"<[^>]+>", " ", text.group(1))) if text else ""
    langs = re.search(r"<h4>Languages</h4>\s*<p[^>]*>([^<]+)", r.text)
    # "English", "English or French" are fine; "French", "English and French", "Bilingual" aren't.
    french = bool(langs and re.search(r"french|bilingual", langs.group(1), re.I) and not re.search(r"\bor\b", langs.group(1)))
    field = re.search(r'property="experienceRequirements qualification"[^>]*>\s*<span>([^<]+)', r.text)
    years = jobbank_years(field.group(1)) if field else (years_asked(text) if text else None)
    terms = re.search(r'property="employmentType"[^>]*>(.*?)</(?:p|li|span)>\s*(?:<span[^>]*>([^<]*))?', r.text, re.S)
    terms = clean(re.sub(r"<[^>]+>", " ", " ".join(g or "" for g in terms.groups()))) if terms else ""
    return years, french or french_required(text), part_time(terms)


def career_rss(host, term):
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
        company = CAREER_RSS.get(host) or GLOBAL_RSS[host]
        about = re.search(r"<description>(.*?)</description>", it, re.S)
        about = clean(re.sub(r"<[^>]+>", " ", unescape(re.sub(r"<!\[CDATA\[|\]\]>", "", about.group(1))))) if about else ""
        jobs.append({"title": name, "company": company, "location": where or DEFAULT_PLACE.get(host, ""),
                     "posted": posted, "link": link, "source": f"{company} careers",
                     "years": years_asked(about) if about else None, "french": french_required(about)})
    return employer_jobs(jobs, host in TECH_ONLY_RSS)


def employer_jobs(jobs, tech_only=False, keep_us=False):
    """Employer boards list every job: keep IT titles in Canada (and, with keep_us, fully remote US jobs).
    tech_only employers (automotive, utilities, health) also need a plainly technical title."""
    us = re.compile(r",\s*(US|USA)\s*$")  # SuccessFactors writes California as "San Jose, CA, US"
    return [j for j in jobs if is_it_role(j["title"]) and (not tech_only or TECH_ROLE.search(j["title"])) and (
        not j["location"] or (CANADA.search(j["location"]) and not us.search(j["location"]))
        or (keep_us and j.get("country") == "US"))]


WD_HEADERS = {"User-Agent": UA["User-Agent"], "Content-Type": "application/json", "Accept": "application/json"}


def workday_days_ago(posted_on):
    """Workday says "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago"."""
    p = (posted_on or "").lower()
    if "today" in p:
        return 0
    if "yesterday" in p:
        return 1
    m = re.search(r"(\d+)\+?\s*days?", p)
    return int(m.group(1)) if m else None


def workday_canada_filter(facets):
    """The board's own "Canada" location filter, if it has one: {facet: [id]}."""
    for f in facets or []:
        param = f.get("facetParameter", "")
        for v in f.get("values", []):
            if "values" in v:  # grouped facets
                found = workday_canada_filter([dict(v, facetParameter=v.get("facetParameter", param))])
                if found:
                    return found
            elif v.get("descriptor", "").strip().lower() == "canada" and re.search(r"country|hierarchy", param, re.I):
                return {param: [v["id"]]}
    return None


def workday_board(name, host, site, tech_only=False):
    tenant = host.split(".")[0]
    api = f"https://{host}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs"
    first = requests.post(api, json={"appliedFacets": {}, "limit": 1, "offset": 0, "searchText": ""}, headers=WD_HEADERS, timeout=30)
    first.raise_for_status()
    canada = workday_canada_filter(first.json().get("facets"))
    today = now().astimezone(ET).date()
    jobs = []
    for page in range(WORKDAY_PAGES):
        r = requests.post(api, json={"appliedFacets": canada or {}, "limit": 20, "offset": page * 20, "searchText": ""},
                          headers=WD_HEADERS, timeout=30)
        r.raise_for_status()
        postings = r.json().get("jobPostings") or []
        newest = None
        for p in postings:
            days = workday_days_ago(p.get("postedOn"))
            if days is None or not p.get("externalPath"):
                continue
            newest = days if newest is None else min(newest, days)
            where = clean(p.get("locationsText"))
            if canada and not CANADA.search(where):
                where = f"{where}, Canada" if where else "Canada"  # "3 Locations" inside the Canada filter
            jobs.append({"title": clean(p.get("title")), "company": name, "location": where,
                         "posted": (today - timedelta(days=days)).isoformat(),
                         "link": f"https://{host}.myworkdayjobs.com/{site}{p['externalPath']}",
                         "source": f"{name} careers", "years": None})
        # Mostly newest first, not strictly: stop at a page with nothing new on it.
        if len(postings) < 20 or newest is None or newest * 24 > SEARCH_HOURS:
            break
    return employer_jobs(jobs, tech_only)


def oracle_board(name, host, site, job_page):
    """Oracle Recruiting (Candidate Experience) boards, newest first, inside their "Canada" location."""
    api = f"https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions"

    def search(extra):
        r = requests.get(f"{api}?onlyData=true&expand=requisitionList.secondaryLocations"
                         f"&finder=findReqs;siteNumber={site},limit=25,sortBy=POSTING_DATES_DESC{extra}", headers=UA, timeout=30)
        r.raise_for_status()
        return r.json()["items"][0]

    canada = next((l["Id"] for l in search(",facetsList=LOCATIONS").get("locationsFacet", []) if l.get("Name") == "Canada"), None)
    if not canada:
        return []
    jobs = []
    for offset in range(0, 200, 25):
        batch = search(f",locationId={canada},offset={offset}").get("requisitionList") or []
        for r in batch:
            jobs.append({"title": clean(r.get("Title")), "company": name, "location": clean(r.get("PrimaryLocation")) or "Canada",
                         "posted": clean(r.get("PostedDate"))[:10], "link": f"{job_page}{r['Id']}",
                         "source": f"{name} careers", "years": None})
        if len(batch) < 25 or posted_time(jobs[-1]["posted"]) < now() - timedelta(hours=SEARCH_HOURS + 24):
            break
    return employer_jobs(jobs, tech_only=True)


def kpmg():
    """KPMG Canada's careers site API (iCIMS), newest first, with descriptions."""
    jobs = []
    for page in range(1, 11):
        r = requests.get("https://careers.kpmg.ca/api/jobs", headers=UA, timeout=30,
                         params={"page": page, "sortBy": "posted_date", "descending": "true", "internal": "false"})
        r.raise_for_status()
        batch = [j["data"] for j in r.json().get("jobs", [])]
        for d in batch:
            about = clean(re.sub(r"<[^>]+>", " ", " ".join(d.get(k) or "" for k in ("description", "qualifications"))))
            jobs.append({"title": clean(d.get("title")), "company": "KPMG",
                         "location": clean(d.get("full_location") or d.get("location_name")) or "Canada",
                         "posted": d["posted_date"].replace("+0000", "+00:00"),
                         "link": f"https://careers.kpmg.ca/jobs/{d['slug']}?lang=en-us", "source": "KPMG careers",
                         "years": years_asked(about) if about else None, "french": french_required(about)})
        if len(batch) < 10 or posted_time(jobs[-1]["posted"]) < now() - timedelta(hours=SEARCH_HOURS):
            break
    return employer_jobs(jobs)


def microsoft():
    """Microsoft's careers search for Canada, newest first."""
    jobs = []
    for start in range(0, 100, 10):
        r = requests.get("https://apply.careers.microsoft.com/api/pcsx/search", headers=UA, timeout=30,
                         params={"domain": "microsoft.com", "query": "", "location": "Canada", "start": start, "sort_by": "timestamp"})
        r.raise_for_status()
        batch = r.json().get("data", {}).get("positions") or []
        for p in batch:
            jobs.append({"title": clean(p.get("name")), "company": "Microsoft",
                         "location": "; ".join(p.get("standardizedLocations") or p.get("locations") or []) or "Canada",
                         "posted": datetime.fromtimestamp(int(p["postedTs"]), timezone.utc).isoformat(),
                         "link": f"https://apply.careers.microsoft.com{p['positionUrl']}", "source": "Microsoft careers", "years": None})
        if len(batch) < 10 or posted_time(jobs[-1]["posted"]) < now() - timedelta(hours=SEARCH_HOURS):
            break
    return employer_jobs(jobs)


def ibm():
    """IBM's careers search for Canada, newest first."""
    body = {"appId": "careers", "scopes": ["careers2"], "query": {"bool": {"must": []}},
            "post_filter": {"term": {"field_keyword_05": "Canada"}}, "size": 100, "sort": [{"dcdate": "desc"}],
            "lang": "zz", "localeSelector": {}, "sm": {"query": "", "lang": "zz"},
            "_source": ["title", "url", "dcdate", "field_keyword_19", "description"]}
    r = requests.post("https://www-api.ibm.com/search/api/v2", json=body, headers=WD_HEADERS, timeout=30)
    r.raise_for_status()
    jobs = []
    for h in r.json().get("hits", {}).get("hits", []):
        d = h["_source"]
        about = clean(re.sub(r"<[^>]+>", " ", d.get("description") or ""))
        jobs.append({"title": clean(d.get("title")), "company": "IBM",
                     "location": f"{clean(d.get('field_keyword_19'))}, Canada".lstrip(", "), "posted": d.get("dcdate", ""),
                     "link": d.get("url", ""), "source": "IBM careers", "years": years_asked(about) if about else None,
                     "french": french_required(about)})
    return employer_jobs(jobs)


# Stricter than CANADA: on these boards ", CA" is usually California.
CANADA_STRICT = re.compile(CANADA.pattern.replace(r",\s*CA\b|\bCA[-,]|", "") + r"|\b(ON|BC|AB|MB|SK|NS|NB|NL|PE),\s*CA\b|\bCAN\b", re.I)


def where(locations, remote=False):
    """("CA", location) for a job in Canada, ("US", "Remote · United States") for a fully remote US job, else None."""
    text = "; ".join(l for l in locations if l)
    canadian = [part.strip(" ()") for part in re.split(r"[;|•/]| or ", text) if CANADA_STRICT.search(part)]
    if canadian:
        return "CA", "; ".join(dict.fromkeys(canadian))
    remote = remote or re.search(r"\bremote\b", text, re.I)
    if remote and US_PLACE.search(text) and not NOT_REMOTE.search(text):
        return "US", "Remote · United States"
    return None


def board_job(company, title, locations, remote, posted, link, about="", job_type=""):
    place = where(locations, remote)
    if not place or not posted:
        return None
    return {"title": clean(title), "company": company, "location": place[1], "posted": posted, "link": link,
            "source": f"{company} careers", "country": place[0],
            "years": years_asked(about) if about else None, "french": french_required(about),
            "part_time": part_time(job_type, description=about)}


def fresh_only(jobs):
    cutoff = now() - timedelta(hours=SEARCH_HOURS)
    return [j for j in jobs if j and (posted_time(j["posted"]) or cutoff) >= cutoff]


def greenhouse(board, company):
    r = requests.get(f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs", headers=UA, timeout=30)
    r.raise_for_status()
    return employer_jobs(fresh_only(
        board_job(company, j.get("title"), [(j.get("location") or {}).get("name", "")], False,
                  j.get("first_published") or j.get("updated_at"), j.get("absolute_url"))
        for j in r.json().get("jobs", [])), keep_us=True)


def ashby(board, company):
    r = requests.get(f"https://api.ashbyhq.com/posting-api/job-board/{board}", headers=UA, timeout=30)
    r.raise_for_status()
    jobs = []
    for j in r.json().get("jobs", []):
        if j.get("isListed") is False:
            continue
        places = [j.get("location", "")] + [l.get("location", "") for l in j.get("secondaryLocations") or []]
        country = ((j.get("address") or {}).get("postalAddress") or {}).get("addressCountry", "")
        places.append(country)
        jobs.append(board_job(company, j.get("title"), places, j.get("isRemote") or j.get("workplaceType") == "Remote",
                              j.get("publishedAt"), j.get("jobUrl"), j.get("descriptionPlain", ""),
                              re.sub(r"(?<=[a-z])(?=[A-Z])", "-", j.get("employmentType") or "")))  # "PartTime" → "Part-Time"
    return employer_jobs(fresh_only(jobs), keep_us=True)


def lever(board, company):
    r = requests.get(f"https://api.lever.co/v0/postings/{board}?mode=json", headers=UA, timeout=30)
    r.raise_for_status()
    jobs = []
    for j in r.json():
        cats = j.get("categories") or {}
        country = {"CA": "Canada", "US": "United States"}.get(j.get("country"), j.get("country") or "")
        places = [cats.get("location", "")] + (cats.get("allLocations") or []) + [country]
        posted = datetime.fromtimestamp(j["createdAt"] / 1000, timezone.utc).isoformat() if j.get("createdAt") else ""
        jobs.append(board_job(company, j.get("text"), places, j.get("workplaceType") == "remote", posted,
                              j.get("hostedUrl"), f"{j.get('descriptionPlain', '')} {j.get('additionalPlain', '')}",
                              cats.get("commitment", "")))
    return employer_jobs(fresh_only(jobs), keep_us=True)


def smartrecruiters(company_id, company):
    r = requests.get(f"https://api.smartrecruiters.com/v1/companies/{company_id}/postings",
                     params={"country": "ca", "limit": 100}, headers=UA, timeout=30)
    r.raise_for_status()
    jobs = []
    for j in r.json().get("content", []):
        loc = j.get("location") or {}
        places = [", ".join(x for x in (loc.get("city"), loc.get("region"), "Canada") if x)]
        jobs.append(board_job(company, j.get("name"), places, loc.get("remote"), j.get("releasedDate"),
                              f"https://jobs.smartrecruiters.com/{company_id}/{j.get('id')}",
                              job_type=(j.get("typeOfEmployment") or {}).get("label", "")))
    return employer_jobs(fresh_only(jobs))


def phenom(company, base):
    """Phenom career sites embed the newest jobs in their search page; read a few pages of them."""
    jobs = []
    for start in range(0, 100, 10):
        r = requests.get(f"{base}/search-results", params={"keywords": "", "sortBy": "Most recent", "from": start},
                         headers={"User-Agent": "Mozilla/5.0 (Macintosh) Chrome/124"}, timeout=30)
        r.raise_for_status()
        i = r.text.find('"eagerLoadRefineSearch":')
        if i < 0:
            break
        data, _ = json.JSONDecoder().raw_decode(r.text, i + len('"eagerLoadRefineSearch":'))
        batch = (data.get("data") or {}).get("jobs") or []
        for j in batch:
            jobs.append(board_job(company, j.get("title"), [j.get("cityStateCountry") or j.get("location") or ""],
                                  False, (j.get("postedDate") or "").replace(".000+0000", "+00:00"),
                                  f"{base}/job/{j.get('jobSeqNo') or j.get('jobId')}", j.get("descriptionTeaser", "")))
        if len(batch) < 10 or posted_time(jobs[-1]["posted"] if jobs[-1] else "") is None \
                or posted_time(jobs[-1]["posted"]) < now() - timedelta(hours=SEARCH_HOURS):
            break
    return employer_jobs(fresh_only(jobs))


def bc_public_service():
    """BC Public Service postings (about 100, all pages), tech roles only."""
    jobs = []
    for page in range(1, 5):
        r = requests.get(f"https://bcpublicservice.hua.hrsmart.com/hr/ats/JobSearch/viewAll/jobSearchPaginationExternal_page:{page}",
                         headers=HTML, timeout=30)
        r.raise_for_status()
        rows = re.findall(r"<tr>\s*<td>(.*?)</td>\s*<td>(\d+)</td>\s*<td><a href=\"(/hr/ats/Posting/view/\d+)\">\s*<span>(.*?)</span>"
                          r".*?</td>\s*<td>.*?</td>\s*<td>(.*?)</td>\s*<td>(.*?)</td>\s*<td>(\d+/\d+/\d{4})</td>", r.text, re.S)
        for ministry, _id, href, title, style, loc, opened in rows:
            posted = datetime.strptime(opened, "%m/%d/%Y").date().isoformat()
            jobs.append({"title": clean(title), "company": f"BC Public Service ({clean(ministry)})",
                         "location": clean(re.sub(r"<[^>]+>", " ", loc)) or "British Columbia, Canada", "posted": posted,
                         "link": "https://bcpublicservice.hua.hrsmart.com" + href, "source": "BC Public Service careers",
                         "years": None})
        if len(rows) < 25:  # not strictly newest first, so all pages are read
            break
    return employer_jobs(fresh_only(jobs), tech_only=True)


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
LOCATION_WORDS = (r"(remote|hybrid|on-?site|in[- ]office|canada|ontario|quebec|alberta|british columbia|toronto|gta|"
                  r"mississauga|ottawa|waterloo|montreal|vancouver|calgary|edmonton|winnipeg|halifax|"
                  r"[a-z .]+,\s*(on|bc|ab|qc|mb|sk|ns|nb|nl|pe))")


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

def run(quick=False):
    started = time.monotonic()
    budget = QUICK_BUDGET if quick else TIME_BUDGET
    found, stats, searches_run, lock = [], {}, {}, threading.Lock()

    def out_of_time():
        return time.monotonic() - started > budget

    def add(label, fn, *args):
        if out_of_time():
            return False
        try:
            jobs = fn(*args)
        except Exception as e:  # one blocked search shouldn't stop the rest
            log(f"  {label} {args}: {type(e).__name__}: {str(e)[:120]}")
            jobs = None
        with lock:
            stats[label] = stats.get(label, 0) + len(jobs or [])
            searches_run[label] = searches_run.get(label, 0) + 1
            found.extend(jobs or [])
        return jobs is not None

    # Canada-wide searches first (in a random order: there are more than one run can finish),
    # then city and US-remote searches, so runs that run out of time still cover everything over the day.
    city_searches = [(t, p) for p in PLACES[1:] + [US] for t in TERMS]
    random.shuffle(city_searches)
    searches = [(t, "Canada") for t in random.sample(TERMS, len(TERMS))] + city_searches

    def linkedin():
        # LinkedIn rate-limits quickly: one search at a time, a few seconds apart, Canada-wide
        # only (about 25s each), in a random order so every term is covered over a few runs.
        # It stops for this run after three failures in a row.
        failures = 0
        for term in random.sample(TERMS, len(TERMS)):
            place = "Canada"
            if failures >= 3 or out_of_time():
                break
            failures = 0 if add("LinkedIn", jobspy_search, "linkedin", term, place) else failures + 1
            time.sleep(4)

    def jobbank():
        for term in random.sample(TERMS, len(TERMS)):
            add("Job Bank", jobbank_search, term)

    def career_sites():
        # Quick runs read each site's 20 newest jobs; full runs also search every term.
        terms = [] if quick else random.sample(TERMS, min(RSS_TERMS_PER_RUN, len(TERMS)))
        queries = [(h, t) for h in CAREER_RSS for t in [""] + terms] + [(h, c) for h in GLOBAL_RSS for c in CITY_KEYWORDS]
        with ThreadPoolExecutor(max_workers=4) as rss:
            list(rss.map(lambda q: add("Employer career sites", career_rss, *q), queries))

    def employer_boards():
        with ThreadPoolExecutor(max_workers=4) as boards:
            list(boards.map(lambda b: add("Employer boards", workday_board, *b), WORKDAY))
        for b in ORACLE:
            add("Employer boards", oracle_board, *b)
        for b in PHENOM:
            add("Employer boards", phenom, *b)
        for fn in (kpmg, microsoft, ibm, bc_public_service):
            add("Employer boards", fn)

    def startup_boards():
        boards = ([(greenhouse, *b) for b in GREENHOUSE.items()] + [(ashby, *b) for b in ASHBY.items()]
                  + [(lever, *b) for b in LEVER.items()] + [(smartrecruiters, *b) for b in SMARTRECRUITERS.items()])
        with ThreadPoolExecutor(max_workers=6) as ats:
            list(ats.map(lambda b: add("Tech company boards", *b), boards))

    employer_sources = (career_sites, employer_boards, startup_boards)
    with ThreadPoolExecutor(max_workers=9) as pool:
        side = [pool.submit(f) for f in employer_sources + (() if quick else (linkedin, jobbank))]
        if not quick:
            list(pool.map(lambda q: add("Indeed (US remote)" if q[1] == US else "Indeed", jobspy_search, "indeed", *q), searches))
        for f in side:
            f.result()
    log(f"searches done in {round(time.monotonic() - started)}s: {searches_run}")
    return found, stats, searches_run


def merge(fresh):
    path = OUT / "tech.json"
    old = json.loads(path.read_text())["jobs"] if path.exists() else []
    cutoff = now() - timedelta(hours=KEEP_HOURS)
    old_years = {j["link"]: j.get("years") for j in old if j.get("years") is not None}
    old_apply = {j["link"]: j["apply"] for j in old if j.get("apply")}
    by_link, by_key = {}, {}
    for j in old + fresh:  # newer runs win
        t = posted_time(j.get("posted", ""))
        if not (j.get("link") and j.get("title") and t and t >= cutoff) or left_out(j):
            continue
        if j.get("years") is None:
            j["years"] = old_years.get(j["link"])
        if not j.get("apply") and j["link"] in old_apply:
            j["apply"] = old_apply[j["link"]]
        k = dup_key(j)
        if k in by_key and by_key[k] != j["link"]:
            kept = by_link[by_key[k]]  # same job already found on another board
            if is_employer(j) and not is_employer(kept):
                # The employer's own posting wins: applying there is faster than through a job board.
                del by_link[kept["link"]]
                j["years"] = j["years"] if j.get("years") is not None else kept.get("years")
                by_key[k] = j["link"]
                by_link[j["link"]] = j
            elif kept.get("years") is None:
                kept["years"] = j.get("years")
            continue
        by_key[k] = j["link"]
        by_link[j["link"]] = j
    return sorted(by_link.values(), key=lambda j: posted_time(j["posted"]), reverse=True)


def is_employer(j):
    return j.get("source", "").endswith(" careers")


def fill_jobbank_years(jobs, limit=300):
    """Job Bank search pages don't show experience or languages: open the postings not checked yet."""
    todo = [j for j in jobs if j["source"] == "Job Bank" and j.get("years") is None][:limit]

    def check(j):
        try:
            j["years"], j["french"], j["part_time"] = jobbank_posting(j["link"])
        except Exception as e:
            log(f"  Job Bank posting {j['link']}: {type(e).__name__}: {str(e)[:100]}")

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(check, todo))
    return len(todo)


# ── Phone alerts and health check ──────────────────────────────────────────

ALERTS_PER_RUN = 15


def alert(new_jobs):
    """Push new internship / co-op / new-grad jobs to the phone through ntfy.sh, if NTFY_TOPIC is set."""
    topic = os.environ.get("NTFY_TOPIC")
    picks = [j for j in new_jobs if EARLY.search(j["title"]) and (j.get("years") is None or j["years"] <= 1)]
    if not topic or not picks:
        return 0
    for j in picks[:ALERTS_PER_RUN]:
        try:
            requests.post("https://ntfy.sh/", timeout=15, json={
                "topic": topic, "title": f"{j['title']} · {j['company']}"[:200], "click": j["link"], "tags": ["briefcase"],
                "message": f"{j['location']} · {j['source']}" + (f" · asks {j['years']} yr" if j.get("years") is not None else "")})
        except requests.RequestException as e:
            log(f"  alert: {type(e).__name__}: {str(e)[:100]}")
    if len(picks) > ALERTS_PER_RUN:
        requests.post("https://ntfy.sh/", timeout=15, json={"topic": topic, "title": f"+{len(picks) - ALERTS_PER_RUN} more new jobs",
                                                           "message": "See the Job Scout sheet."})
    return len(picks)


# A source that finds nothing this many runs in a row fails the workflow, so GitHub emails you.
HEALTH_RUNS = 3
WATCHED = ["Indeed", "LinkedIn", "Job Bank", "Employer career sites", "Employer boards", "Tech company boards"]


def check():
    status = json.loads((OUT / "status.json").read_text())
    broken = [f"{k} ({n} runs)" for k, n in status.get("zero_streak", {}).items() if n >= HEALTH_RUNS]
    if broken:
        log("Found no jobs several runs in a row: " + ", ".join(broken))
        sys.exit(1)


def main():
    mode = (sys.argv[1:] or ["full"])[0]
    if mode == "check":
        return check()
    OUT.mkdir(exist_ok=True)
    started = now()
    old = json.loads((OUT / "status.json").read_text()) if (OUT / "status.json").exists() else {}
    last_full = posted_time(old.get("last_full") or "")
    quick = mode == "quick" or (mode == "auto" and last_full is not None
                                and (started - last_full).total_seconds() < FULL_EVERY)
    path = OUT / "tech.json"
    had_feed = path.exists()
    known = {j["link"] for j in json.loads(path.read_text())["jobs"]} if had_feed else set()
    fresh, stats, searches_run = run(quick)
    jobs = merge(fresh)
    opened = 0 if quick else fill_jobbank_years(jobs)
    jobs = [j for j in jobs if (j.get("years") or 0) <= MAX_YEARS]  # Job Bank postings' years are only known now
    updated = started.isoformat(timespec="seconds")
    jobs = [dict({k: j.get(k) for k in ("title", "company", "location", "posted", "link", "source")},
                 country=j.get("country") or "CA", years=j.get("years"),
                 **({"apply": j["apply"]} if j.get("apply") and j["apply"] != j.get("link") else {}),
                 **{k: True for k in ("french", "part_time") if j.get(k)}) for j in jobs]
    path.write_text(json.dumps({"updated": updated, "jobs": jobs}, ensure_ascii=False, indent=0))
    alerted = alert([j for j in jobs if j["link"] not in known]) if had_feed else 0

    streak = old.get("zero_streak", {})
    for label in WATCHED:
        if label in searches_run:  # only sources this kind of run searched
            streak[label] = 0 if stats.get(label) else streak.get(label, 0) + 1
    status = {"updated": updated, "mode": "quick" if quick else "full", "last_full": old.get("last_full") if quick else updated,
              "searches_run": searches_run, "found_this_run": stats, "in_feed": len(jobs),
              "us_remote_in_feed": sum(j["country"] == "US" for j in jobs),
              "quebec_in_feed": sum(bool(re.search(r"\bQC\b|qu[eé]bec|montr[eé]al", j["location"] or "", re.I)) for j in jobs),
              "french_in_feed": sum(bool(j.get("french")) for j in jobs), "part_time_in_feed": sum(bool(j.get("part_time")) for j in jobs),
              "with_years": sum(j["years"] is not None for j in jobs), "jobbank_postings_opened": opened,
              "alerts_sent": alerted, "zero_streak": streak, "seconds": round((now() - started).total_seconds())}
    (OUT / "status.json").write_text(json.dumps(status, indent=1))
    log(json.dumps(status))


if __name__ == "__main__":
    main()
