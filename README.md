# Job Scout class feed

**Students:** get the script at **[black-s1k.github.io/jobscout-feed](https://black-s1k.github.io/jobscout-feed/)** and follow the **[setup guide](https://black-s1k.github.io/jobscout-feed/guide.html)** (also in [SETUP.md](SETUP.md)).

<img src="qr.png" alt="QR code for the script page" width="140">

Fresh job postings for the Job Scout Google Sheet, updated every 10 minutes by GitHub Actions.

Google's servers are blocked by Indeed and Job Bank, and a sheet can only check a few hundred company pages in its 6-minute limit, so this repo collects them instead and publishes one IT feed, `feed/tech.json`: every IT role anywhere in Canada (Quebec included), internship to mid level, including jobs that do IT work under other names (implementation, onboarding, customer success, technical account, field service, POS, CRM/ERP…) and French titles. What counts as IT is in [`it_roles.py`](it_roles.py). The Job Scout sheet reads the file and applies its own filters for level, work style, location and freshness.

## Sources

| Source | How | Where |
| --- | --- | --- |
| Indeed Canada | [JobSpy](https://github.com/speedyapply/JobSpy) | Canada-wide, plus Toronto, Montréal, Ottawa, Waterloo, Vancouver, Calgary, Edmonton, Québec City, Winnipeg and Halifax |
| LinkedIn | JobSpy | Canada-wide (LinkedIn allows about 15 searches a run, so terms rotate between runs) |
| Indeed (United States) | JobSpy, "<term> remote" | Fully remote US jobs only, marked `"country": "US"`; a sheet drops them unless its Work style allows remote jobs anywhere |
| Job Bank | Its search pages, newest first | All provinces and territories |
| Employer career sites | SuccessFactors RSS | Rogers, Bell, TELUS, Scotiabank, Deloitte, EY, SAP, Celestica, Hydro One, OPG, Toronto Hydro, Canada Post, Purolator, Bombardier, CMHC, City of Toronto, IESO, TransAlta, U of T, Halton Region… |
| Employer hiring systems | Workday, Oracle, Phenom and their own job APIs, narrowed to Canada | Banks, insurers and pension funds (RBC, TD, CIBC, BMO, Desjardins, Manulife, Sun Life, Intact, iA, OMERS, HOOPP…), the Big 4, KPMG, Microsoft, IBM, OpenText, NVIDIA, Salesforce, Cisco, Ciena, CAE, Canadian Tire, automotive, utilities, hospitals, pharma, BC Public Service |
| Tech companies | Greenhouse, Ashby, Lever, SmartRecruiters | About 130 Canadian and big tech employers (their Canadian and fully remote US jobs) |

The full lists are at the top of [`feed.py`](feed.py). Employer jobs come from the company's own hiring system, usually before they reach LinkedIn or Indeed.

## Rules

- **IT only**, every field: [`it_roles.py`](it_roles.py). Automotive, utility and health employers need a plainly technical title.
- **Internship to mid level:** senior, lead, manager and executive titles are dropped (unless the title is also a student role), and so are jobs whose description asks for more than 5 years of experience. Each job carries `years`: the most years its description asks for, or `null`.
- **Kept, but marked:** French-language jobs (`"french": true` when the description requires French) and part-time jobs (`"part_time": true`).
- **Duplicates:** the same job on several boards (same company, title and city) is kept once, and the employer's own link wins over a job board's. `apply` holds the employer's application page when Indeed or LinkedIn give it.
- Searches ask for jobs posted in the last 48 hours; jobs stay in the feed for 3 days.

## Schedule

One workflow run updates the feed every 10 minutes for about 5 hours, then starts the next run itself: a **full run** (every source, about 9 minutes) every 30 minutes, and a **quick run** (employers' own boards, about 1 minute) in between. A cron every 6 hours restarts the chain if it ever stops. If a source finds nothing 3 runs in a row, the run fails and GitHub emails you. `feed/status.json` has the counts from the latest run.

**Phone alerts (optional):** add a repo secret `NTFY_TOPIC` and subscribe to that channel name in the [ntfy](https://ntfy.sh) app to get new internship, co-op and new-grad jobs on your phone. Anyone who knows the name can read it, so keep it private.

**Free:** public repos get unlimited GitHub Actions minutes.

**Run it yourself:** `pip install -r requirements.txt`, then `python feed.py` (`quick` for employer boards only).

Sources, employer lists, de-duplication and the years-of-experience reader are adapted from [sagarh12/canada-jobs-feed](https://github.com/sagarh12/canada-jobs-feed) (MIT License, © 2026 Sagarpreet Hooda).
