# Job Scout class feed

**Students:** get the script at **[black-s1k.github.io/jobscout-feed](https://black-s1k.github.io/jobscout-feed/)** and follow the **[setup guide](https://black-s1k.github.io/jobscout-feed/guide.html)** (also in [SETUP.md](SETUP.md)).

<img src="qr.png" alt="QR code for the script page" width="140">

Fresh job postings for the Job Scout Google Sheet, refreshed every 30 minutes by GitHub Actions.

Google's servers are blocked by Indeed and Job Bank, so this repo collects them instead and publishes one IT feed, `feed/tech.json`: every IT role, entry to mid level, including jobs that do IT work under other names (implementation, onboarding, customer success, technical account, field service, POS, CRM/ERP…). What counts as IT is in [`it_roles.py`](it_roles.py). The Job Scout sheet reads the file and applies its own filters for level, work style, location and freshness.

`feed/status.json` shows when the feed last updated and how many jobs each board returned.

**Sources:** Indeed Canada and LinkedIn (through [JobSpy](https://github.com/speedyapply/JobSpy)), and Government of Canada Job Bank. Searches are around Toronto, ON (80 km), posted in the last 24 hours, plus SuccessFactors career sites (Rogers, Bell, TELUS, Hydro One, OPG, Toronto Hydro, Bombardier…). Jobs stay in the feed for 48 hours.

**Free:** public repos get unlimited GitHub Actions minutes. If GitHub pauses the schedule after 60 days without activity, open the **Actions** tab and turn the workflow back on.

**Run it yourself:** `pip install -r requirements.txt`, then `python feed.py` (or `python feed.py "help desk"` to test one search).
