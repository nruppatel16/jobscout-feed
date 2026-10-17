/**
 * @OnlyCurrentDoc  — the script can only touch this one spreadsheet.
 *
 * Job Scout — Google Sheets template (free, no installs, no coding)
 *
 * Finds new job postings as early as possible and only keeps fresh ones.
 *
 * Paste this whole file into Extensions → Apps Script of a blank Google Sheet,
 * save, reload the sheet, then use the "Job Scout" menu → "Set up tabs".
 *
 * Sources (each one optional):
 *   1. Company careers pages — straight from the hiring system, usually before
 *      LinkedIn/Indeed: Greenhouse, Lever, Ashby, SmartRecruiters, Workday.
 *      Any other careers page works through Firecrawl (free key).
 *      Picking a field adds 20–40 verified Canadian employers to Companies.
 *   2. LinkedIn public search, Amazon jobs and Randstad Canada (no sign-up).
 *      The class job feed adds Indeed, LinkedIn and Job Bank, scraped on GitHub.
 *   3. Remote job boards     — RemoteOK, Remotive, Jobicy, Himalayas.
 *   4. Job-alert emails      — LinkedIn / Indeed / Glassdoor / ZipRecruiter /
 *                              Workday alerts in a Gmail label.
 *   5. Apify                 — LinkedIn job search, past-24h only (free credit).
 *   6. Adzuna                — job-search API covering every field (free key).
 *   7. Webhook               — anything else can POST jobs in, e.g. the JobSpy
 *                              GitHub Action in the github-action/ folder.
 *
 * Staying fresh:
 *   • Every job needs a real posting date newer than "Max job age (hours)".
 *     Greenhouse uses first_published (not updated_at, which old reposts bump).
 *   • Pages with no dates (Firecrawl) use a baseline: the first check only
 *     remembers what's there; later checks add just the new links.
 *   • Jobs that vanish from a company's full list are marked Closed.
 *   • Old rows are deleted after "Delete jobs older than (days)".
 *
 * Everything a student changes lives in the Settings and Companies tabs.
 * Placeholders look like {{THIS}} and count as empty until filled in.
 */

const TABS = { jobs: 'Jobs', fresh: 'Fresh 24h', companies: 'Companies', settings: 'Settings', seen: '_seen' };

const JOB_HEADERS = ['Posted', 'Company', 'Title', 'Location', 'Source', 'Link', 'Found', 'Status', 'Notes'];
const COL = Object.fromEntries(JOB_HEADERS.map((h, i) => [h, i + 1]));
const STATUSES = ['New', 'Applied', 'Not interested', 'Closed'];

const COMPANY_HEADERS = ['Company', 'Careers link (any job link from their careers site)', 'Detected as', 'Last check', 'Added by'];

// Every IT role, entry to mid level — including the many jobs that do IT work
// without "IT" in the title (implementation, onboarding, customer success, field
// service, POS, CRM/ERP…). Same lists as the job agent's src/it_roles.py:
// a title is IT if it names none of HARD_EXCLUDE, and either a STRONG_IT word,
// or an IT_KEYWORDS word and none of NON_IT.
const STRONG_IT = [".net", "active directory", "ai", "analytics", "android", "angular", "api", "application", "application support", "applications", "artificial intelligence", "aws", "azure", "back end", "back-end", "backend", "bi", "blockchain", "business intelligence", "c#", "cloud", "coder", "computer", "computer vision", "crm", "cyber", "cybersecurity", "data", "data center", "data centre", "database", "dba", "deskside", "desktop support", "developer", "devops", "devsecops", "dynamics 365", "embedded", "end user", "erp", "etl", "euc", "firmware", "front end", "front-end", "frontend", "full stack", "full-stack", "fullstack", "game developer", "gameplay", "gcp", "golang", "google workspace", "help desk", "helpdesk", "i.t.", "implementation", "informatics", "information security", "information systems", "information technology", "infosec", "infrastructure", "integration", "intune", "ios", "iot", "it", "it support", "java", "javascript", "kubernetes", "linux", "llm", "m365", "machine learning", "microsoft 365", "ml", "mlops", "mobile app", "mobile developer", "network", "networking", "nlp", "noc", "node.js", "office 365", "oracle", "penetration", "pentest", "power apps", "power bi", "power platform", "pre-sales", "presales", "programmer", "python", "qa", "quality assurance", "react", "rpa", "saas", "sales engineer", "salesforce", "sap", "sdet", "service desk", "servicenow", "sharepoint", "site reliability", "soc analyst", "software", "software tester", "solutions engineer", "sql", "sre", "sysadmin", "systems administrator", "systems analyst", "tableau", "tech support", "technical account", "technical support", "technology", "telecom", "telecommunications", "terraform", "test automation", "typescript", "uipath", "unity developer", "unix", "web developer", "workday"];
const IT_KEYWORDS = [".net", "active directory", "administrator", "agile", "ai", "analytics", "android", "angular", "api", "application", "application support", "applications", "architect", "artificial intelligence", "atlassian", "audio visual", "automation", "av technician", "aws", "azure", "back end", "back-end", "backend", "bi", "blockchain", "business analyst", "business intelligence", "business systems", "c#", "cabling", "client success", "client support", "cloud", "coder", "computer", "computer vision", "configuration", "crm", "customer success", "customer support", "cyber", "cybersecurity", "data", "data center", "data centre", "database", "dba", "deskside", "desktop support", "developer", "developer relations", "devops", "devrel", "devsecops", "digital", "digital transformation", "documentation", "dynamics 365", "e-commerce", "ecommerce", "embedded", "end user", "endpoint", "engineer", "erp", "etl", "euc", "field service", "firmware", "forensics", "front end", "front-end", "frontend", "full stack", "full-stack", "fullstack", "functional consultant", "game developer", "gameplay", "gcp", "gis", "golang", "google workspace", "grc", "hardware", "help desk", "helpdesk", "i.t.", "iam", "identity", "implementation", "incident response", "informatics", "information security", "information systems", "information technology", "infosec", "infrastructure", "integration", "intune", "ios", "iot", "it", "it coordinator", "it support", "java", "javascript", "jira", "kubernetes", "linux", "llm", "m365", "machine learning", "mdm", "microsoft 365", "ml", "mlops", "mobile", "mobile app", "mobile developer", "network", "networking", "nlp", "noc", "node.js", "office 365", "onboarding", "onsite support", "operations analyst", "oracle", "penetration", "pentest", "platform", "pos", "power apps", "power bi", "power platform", "pre-sales", "presales", "privacy", "product analyst", "product manager", "product owner", "product specialist", "product support", "professional services", "programmer", "python", "qa", "quality assurance", "react", "reporting", "robotics", "rpa", "saas", "sales engineer", "salesforce", "sap", "scientist", "scrum", "sdet", "security", "service desk", "servicenow", "sharepoint", "shopify", "site reliability", "soc analyst", "software", "software tester", "solution", "solutions", "solutions engineer", "sql", "sre", "support", "sysadmin", "system", "systems", "systems administrator", "systems analyst", "tableau", "tech", "tech support", "technical", "technical account", "technical support", "technical trainer", "technical writer", "technician", "technologist", "technology", "telecom", "telecommunications", "terraform", "test", "test automation", "tester", "testing", "threat", "tier 1", "tier 2", "tier 3", "typescript", "ui", "uipath", "unity developer", "unix", "user experience", "user interface", "ux", "voip", "vulnerability", "web", "web developer", "webmaster", "wireless", "wordpress", "workday"];
const NON_IT = ["accountant", "accounting", "administrative assistant", "administrative support", "aerodynamic", "aerospace", "aircraft", "automotive", "avionics", "banking advisor", "barista", "bartender", "beauty", "beauty advisor", "biologist", "biology", "bookkeeper", "branch", "broadcast", "building", "caregiver", "carpenter", "chef", "chemical", "chemist", "chemistry", "chiropractor", "civil", "claims", "client advisor", "communications", "concierge", "construction", "cook", "cosmetic", "counsellor", "courier", "crane", "delivery", "dental", "dentist", "doctor", "driver", "drug", "early childhood", "ece", "educator", "electrical", "electrical engineer", "electrician", "engineering technician", "environmental", "equipment operator", "executive assistant", "financial advisor", "financial planner", "fire", "fire alarm", "fitness", "flight", "fly-by-wire", "food", "food server", "geotechnical", "hair", "heavy equipment", "housekeeping", "hr generalist", "human resources", "hvac", "hygiene", "hygienist", "industrial engineer", "instructional", "insurance advisor", "investment advisor", "journalist", "kitchen", "lab", "lab technician", "laboratory", "landscape", "landscaper", "law clerk", "lawyer", "leasing", "legal", "lifeguard", "machinist", "mailroom", "maintenance", "manufacturing engineer", "marketing", "mechanic", "mechanical", "medical laboratory", "merchandiser", "millwright", "mining", "mortgage", "music", "nail", "ndt", "nurse", "nursing", "office assistant", "operating engineer", "optician", "painter", "paralegal", "paramedic", "pastor", "payroll", "petroleum", "pharmacist", "pharmacy", "phlebotomist", "physician", "physiotherapist", "plumber", "power engineer", "process engineer", "program", "real estate", "realtor", "receptionist", "recruiter", "restaurant server", "retail", "rn", "roofer", "rpn", "sales advisor", "sales associate", "social media", "social worker", "spa", "stability", "stationary engineer", "store", "storytelling", "structural", "talent acquisition", "tax", "teacher", "teller", "theatre", "therapist", "trade support", "truck", "tutor", "underwriter", "veterinary", "warehouse", "welder", "youth worker"];
const HARD_EXCLUDE = ["cashier", "cleaner", "custodian", "data entry", "dishwasher", "forklift", "general labour", "housekeeper", "janitor", "laborer", "labourer", "loss prevention", "material handler", "nanny", "packer", "personal support", "personal support worker", "picker", "professor", "psw", "security guard", "security officer - patrol", "support worker"];

const IT_FIELD = 'IT (every role)';
const FIELDS = {
  [IT_FIELD]: {
    keywords: '',
    search: 'software developer | data analyst | IT support | help desk | technical support | business analyst | cloud engineer | cybersecurity analyst | QA analyst | implementation specialist | network administrator | systems administrator',
    companies: [
      ['Cohere', 'https://jobs.ashbyhq.com/cohere'], ['Faire', 'https://boards.greenhouse.io/faire'],
      ['D2L', 'https://boards.greenhouse.io/d2l'], ['Wattpad', 'https://jobs.lever.co/wattpad'],
      ['Wealthsimple', 'https://jobs.ashbyhq.com/wealthsimple'], ['Autodesk', 'https://autodesk.wd1.myworkdayjobs.com/Ext'],
      ['TD Bank', 'https://td.wd3.myworkdayjobs.com/TD_Bank_Careers'], ['BMO', 'https://bmo.wd3.myworkdayjobs.com/External'],
      ['CIBC (students)', 'https://cibc.wd3.myworkdayjobs.com/campus'], ['RBC', 'https://rbc.wd3.myworkdayjobs.com/RBCGLOBAL1'],
      ['Sun Life', 'https://sunlife.wd3.myworkdayjobs.com/Experienced-Jobs'], ['EQ Bank', 'https://jobs.lever.co/eqbank'],
    ],
  },
};

// More employers, verified live (Sept 30 2026): mostly-Canadian boards that post
// often. Picking a field adds the ones tagged with it (Any field adds them all).
// tags: tech, finance, health, business, eng, edu
const DIRECTORY_VERSION = 5;
const DIRECTORY = [
  ['CIBC', 'https://cibc.wd3.myworkdayjobs.com/search', 'finance tech business'],
  ['RBC (students)', 'https://rbc.wd3.myworkdayjobs.com/rbcearlytalent1', 'finance tech business'],
  ['Sun Life (students)', 'https://sunlife.wd3.myworkdayjobs.com/Campus', 'finance tech'],
  ['iA Financial', 'https://ia.wd3.myworkdayjobs.com/professional', 'finance'],
  ['Beneva', 'https://beneva.wd10.myworkdayjobs.com/benevasite_carriere', 'finance'],
  ['Raymond Chabot Grant Thornton', 'https://rcgt.wd3.myworkdayjobs.com/External', 'finance'],
  ['Momentum Financial', 'https://boards.greenhouse.io/momentumfinancialservicesgroup', 'finance'],
  ['Neo Financial', 'https://jobs.ashbyhq.com/neofinancial', 'finance tech'],
  ['Relay', 'https://jobs.ashbyhq.com/relayfi', 'finance tech'],
  ['University Health Network', 'https://jobs.smartrecruiters.com/UniversityHealthNetwork', 'health edu'],
  ['Southlake Health', 'https://southlake.wd10.myworkdayjobs.com/Southlake', 'health edu'],
  ['Spectrum Health Care', 'https://jobs.smartrecruiters.com/SpectrumHealthCare', 'health'],
  ['TELUS Health', 'https://lifeworks.wd3.myworkdayjobs.com/External', 'health business'],
  ['Alimentiv', 'https://jobs.lever.co/alimentiv-2', 'health'],
  ['Fullscript', 'https://jobs.lever.co/fullscript', 'health tech'],
  ['UBC', 'https://ubc.wd10.myworkdayjobs.com/ubcstaffjobs', 'edu'],
  ['Algonquin College', 'https://algonquincollege.wd3.myworkdayjobs.com/CareerOpportunities', 'edu'],
  ['NAV CANADA', 'https://navcanada.wd10.myworkdayjobs.com/NAV_Careers', 'edu eng'],
  ['OLG', 'https://olg.wd3.myworkdayjobs.com/Careers', 'edu business'],
  ['CHEO', 'https://cheo.wd10.myworkdayjobs.com/External_Site', 'health edu'],
  ['Halton Healthcare', 'https://jobs.smartrecruiters.com/HaltonHealthcare1', 'health edu'],
  ["St. Joseph's Healthcare Hamilton", 'https://stjoes.wd10.myworkdayjobs.com/STJOESHAM', 'health edu'],
  ['Extendicare', 'https://extendicare.wd10.myworkdayjobs.com/Extendicare2023', 'health'],
  ['Loblaw / Shoppers Drug Mart', 'https://myview.wd3.myworkdayjobs.com/careers', 'health business'],
  ['HOOPP', 'https://hoopp.wd10.myworkdayjobs.com/HOOPP', 'finance'],
  ['HOOPP (students)', 'https://hoopp.wd10.myworkdayjobs.com/HOOPPStudent', 'finance'],
  ['Teleperformance', 'https://onetp.wd1.myworkdayjobs.com/Teleperformance', 'business'],
  ['Roofmart', 'https://iko.wd3.myworkdayjobs.com/roofmart_careers', 'business'],
  ['Swarovski', 'https://swarovski.wd3.myworkdayjobs.com/swarovski', 'business'],
  ['Interac', 'https://interac.wd3.myworkdayjobs.com/Interac', 'business finance tech'],
  ['AB InBev Canada', 'https://abinbev.wd1.myworkdayjobs.com/CAN', 'business'],
  ['Harry Rosen', 'https://harry.wd10.myworkdayjobs.com/hri', 'business'],
  ['Intelcom', 'https://intelcomgroup.wd3.myworkdayjobs.com/Intelcom', 'business'],
  ['407 ETR', 'https://407etr.wd3.myworkdayjobs.com/407_ETR_Careers', 'business eng'],
  ['McKesson Canada', 'https://mckesson.wd3.myworkdayjobs.com/External_Careers', 'health business'],
  ['Foresters Financial', 'https://foresters.wd3.myworkdayjobs.com/ForestersFinancialCareers', 'finance tech'],
  ['Fidelity Canada', 'https://fil.wd3.myworkdayjobs.com/fidelitycanada', 'finance tech'],
  ['Lumentum', 'https://lumentum.wd5.myworkdayjobs.com/LITE', 'eng tech'],
  ['Best Buy Canada', 'https://bestbuycanada.wd3.myworkdayjobs.com/BestBuyCA_Career', 'business tech'],
  ['LCBO', 'https://lcbo.wd3.myworkdayjobs.com/LCBOCareerSite', 'business edu'],
  ['Pet Valu', 'https://petvalu.wd3.myworkdayjobs.com/External_Career_Site_Pet_Valu_Canada', 'business'],
  ['Reitmans', 'https://jobs.smartrecruiters.com/ReitmansCanadaLteLtd', 'business'],
  ['Choice Properties', 'https://myview.wd3.myworkdayjobs.com/Choice_Properties_REIT', 'business finance'],
  ['QuadReal', 'https://quadreal.wd10.myworkdayjobs.com/quadreal', 'business eng'],
  ['RioCan', 'https://jobs.lever.co/riocan', 'business'],
  ['Sleeman Breweries', 'https://sleeman.wd3.myworkdayjobs.com/SBL', 'business'],
  ['Capital Auto Group', 'https://capitalauto.wd3.myworkdayjobs.com/capitalautogroupcareers', 'business'],
  ['HelloFresh', 'https://boards.greenhouse.io/hellofresh', 'business tech'],
  ['DEPT', 'https://boards.greenhouse.io/dept', 'business tech'],
  ['VML Canada', 'https://boards.greenhouse.io/vmlcanadaen', 'business'],
  ['Directive', 'https://jobs.ashbyhq.com/directive', 'business'],
  ['AtkinsRéalis', 'https://slihrms.wd3.myworkdayjobs.com/Careers', 'eng'],
  ['Hydro Ottawa', 'https://hydroottawa.wd3.myworkdayjobs.com/hydro_ottawa_careersite', 'eng edu'],
  ['Enbridge', 'https://enbridge.wd3.myworkdayjobs.com/enbridge_careers', 'eng'],
  ['Cenovus', 'https://cenovus.wd3.myworkdayjobs.com/careers', 'eng'],
  ['Ledcor', 'https://ledcor.wd3.myworkdayjobs.com/Ledcor_External', 'eng'],
  ['Finning', 'https://finning.wd3.myworkdayjobs.com/External', 'eng'],
  ['IKO', 'https://iko.wd3.myworkdayjobs.com/IKO_Careers', 'eng'],
  ['Airbus', 'https://ag.wd3.myworkdayjobs.com/Airbus', 'eng'],
  ['Ontario Transit Group', 'https://jobs.smartrecruiters.com/OntarioTransitGroup', 'eng'],
  ['DIALOG', 'https://jobs.lever.co/dialogdesign', 'eng'],
  ['Flynn Group', 'https://jobs.lever.co/flynncompanies', 'eng'],
  ['Kepler Communications', 'https://jobs.lever.co/kepler', 'eng tech'],
  ['Tenstorrent', 'https://boards.greenhouse.io/tenstorrent', 'tech eng'],
  ['OpenTable', 'https://boards.greenhouse.io/opentable', 'tech'],
  ['Geotab', 'https://boards.greenhouse.io/geotab', 'tech'],
  ['Ada', 'https://boards.greenhouse.io/ada18', 'tech'],
  ['Quadbridge', 'https://boards.greenhouse.io/quadbridge', 'tech'],
  ['Jonas Software', 'https://talentmanagementsolution.wd3.myworkdayjobs.com/JonasSoftwareCanada', 'tech'],
  ['Waabi', 'https://jobs.lever.co/waabi', 'tech'],
  ['ShyftLabs', 'https://jobs.lever.co/shyftlabs', 'tech'],
  ['Xsolla', 'https://jobs.lever.co/xsolla', 'tech'],
  ['VO2 Group', 'https://jobs.lever.co/vo2-group', 'tech'],
  ['Achievers', 'https://jobs.lever.co/achievers', 'tech'],
  ['Emburse', 'https://jobs.lever.co/emburse', 'tech'],
  ['1Password', 'https://jobs.ashbyhq.com/1password', 'tech'],
  ['Jobber', 'https://jobs.ashbyhq.com/jobber', 'tech'],
  ['Super.com', 'https://jobs.ashbyhq.com/super.com', 'tech'],
  ['Venn', 'https://jobs.ashbyhq.com/venn', 'tech'],
  ['Beacon Software', 'https://jobs.ashbyhq.com/beaconsoftware', 'tech'],
  ['QA Consultants', 'https://jobs.smartrecruiters.com/QAConsultants', 'tech'],
  ['Ubisoft', 'https://jobs.smartrecruiters.com/Ubisoft2', 'tech'],
];
const FIELD_TAGS = { [IT_FIELD]: 'tech' };

// The field's starter pack plus every directory employer tagged with the field.
function fieldEmployers(field) {
  const pack = FIELDS[field] ? FIELDS[field].companies : [];
  const tag = FIELD_TAGS[field];
  const more = DIRECTORY.filter(([, , tags]) => !tag || tags.split(' ').includes(tag)).map(([n, l]) => [n, l]);
  return pack.concat(more);
}

// Your level + one above it are kept. Titles with no level words are always kept.
const LEVELS = ['Co-op / Internship', 'New grad / Entry level', 'Junior / Intermediate (1–3 yrs)'];
const LINKEDIN_EXPERIENCE = ['1,2', '2,3', '3,4', '4,5']; // LinkedIn f_E: 1 intern, 2 entry, 3 associate, 4 mid-senior, 5 director

// Co-op and entry jobs are mostly in person, so remote jobs are opt-in.
const WORK_STYLES = ['In person or hybrid', 'In person, hybrid, or remote within Canada', 'Anything, including remote anywhere'];
const LINKEDIN_WORKPLACE = ['1,3', '', '']; // LinkedIn f_WT: 1 on-site, 2 remote, 3 hybrid

const PROVINCES = { ON: 'Ontario', BC: 'British Columbia', AB: 'Alberta', QC: 'Quebec', MB: 'Manitoba', SK: 'Saskatchewan',
  NS: 'Nova Scotia', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', PE: 'Prince Edward Island', NT: 'Northwest Territories', YT: 'Yukon', NU: 'Nunavut' };

const SETTINGS_ROWS = [
  ['Setting', 'Value', 'What to put here / where to get it'],
  ['Last refresh', '', 'Filled in automatically after every refresh.'],
  ['— 1. START HERE —', '', ''],
  ['Your level', 'New grad / Entry level', 'Jobs at your level and one level above are kept: New grad / Entry level also gets Junior / Intermediate (mid) jobs. Senior, lead, manager, director and executive jobs are always dropped. Titles with no level in them (e.g. "Help Desk Analyst") are kept.'],
  ['Work style', WORK_STYLES[0], 'In person or hybrid = no remote jobs. The middle option allows remote jobs only if they are open to Canada. The last one allows remote jobs from anywhere.'],
  ['Your province', 'ON', 'Two letters: ON, BC, AB, QC … Used for the Job Bank search. Blank = all of Canada.'],
  ['Locations', 'Toronto, Ontario', "Places you'd work, comma-separated (e.g. Toronto, Mississauga, Ontario). A job is kept only if its location mentions one (ON counts as Ontario). Add Canada to accept jobs anywhere in Canada. Remote jobs are controlled by Work style."],
  ['Job keywords', '', 'Optional extra title words to accept on top of the built-in list of every IT role (comma-separated).'],
  ['Exclude keywords', '',
    'Optional extra words to skip (comma-separated). Your level already removes jobs that are too senior.'],
  ['— 2. FRESHNESS & VARIETY —', '', ''],
  ['Max job age (hours)', '24', 'Only jobs posted within this many hours are added. 24 = only the last day, 48 = relaxed.'],
  ['Delete jobs older than (days)', '14', 'Old rows are removed unless their Status is Applied. 0 = never delete.'],
  ['Max new jobs per company per refresh', '10', "Stops one big employer from flooding your list. The rest arrive on later refreshes."],
  ['— 3. FREE SOURCES (NO SIGN-UP) —', '', ''],
  ['LinkedIn public search', 'yes', 'yes / no — searches LinkedIn job listings (no account needed) with your field, level and province. The biggest free source.'],
  ['Class job feed', 'yes', "yes / no — Indeed, LinkedIn and Job Bank jobs for your field, collected every 30 minutes by the class scraper on GitHub. Those sites block Google's servers, so the scraper fetches them for you."],
  ['Amazon & Randstad Canada', 'yes', "yes / no — Amazon's own job site and Randstad Canada (a staffing agency with thousands of Canadian jobs: office, accounting, warehouse, trades). Both show jobs the minute they're posted."],
  ['Eluta.ca search', 'no', "yes / no — Canadian jobs collected straight from employer websites. Off by default: Eluta usually blocks Google's servers."],
  ['Job Bank search', 'no', "Government of Canada Job Bank (every field). Off by default because it usually blocks Google's servers. To try it, type searches separated with |, e.g. accountant | bank teller."],
  ['Remote job boards', 'no', 'yes / no — RemoteOK, Remotive, Jobicy and Himalayas. Only used when Work style allows remote jobs.'],
  ['Job alert Gmail label', 'job-alerts', 'The Gmail label your LinkedIn / Indeed alert emails go into (see the Gmail filter step). Blank = skip.'],
  ['Find new companies automatically', 'yes',
    'yes / no — each refresh looks up employers from the jobs it found and adds the ones with a readable careers page to the Companies tab.'],
  ['— 4. OPTIONAL ADD-ONS (FREE SIGN-UP) —', '', ''],
  ['Apify token', '{{Get your key → https://console.apify.com/settings/integrations}}',
    'Optional. Click the link, sign up (free), copy "Personal API token" and paste it here. Adds LinkedIn search results. Sign up: https://console.apify.com/sign-up'],
  ['Apify LinkedIn keywords', '', 'Filled in with IT searches. What to search LinkedIn for. Separate searches with |.'],
  ['Apify LinkedIn location', 'Toronto, Ontario, Canada', 'Where to search LinkedIn.'],
  ['Apify check every (minutes)', '60', 'Each check uses credit. 60 keeps you inside the free credit.'],
  ['Apify max results per search', '25', 'Lower = cheaper.'],
  ['Firecrawl API key', '{{Get your key → https://www.firecrawl.dev/app/api-keys}}',
    "Optional. Click the link, sign up (free), copy your API key (starts with fc-) and paste it here. Lets the Companies tab read careers pages that aren't on a supported job system."],
  ['Firecrawl check every (hours)', '6', 'Each page check uses credits. 6 hours keeps 10 companies inside the free credits.'],
  ['Adzuna app ID', '{{Get your key → https://developer.adzuna.com/admin/access_details}}',
    'Optional. Sign up free at https://developer.adzuna.com/signup, then the link shows your "Application ID". Paste it here. Job search across every field.'],
  ['Adzuna app key', '{{Same page → copy "Application Key"}}', 'Optional. On the same Adzuna page, copy "Application Key" and paste it here.'],
  ['Adzuna country', 'ca', 'Two-letter code: ca, us, gb, au, in, de, fr …'],
  ['Adzuna search', '', 'Filled in with IT searches. Separate searches with |.'],
  ['Adzuna location', 'Toronto', 'One city or region. Blank = whole country.'],
  ['— 5. NOTIFICATIONS & ADVANCED —', '', ''],
  ['Email me new jobs', 'yes', 'yes / no — an email after each refresh that finds new jobs.'],
  ['Send job emails to', '', 'Optional. Email address(es) for the new-job emails, comma-separated. Blank = the Google account that owns this sheet. The sheet itself is not shared with them.'],
  ['Webhook secret', '{{Advanced — type any long random phrase}}', 'Advanced: any long random phrase. Lets outside scrapers (like the JobSpy GitHub Action) send jobs in.'],
];

const REMOTE_BOARDS = {
  RemoteOK: {
    url: 'https://remoteok.com/api',
    parse: d => (Array.isArray(d) ? d : []).filter(j => j.position).map(j => ({
      company: j.company, title: j.position, location: remoteLabel(j.location), posted: j.date, link: j.url,
    })),
  },
  Remotive: {
    url: 'https://remotive.com/api/remote-jobs?limit=100',
    parse: d => (d.jobs || []).map(j => ({
      company: j.company_name, title: j.title, location: remoteLabel(j.candidate_required_location),
      posted: /[zZ]|[+-]\d\d:?\d\d$/.test(j.publication_date) ? j.publication_date : j.publication_date + 'Z', link: j.url,
    })),
  },
  Jobicy: {
    url: 'https://jobicy.com/api/v2/remote-jobs?count=50',
    parse: d => (d.jobs || []).map(j => ({
      company: j.companyName, title: j.jobTitle, location: remoteLabel(j.jobGeo), posted: j.pubDate, link: j.url,
    })),
  },
  Himalayas: {
    url: 'https://himalayas.app/jobs/api?limit=100',
    parse: d => (d.jobs || []).map(j => ({
      company: j.companyName, title: j.title, location: remoteLabel((j.locationRestrictions || []).join(', ')),
      posted: j.pubDate, link: j.applicationLink,
    })),
  },
};

const APIFY_ACTOR = 'curious_coder~linkedin-jobs-scraper';
const MAX_RUN_MS = 4.5 * 60 * 1000; // Apps Script stops a run at 6 minutes

// ── Menu & setup ───────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Job Scout')
    .addItem('Set up tabs', 'setupSheet')
    .addItem('Add IT employers + searches', 'applyFieldFromSettings')
    .addSeparator()
    .addItem('Refresh jobs now', 'refreshJobs')
    .addSeparator()
    .addItem('Turn auto-refresh ON (every 15 min)', 'autoRefreshOn')
    .addItem('Turn auto-refresh OFF', 'autoRefreshOff')
    .addSeparator()
    .addItem('Clear all jobs (start over)', 'clearAllJobs')
    .addToUi();
  // Create the tabs automatically, so pressing Run in the editor (which runs
  // onOpen) or simply reloading the sheet is enough.
  try { setupSheet(true); } catch (e) { console.warn(`Auto setup skipped: ${e.message}`); }
}

// Fills in the IT searches (where still blank) and adds the IT employers to Companies.
function applyFieldFromSettings() {
  applyField(IT_FIELD);
}

function applyField(field) {
  const pack = FIELDS[IT_FIELD];
  const raw = readRawSettings();
  const fill = (name, value) => {
    const cur = String(raw[name] || '').trim();
    if (!cur || cur.startsWith('{{')) writeSetting(name, value);
  };
  fill('Job Bank search', pack.search);
  fill('Apify LinkedIn keywords', pack.search);
  fill('Adzuna search', pack.search);
  const added = addCompanies(fieldEmployers(IT_FIELD).map(([name, link]) => [name, link, 'IT starter pack']));
  PropertiesService.getDocumentProperties().setProperty('directoryVersion', String(DIRECTORY_VERSION));
  SpreadsheetApp.getActive().toast(
    `IT searches filled in${added ? ` and ${added} employers added to Companies` : ''}. Now use Job Scout → Refresh jobs now.`, 'Job Scout', 10);
}

// Appends [name, link, addedBy] rows whose link (or board) isn't in Companies yet. Returns how many were added.
function addCompanies(rows) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TABS.companies);
  if (!sheet || !rows.length) return 0;
  const last = sheet.getLastRow();
  const existing = last > 1 ? sheet.getRange(2, 1, last - 1, 2).getValues() : [];
  const keyOf = link => { const b = detectBoard(link); return b ? `${b.type}:${String(b.id).toLowerCase()}` : String(link).toLowerCase(); };
  const seen = new Set(existing.filter(r => r[1]).map(r => keyOf(r[1])));
  const out = [];
  rows.forEach(([name, link, by]) => {
    const k = keyOf(link);
    if (seen.has(k)) return;
    seen.add(k);
    out.push([name, link, '', '', by]);
  });
  if (!out.length) return 0;
  // Fill the first blank row after the header/placeholder rows.
  let row = last + 1;
  sheet.getRange(row, 1, out.length, COMPANY_HEADERS.length).setValues(out);
  return out.length;
}

// Empties the Jobs list and the "seen" memory, e.g. before sharing the template or re-running a demo.
function clearAllJobs() {
  const ss = SpreadsheetApp.getActive();
  [ss.getSheetByName(TABS.jobs), ss.getSheetByName(TABS.seen)].forEach(s => {
    if (s && s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, s.getLastColumn()).clearContent();
  });
  const c = ss.getSheetByName(TABS.companies);
  if (c && c.getLastRow() > 1) c.getRange(2, 3, c.getLastRow() - 1, 2).clearContent();
  writeSetting('Last refresh', '');
  const props = PropertiesService.getDocumentProperties();
  Object.keys(props.getProperties()).forEach(k => {
    const blockedPause = /^due:(eluta|jobbank)$/.test(k) && Number(props.getProperty(k)) > Date.now();
    if (!blockedPause) props.deleteProperty(k);
  });
  ss.toast('Cleared. Use Job Scout → Refresh jobs now to start fresh.', 'Job Scout', 8);
}

function setupSheet(quiet) {
  const ss = SpreadsheetApp.getActive();
  const missing = Object.values(TABS).some(name => !ss.getSheetByName(name));

  let j = ss.getSheetByName(TABS.jobs);
  if (!j) {
    j = ss.insertSheet(TABS.jobs, 0);
    j.getRange(1, 1, 1, JOB_HEADERS.length).setValues([JOB_HEADERS]).setFontWeight('bold');
    j.setFrozenRows(1);
    j.setColumnWidth(COL.Posted, 150).setColumnWidth(COL.Title, 320).setColumnWidth(COL.Link, 260).setColumnWidth(COL.Found, 150);
    j.getRange(2, COL.Status, j.getMaxRows() - 1, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build());
    const all = j.getRange(2, 1, j.getMaxRows() - 1, JOB_HEADERS.length);
    j.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$H2="Closed"')
        .setFontColor('#9AA0A6').setStrikethrough(true).setRanges([all]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER($A2), NOW()-$A2<=1)')
        .setBackground('#E6F4EA').setRanges([j.getRange(2, COL.Posted, j.getMaxRows() - 1, 1)]).build(),
    ]);
  }

  let f = ss.getSheetByName(TABS.fresh);
  if (!f) {
    f = ss.insertSheet(TABS.fresh, 1);
    f.getRange(1, 1, 1, JOB_HEADERS.length).setValues([JOB_HEADERS]).setFontWeight('bold');
    f.setFrozenRows(1);
    f.getRange('A2').setFormula(
      `=IFERROR(SORT(FILTER('${TABS.jobs}'!A2:I, ISNUMBER('${TABS.jobs}'!A2:A), NOW()-'${TABS.jobs}'!A2:A<=1, '${TABS.jobs}'!H2:H<>"Closed"), 1, FALSE), "No jobs posted in the last 24 hours yet — try Job Scout → Refresh jobs now")`);
    f.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm');
    f.getRange('G:G').setNumberFormat('yyyy-mm-dd hh:mm');
    f.setColumnWidth(1, 150).setColumnWidth(3, 320).setColumnWidth(6, 260);
  }

  let c = ss.getSheetByName(TABS.companies);
  if (!c) {
    c = ss.insertSheet(TABS.companies);
    c.getRange(1, 1, 1, COMPANY_HEADERS.length).setValues([COMPANY_HEADERS]).setFontWeight('bold');
    c.getRange(2, 1, 1, COMPANY_HEADERS.length).setValues([[
      '{{ADD YOUR OWN}}', '{{Click any job on a careers site and paste its link here}}', '', '',
      'Employers fill in automatically when you pick your field in Settings']]);
    c.setColumnWidth(1, 220).setColumnWidth(2, 460).setColumnWidth(3, 150).setColumnWidth(4, 300).setColumnWidth(5, 260);
    c.setFrozenRows(1);
  }

  let s = ss.getSheetByName(TABS.settings);
  if (!s) {
    s = ss.insertSheet(TABS.settings);
    s.getRange(1, 1, SETTINGS_ROWS.length, 3).setValues(SETTINGS_ROWS);
    s.getRange('A1:C1').setFontWeight('bold');
    SETTINGS_ROWS.forEach((r, i) => { if (r[0].startsWith('—')) s.getRange(i + 1, 1).setFontWeight('bold'); });
    s.setColumnWidth(1, 240).setColumnWidth(2, 420).setColumnWidth(3, 560);
    s.getRange('B:C').setWrap(true);
    s.setFrozenRows(1);
  } else {
    syncSettings(s);
  }
  applySettingsDropdowns(s);
  linkifySettings(s);

  let seen = ss.getSheetByName(TABS.seen);
  if (!seen) {
    seen = ss.insertSheet(TABS.seen);
    seen.getRange(1, 1, 1, 3).setValues([['Source', 'Link', 'First seen']]);
    seen.hideSheet();
  }

  if (missing) {
    ss.setActiveSheet(j);
    ss.toast('Tabs ready. Go to Settings → pick "Your field", then Job Scout → Refresh jobs now.', 'Job Scout', 10);
  } else if (quiet !== true) {
    ss.toast('Tabs are already set up. Use Job Scout → Refresh jobs now.', 'Job Scout', 8);
  }
}

// ── Settings ───────────────────────────────────────────────────────────────

function settingsRow(sheet, key) {
  const keys = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(r => String(r[0]).trim());
  return keys.indexOf(key) + 1;
}

function dropdown(list) {
  return SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(true).build();
}

function applySettingsDropdowns(sheet) {
  const set = (key, list, highlight) => {
    const row = settingsRow(sheet, key);
    if (!row) return;
    const cell = sheet.getRange(row, 2).setDataValidation(dropdown(list));
    if (highlight) cell.setBackground('#FFF4CE').setFontWeight('bold');
  };
  set('Your level', LEVELS, true);
  set('Work style', WORK_STYLES, true);
  set('Your province', Object.keys(PROVINCES));
}

// Keeps an existing Settings tab up to date with this version of the script:
// refreshes help text, replaces untouched placeholders, adds missing settings at the end.
function syncSettings(sheet) {
  // Settings this version no longer has (the field pickers): remove their rows.
  ['Your subfield', 'Your field'].forEach(key => { const row = settingsRow(sheet, key); if (row) sheet.deleteRow(row); });
  SETTINGS_ROWS.slice(1).forEach(([key, value, help], i) => {
    if (key.startsWith('—')) return;
    const row = settingsRow(sheet, key);
    if (!row) {
      // New setting: insert it right after the setting that comes before it.
      const prevKey = SETTINGS_ROWS.slice(1, i + 1).map(r => r[0]).reverse().find(k => settingsRow(sheet, k));
      const after = prevKey ? settingsRow(sheet, prevKey) : sheet.getLastRow();
      sheet.insertRowAfter(after);
      sheet.getRange(after + 1, 1, 1, 3).setValues([[key, value, help]]);
      return;
    }
    const cur = sheet.getRange(row, 2, 1, 2).getValues()[0];
    const v = String(cur[0]).trim();
    if (v.startsWith('{{') && v !== value) sheet.getRange(row, 2).setValue(value);
    if (String(cur[1]) !== help) sheet.getRange(row, 3).setValue(help);
  });
}

// Makes every https:// address in the Settings value/help columns clickable.
function linkifySettings(sheet) {
  const last = sheet.getLastRow();
  const vals = sheet.getRange(1, 2, last, 2).getValues();
  vals.forEach((row, i) => row.forEach((text, j) => {
    const t = String(text);
    const re = /https?:\/\/[^\s}]+/g;
    if (!re.test(t)) return;
    re.lastIndex = 0;
    const b = SpreadsheetApp.newRichTextValue().setText(t);
    let m;
    while ((m = re.exec(t))) b.setLinkUrl(m.index, m.index + m[0].length, m[0]);
    sheet.getRange(i + 1, j + 2).setRichTextValue(b.build());
  }));
}

function readRawSettings() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TABS.settings);
  if (!sheet) throw new Error('Run Job Scout → Set up tabs first.');
  const raw = {};
  sheet.getDataRange().getValues().slice(1).forEach(([k, v]) => { raw[String(k).trim()] = String(v).trim(); });
  return raw;
}

function readSettings() {
  const raw = {};
  Object.entries(readRawSettings()).forEach(([k, v]) => { raw[k] = v.startsWith('{{') ? '' : v; });
  const field = IT_FIELD;
  const pack = FIELDS[IT_FIELD];
  const levelIdx = LEVELS.indexOf(raw['Your level']);
  const styleIdx = Math.max(WORK_STYLES.indexOf(raw['Work style']), 0);
  const searches = (s, dflt) => (/^no$/i.test(s || '') ? '' : (s || dflt || '')).split('|').map(x => x.trim()).filter(Boolean);
  const list = (s, sep = ',') => (s || '').split(sep).map(x => x.trim().toLowerCase()).filter(Boolean);
  const num = (s, dflt) => (s === '' || s === undefined || isNaN(Number(s)) ? dflt : Number(s));
  const yes = s => /^y/i.test(s || '');
  return {
    field,
    province: (raw['Your province'] || '').toUpperCase().slice(0, 2),
    level: levelIdx, // -1 = not set: no level filtering (only Exclude keywords)
    workStyle: styleIdx, // 0 in person/hybrid · 1 + remote in Canada · 2 anything
    keywords: list(raw['Job keywords']), // extra words on top of the built-in IT lists
    exclude: list(raw['Exclude keywords']),
    locations: list(raw['Locations']).filter(l => !/^(remote|anywhere|hybrid|wfh|work from home)$/.test(l)),
    maxAgeHours: Math.max(num(raw['Max job age (hours)'], 24), 1),
    pruneDays: num(raw['Delete jobs older than (days)'], 14),
    remoteBoards: yes(raw['Remote job boards']),
    alertLabel: raw['Job alert Gmail label'],
    jobBankSearches: searches(raw['Job Bank search'], raw['Job Bank search'] === undefined ? '' : pack.search),
    discover: raw['Find new companies automatically'] === undefined ? true : yes(raw['Find new companies automatically']),
    linkedin: raw['LinkedIn public search'] === undefined ? true : yes(raw['LinkedIn public search']),
    eluta: raw['Eluta.ca search'] === undefined ? true : yes(raw['Eluta.ca search']),
    classFeed: raw['Class job feed'] === undefined ? true : yes(raw['Class job feed']),
    bigEmployers: raw['Amazon & Randstad Canada'] === undefined ? true : yes(raw['Amazon & Randstad Canada']),
    searches: searches('', pack.search),
    perCompany: Math.max(num(raw['Max new jobs per company per refresh'], 10), 1),
    apifyToken: raw['Apify token'],
    apifyKeywords: searches(raw['Apify LinkedIn keywords'], pack.search),
    apifyLocation: raw['Apify LinkedIn location'],
    apifyEveryMin: Math.max(num(raw['Apify check every (minutes)'], 60), 15),
    apifyMax: Math.max(num(raw['Apify max results per search'], 25), 1),
    firecrawlKey: raw['Firecrawl API key'],
    firecrawlEveryHours: Math.max(num(raw['Firecrawl check every (hours)'], 6), 1),
    adzunaId: raw['Adzuna app ID'],
    adzunaKey: raw['Adzuna app key'],
    adzunaCountry: (raw['Adzuna country'] || 'ca').toLowerCase(),
    adzunaSearches: searches(raw['Adzuna search'], pack.search),
    adzunaWhere: raw['Adzuna location'],
    emailMe: yes(raw['Email me new jobs']),
    webhookSecret: raw['Webhook secret'],
  };
}

function writeSetting(name, value) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TABS.settings);
  const keys = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(r => String(r[0]).trim());
  const i = keys.indexOf(name);
  if (i >= 0) sheet.getRange(i + 1, 2).setValue(value);
}

// ── Refresh ────────────────────────────────────────────────────────────────

function refreshJobs() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // another refresh is still running
  try {
    const started = Date.now();
    const cfg = readSettings();
    const errors = [];
    const counts = [];
    const found = [];
    const collect = (label, fn) => {
      if (Date.now() - started > MAX_RUN_MS) { errors.push(`${label}: skipped, out of time`); return; }
      const t0 = Date.now();
      try {
        const jobs = fn();
        found.push(...jobs);
        counts.push(`${label} ${jobs.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
      } catch (e) {
        errors.push(`${label}: ${e.message}`);
      }
    };

    // Sheets made before the employer directory grew get the new employers once.
    const props = PropertiesService.getDocumentProperties();
    if (FIELDS[cfg.field] && props.getProperty('directoryVersion') !== String(DIRECTORY_VERSION)) {
      addCompanies(fieldEmployers(cfg.field).map(([name, link]) => [name, link, `${cfg.field} starter pack`]));
      props.setProperty('directoryVersion', String(DIRECTORY_VERSION));
    }
    // The default window went from 48 to 24 hours; sheets still on the old default follow it once.
    if (!props.getProperty('window24')) {
      if (String(readRawSettings()['Max job age (hours)']).trim() === '48') { writeSetting('Max job age (hours)', 24); cfg.maxAgeHours = 24; }
      props.setProperty('window24', '1');
    }

    let complete = {};
    collect('company pages', () => {
      const r = fetchCompanyBoards(cfg, errors, started);
      complete = r.complete;
      return r.jobs;
    });
    if (cfg.linkedin && linkedinSearches(cfg).length) collect('LinkedIn', () => fetchLinkedInGuest(cfg, errors, started));
    if (cfg.classFeed && FEED_FILES[cfg.field]) collect('class feed', () => fetchClassFeed(cfg, errors));
    if (cfg.bigEmployers) collect('Amazon', () => fetchAmazon(cfg, errors));
    if (cfg.bigEmployers) collect('Randstad', () => fetchRandstad(cfg, errors, started));
    if (cfg.eluta && linkedinSearches(cfg).length) collect('Eluta', () => fetchEluta(cfg, errors));
    if (cfg.jobBankSearches.length) collect('Job Bank', () => fetchJobBank(cfg, errors));
    if (cfg.remoteBoards && cfg.workStyle > 0) collect('remote boards', () => fetchRemoteBoards(errors));
    if (cfg.alertLabel) collect('alert emails', () => fetchAlertEmails(cfg));
    if (cfg.apifyToken && cfg.apifyKeywords.length) collect('Apify LinkedIn', () => fetchApify(cfg, errors));
    if (cfg.adzunaId && cfg.adzunaKey) cfg.adzunaSearches.forEach(q => collect(`Adzuna "${q}"`, () => fetchAdzuna(cfg, q)));

    const result = saveJobs(found, cfg, complete);
    if (cfg.emailMe && result.added.length) emailSummary(result.added);

    let discovered = 0;
    const td = Date.now();
    if (cfg.discover && Date.now() - started < MAX_RUN_MS - 60e3) {
      try { discovered = discoverCompanies(found, cfg, started); } catch (e) { errors.push(`finding companies: ${e.message}`); }
    }
    counts.push(`company lookup (${Math.round((Date.now() - td) / 1000)}s)`);

    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    let summary = `${stamp} · ${result.added.length} new in ${Math.round((Date.now() - started) / 1000)}s · checked: ${counts.join(', ') || 'nothing'}`;
    if (result.closed) summary += ` · ${result.closed} closed`;
    if (result.pruned) summary += ` · ${result.pruned} old removed`;
    if (discovered) summary += ` · ${discovered} new companies added to Companies`;
    if (errors.length) summary += `\nProblems: ${errors.join(' | ')}`;
    writeSetting('Last refresh', summary);
    SpreadsheetApp.getActive().toast(
      `${result.added.length} new job(s).${errors.length ? ' Some sources had problems — see Settings → Last refresh.' : ''}`, 'Job Scout', 8);
    return result;
  } finally {
    lock.releaseLock();
  }
}

// Filters, de-duplicates and writes jobs. Shared by refreshJobs and doPost.
function saveJobs(found, cfg, completeLists) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TABS.jobs);
  const now = new Date();
  const cutoff = now.getTime() - cfg.maxAgeHours * 3600e3;

  const lastRow = sheet.getLastRow();
  const rows = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, JOB_HEADERS.length).getValues().filter(r => r.some(v => v !== ''))
    : [];
  const links = new Set(rows.map(r => String(r[COL.Link - 1])));
  const pairs = new Set(rows.map(r => pairKey(r[COL.Company - 1], r[COL.Title - 1], r[COL.Location - 1])));

  // Undated jobs only count as new if they weren't there on the previous check.
  const dated = [];
  const undated = [];
  found.forEach(j => {
    j.link = canonicalJobLink(String(j.link || '').trim()) || String(j.link || '').trim();
    if (toDate(j.posted) || j.freshBySearch) dated.push(j);
    else if (j.sourceKey) undated.push(j);
  });
  const candidates = dated.concat(newSinceLastCheck(undated, now));
  cfg.foreignCompanies = foreignCompanies(found, cfg);

  const added = [];
  const perCompany = {};
  for (const job of candidates) {
    job.title = cleanText(job.title);
    job.company = cleanText(job.company);
    job.location = cleanText(job.location);
    if (!job.title || !/^https?:\/\//i.test(job.link)) continue;
    const posted = toDate(job.posted) || now;
    if (posted.getTime() < cutoff || posted.getTime() > now.getTime() + 36e5 * 26) continue;
    if (!passesFilters(job, cfg)) continue;
    const pair = pairKey(job.company, job.title, job.location);
    if (links.has(job.link) || (job.company && pairs.has(pair))) continue;
    const ck = normName(job.company);
    if (ck && (perCompany[ck] = (perCompany[ck] || 0) + 1) > (cfg.perCompany || 1e9)) continue;
    links.add(job.link);
    if (job.company) pairs.add(pair);
    job.posted = posted > now ? now : posted;
    added.push(job);
  }

  // Mark jobs that disappeared from a company's full list; drop old rows.
  let closed = 0;
  let pruned = 0;
  const pruneBefore = now.getTime() - cfg.pruneDays * 864e5;
  const keep = [];
  for (const r of rows) {
    const status = String(r[COL.Status - 1]);
    const listed = completeLists && completeLists[`${r[COL.Company - 1]}|${r[COL.Source - 1]}`];
    if (listed && !listed.has(String(r[COL.Link - 1])) && (status === '' || status === 'New')) {
      r[COL.Status - 1] = 'Closed';
      closed++;
    }
    const when = toDate(r[COL.Posted - 1]) || toDate(r[COL.Found - 1]);
    if (cfg.pruneDays > 0 && when && when.getTime() < pruneBefore && String(r[COL.Status - 1]) !== 'Applied') {
      pruned++;
      continue;
    }
    keep.push(r);
  }

  const all = added.map(j => {
    const row = new Array(JOB_HEADERS.length).fill('');
    row[COL.Posted - 1] = j.posted;
    row[COL.Company - 1] = j.company;
    row[COL.Title - 1] = j.title;
    row[COL.Location - 1] = j.location;
    row[COL.Source - 1] = j.source;
    row[COL.Link - 1] = j.link;
    row[COL.Found - 1] = now;
    row[COL.Status - 1] = 'New';
    return row;
  }).concat(keep);
  // Newest posting first across the whole list, not just this refresh's batch.
  const postedTime = r => (toDate(r[COL.Posted - 1]) || toDate(r[COL.Found - 1]) || new Date(0)).getTime();
  all.sort((a, b) => postedTime(b) - postedTime(a));

  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, JOB_HEADERS.length).clearContent();
  if (all.length) {
    if (sheet.getMaxRows() < all.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), all.length + 1 - sheet.getMaxRows());
    sheet.getRange(2, 1, all.length, JOB_HEADERS.length).setValues(all);
    sheet.getRange(2, COL.Posted, all.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(2, COL.Found, all.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }
  return { added, closed, pruned };
}

function passesFilters(job, cfg) {
  if (matchesAny(job.title, cfg.exclude)) return false;
  if (!levelFits(job.title, cfg.level)) return false;
  if (!workStyleFits(job, cfg)) return false;
  if (job.preFiltered) return true; // searched at the source with the student's own terms
  if (!isItRole(job.title) && !(cfg.keywords.length && matchesAny(job.title, cfg.keywords))) return false;
  // Remote jobs were already judged by Work style above.
  if (job.location && cfg.locations.length && !isRemoteJob(job)) {
    const place = placeText(job.location);
    const here = cfg.locations.some(l => place.includes(l));
    if (!here && (!locationUnclear(job.location) || isForeignPlace(job.location))) return false;
    // "7 Locations" etc.: keep only if this employer's other jobs are mostly near you.
    if (!here && cfg.foreignCompanies && cfg.foreignCompanies.has(normName(job.company))) return false;
  }
  return true;
}

function isRemoteJob(job) {
  const t = `${job.location || ''} ${job.title || ''}`;
  if (/\bhybrid\b/i.test(t)) return false;
  return /\bremote\b|work from home|\bwfh\b|telecommute|anywhere|distributed team/i.test(t);
}

// Remote jobs: dropped (0), allowed only when open to your places in Canada (1), or allowed (2).
function workStyleFits(job, cfg) {
  if (!isRemoteJob(job)) return true;
  if (cfg.workStyle >= 2) return true;
  if (cfg.workStyle === 1) {
    const loc = placeText(job.location);
    return cfg.locations.some(l => loc.includes(l)) || /\bcanada\b/.test(loc);
  }
  return false;
}

// Employers whose clearly-located jobs are mostly outside your locations. Their vague
// locations ("2 Locations", "Jakarta") are dropped; local employers' vague ones are kept.
function foreignCompanies(jobs, cfg) {
  const stats = {};
  jobs.forEach(j => {
    if (!j.location || locationUnclear(j.location) || !cfg.locations.length) return;
    const k = normName(j.company);
    const st = (stats[k] = stats[k] || { clear: 0, local: 0 });
    st.clear++;
    if (cfg.locations.some(l => String(j.location).toLowerCase().includes(l))) st.local++;
  });
  // Not clearly local: under 60% of the jobs we can place are near you.
  return new Set(Object.keys(stats).filter(k => stats[k].local / stats[k].clear < 0.6));
}

// 0 student/co-op · 1 entry · 2 intermediate · 3 senior/manager · 4 executive · null = no level words.
function titleLevel(title) {
  // Customer-facing IT roles called "manager" aren't people managers (same rule as the job agent).
  const t = String(title || '').replace(/\b(customer success|client success|technical account|account) manager\b/ig, '$1 specialist');
  const has = re => re.test(t);
  if (has(/\b(chief|ceo|cfo|cto|coo|cio|cmo|president|vp|svp|evp|founder|co-founder|owner|partner|director|head of|general manager|managing director)\b/i)) return 4;
  const num = (t.match(/\b(?:engineer|developer|analyst|scientist|specialist|consultant|designer|administrator|technician|technologist|accountant|associate|programmer|representative|advisor|officer|auditor)\s*[-–,]?\s*(?:level\s*)?([1-9])\b/i) || [])[1];
  if (has(/\b(senior|sr|lead|principal|staff|manager|supervisor|architect|superintendent|expert)\b/i) || has(/\b(III|IV|V)\b/) || has(/\blevel [3-9]\b/i) || Number(num) >= 3) return 3;
  if (has(/\b(intern|interns|internship|co-?op|coop|student|summer|apprentice|apprenticeship|work term|placement)\b/i)) return 0;
  if (has(/\b(intermediate|mid-level|experienced)\b/i) || has(/\bII\b/) || has(/\blevel 2\b/i) || num === '2') return 2;
  if (has(/\b(junior|jr|entry|entry-level|new grad|graduate|associate|assistant|trainee|clerk)\b/i) || has(/\bI\b/) || has(/\blevel 1\b/i) || num === '1') return 1;
  return null;
}

// Keep your level and one above it; titles with no level words are kept.
function levelFits(title, level) {
  if (level === undefined || level < 0) return true;
  const l = titleLevel(title);
  return l === null || (l >= level && l <= level + 1);
}

// Places outside Canada. A location naming one of these is dropped unless it's in your Locations.
const FOREIGN_PLACES = new RegExp('\\b(' + [
  'usa', 'u\\.s\\.a?', 'united states', 'america', 'united kingdom', 'uk', 'england', 'scotland', 'ireland', 'india', 'china', 'hong kong',
  'singapore', 'philippines', 'mexico', 'brazil', 'germany', 'france', 'poland', 'japan', 'australia', 'netherlands', 'spain',
  'italy', 'malaysia', 'vietnam', 'indonesia', 'colombia', 'argentina', 'costa rica', 'south africa', 'uae', 'dubai', 'israel',
  'switzerland', 'sweden', 'portugal', 'romania', 'egypt', 'pakistan', 'bangladesh', 'taiwan', 'korea', 'thailand', 'new zealand',
  'chile', 'peru', 'nigeria', 'kenya', 'emea', 'apac', 'latam', 'europe', 'asia',
  'london', 'dublin', 'new york', 'boston', 'chicago', 'san francisco', 'seattle', 'austin', 'dallas', 'houston', 'atlanta',
  'denver', 'los angeles', 'miami', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'mumbai', 'manila', 'shanghai', 'tokyo', 'sydney',
  'jakarta', 'quezon city', 'makati', 'taguig', 'cebu', 'kuala lumpur', 'ho chi minh', 'hanoi', 'bangkok', 'seoul', 'beijing',
  'shenzhen', 'taipei', 'chennai', 'noida', 'gurgaon', 'gurugram', 'kolkata', 'delhi', 'warsaw', 'krakow', 'bucharest', 'lisbon',
  'madrid', 'barcelona', 'paris', 'berlin', 'munich', 'amsterdam', 'zurich', 'stockholm', 'mexico city', 'sao paulo', 'bogota',
  'buenos aires', 'melbourne', 'auckland', 'johannesburg', 'cairo', 'riyadh', 'doha', 'tel aviv',
  'california', 'texas', 'florida', 'virginia', 'massachusetts', 'washington', 'illinois', 'georgia', 'north carolina', 'new jersey',
  'pennsylvania', 'ohio', 'michigan', 'colorado', 'arizona', 'minnesota', 'utah', 'oregon', 'tennessee', 'missouri', 'maryland',
].join('|') + ')\\b|,\\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\\b(?!\\s*,?\\s*canada)', 'i');

const CANADIAN_PLACE = /\bcanada\b|ontario|quebec|qu[ée]bec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward|yukon|nunavut|northwest territories|,\s*(on|qc|bc|ab|mb|sk|ns|nb|nl|pe|yt|nt|nu)\b|\((on|qc|bc|ab|mb|sk|ns|nb|nl|pe)\)/i;

function isForeignPlace(loc) {
  const l = String(loc || '');
  return !CANADIAN_PLACE.test(l) && FOREIGN_PLACES.test(l);
}

// "2 Locations", "Hybrid", "Centenary Site" … can't tell where these are, so keep them.
// Lower-case location with province codes spelled out: "Oakville, ON, CAN" → "oakville, ontario, canada".
// Cities alone ("Oakville, Canada") also get their province.
function placeText(loc) {
  let t = String(loc || '')
    .replace(/\b(ON|BC|AB|QC|MB|SK|NS|NB|NL|PE|NT|YT|NU)\b/g, (m, code) => `${code}, ${PROVINCES[code]}`)
    .replace(/\bCAN\b/g, 'Canada').toLowerCase();
  if (isForeignPlace(loc)) return t;
  for (const [prov, cities] of Object.entries(CITY_PROVINCE)) {
    if (!t.includes(PROVINCES[prov].toLowerCase()) && cities.test(t)) t += `, ${PROVINCES[prov].toLowerCase()}`;
  }
  return t;
}

const CITY_PROVINCE = {
  ON: /\b(toronto|north york|scarborough|etobicoke|mississauga|brampton|markham|vaughan|woodbridge|concord|richmond hill|oakville|burlington|milton|hamilton|ajax|pickering|whitby|oshawa|newmarket|aurora|thornhill|stouffville|caledon|bolton|georgetown|halton hills|guelph|kitchener|waterloo|cambridge|london|windsor|ottawa|kanata|nepean|kingston|barrie|sudbury|thunder bay|niagara|st\.? catharines|peterborough|belleville|sarnia|brantford)\b/,
  QC: /\b(montr[eé]al|laval|longueuil|gatineau|qu[eé]bec city|sherbrooke|boucherville|mont-royal|kirkland|terrebonne)\b/,
  BC: /\b(vancouver|burnaby|surrey|richmond(?! hill)|coquitlam|langley|victoria|kelowna|kamloops|nanaimo|abbotsford|langford)\b/,
  AB: /\b(calgary|edmonton|red deer|lethbridge)\b/,
  MB: /\b(winnipeg)\b/,
  SK: /\b(regina|saskatoon)\b/,
  NS: /\b(halifax|dartmouth)\b/,
};

function locationUnclear(loc) {
  const l = String(loc).trim();
  return /^\d+ locations?$/i.test(l) || /^(hybrid|on-?site|remote|multiple locations?|various)$/i.test(l) || !/[,(·/]| - /.test(l);
}

// Every IT role — see the lists at the top.
function isItRole(title) {
  if (matchesAny(title, HARD_EXCLUDE)) return false;
  if (matchesAny(title, STRONG_IT)) return true;
  return matchesAny(title, IT_KEYWORDS) && !matchesAny(title, NON_IT);
}

function matchesAny(text, words) {
  const t = String(text || '').toLowerCase();
  return words.some(w => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(t));
}

// Baseline for pages without dates: remember every link, report only links
// that appeared since the last check. The very first check reports nothing.
function newSinceLastCheck(jobs, now) {
  if (!jobs.length) return [];
  const sheet = SpreadsheetApp.getActive().getSheetByName(TABS.seen);
  const last = sheet.getLastRow();
  const seen = {};
  if (last > 1) sheet.getRange(2, 1, last - 1, 2).getValues().forEach(([k, l]) => (seen[k] = seen[k] || new Set()).add(String(l)));
  const fresh = [];
  const append = [];
  const baselined = new Set();
  jobs.forEach(j => {
    const isBaseline = !seen[j.sourceKey] || baselined.has(j.sourceKey);
    if (!seen[j.sourceKey]) { seen[j.sourceKey] = new Set(); baselined.add(j.sourceKey); }
    if (seen[j.sourceKey].has(j.link)) return;
    seen[j.sourceKey].add(j.link);
    append.push([j.sourceKey, j.link, now]);
    if (!isBaseline) fresh.push(Object.assign(j, { posted: now, source: `${j.source} (new since last check)` }));
  });
  if (append.length) sheet.getRange(last + 1, 1, append.length, 3).setValues(append);
  return fresh;
}

// ── Source 1: company careers pages ────────────────────────────────────────

// Works out the hiring system from any link a student copies off a careers site.
function detectBoard(link) {
  const u = String(link || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  let m;
  if (/greenhouse\.io/i.test(u)) {
    m = u.match(/[?&]for=([\w-]+)/i) || u.match(/greenhouse\.io\/(?:v1\/boards\/)?(?!embed\b)([\w-]+)/i);
    return m ? { type: 'greenhouse', id: m[1].toLowerCase() } : null;
  }
  if ((m = u.match(/jobs\.(eu\.)?lever\.co\/([\w.-]+)/i))) return { type: 'lever', id: m[2], eu: !!m[1] };
  if ((m = u.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i))) return { type: 'ashby', id: decodeURIComponent(m[1]) };
  if ((m = u.match(/(?:jobs|careers)\.smartrecruiters\.com\/([\w-]+)/i))) return { type: 'smartrecruiters', id: m[1] };
  if ((m = u.match(/^https?:\/\/(([\w-]+)\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/i))) {
    return { type: 'workday', id: `${m[2]}/${m[3]}`, host: m[1], tenant: m[2], site: m[3] };
  }
  return { type: 'firecrawl', id: u.split('#')[0] };
}

const BOARDS = {
  greenhouse: {
    fullList: true,
    request: c => ({ url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.id)}/jobs` }),
    parse: (d, c) => (d.jobs || []).map(j => ({
      company: c.name, title: j.title, location: j.location && j.location.name,
      posted: j.first_published, link: j.absolute_url, sourceKey: `greenhouse:${c.id}`,
    })),
  },
  lever: {
    fullList: true,
    request: c => ({ url: `https://api.${c.eu ? 'eu.' : ''}lever.co/v0/postings/${encodeURIComponent(c.id)}?mode=json` }),
    parse: (d, c) => (Array.isArray(d) ? d : []).map(j => ({
      company: c.name, title: j.text, location: j.categories && (j.categories.allLocations || [j.categories.location]).filter(Boolean).join(' / '),
      posted: j.createdAt, link: j.hostedUrl, sourceKey: `lever:${c.id}`,
    })),
  },
  ashby: {
    fullList: true,
    request: c => ({ url: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.id)}` }),
    parse: (d, c) => (d.jobs || []).filter(j => j.isListed !== false).map(j => ({
      company: c.name, title: j.title, location: j.isRemote ? `${j.location} (remote)` : j.location,
      posted: j.publishedAt, link: j.jobUrl, sourceKey: `ashby:${c.id}`,
    })),
  },
  smartrecruiters: {
    // Newest first; keep paging only while a page still has fresh jobs.
    request: (c, page) => ({ url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(c.id)}/postings?limit=100&offset=${page * 100}` }),
    parse: (d, c) => (d.content || []).map(j => ({
      company: c.name, title: j.name,
      location: j.location && (j.location.fullLocation || [j.location.city, j.location.country].filter(Boolean).join(', ')) + (j.location.remote ? ' (remote)' : j.location.hybrid ? ' (hybrid)' : ''),
      posted: j.releasedDate, link: `https://jobs.smartrecruiters.com/${c.id}/${j.id}`, sourceKey: `smartrecruiters:${c.id}`,
    })),
    next: (d, c, page, jobs, cutoff) => {
      if (page === 0) c.total = d.totalFound || 0;
      return (page + 1) * 100 < c.total && page < 4 && oldestIsFresh(jobs, cutoff)
        ? BOARDS.smartrecruiters.request(c, page + 1) : null;
    },
  },
  workday: {
    // Workday lists newest first, so reading stops at the first old page.
    request: (c, page) => ({
      url: `https://${c.host}/wday/cxs/${c.tenant}/${c.site}/jobs`,
      method: 'post', contentType: 'application/json', headers: { Accept: 'application/json' },
      payload: JSON.stringify({ appliedFacets: {}, limit: 20, offset: page * 20, searchText: '' }),
    }),
    parse: (d, c) => (d.jobPostings || []).map(j => ({
      company: c.name, title: j.title,
      location: [j.locationsText, j.remoteType].filter(Boolean).join(' · '),
      posted: workdayPosted(j.postedOn), link: `https://${c.host}/en-US/${c.site}${j.externalPath}`, sourceKey: `workday:${c.id}`,
    })),
    // Workday only reports the total on the first page (later pages say 0).
    next: (d, c, page, jobs, cutoff) => {
      if (page === 0) c.total = d.total || 0;
      return (page + 1) * 20 < c.total && page < 9 && jobs.length && oldestIsFresh(jobs, cutoff)
        ? BOARDS.workday.request(c, page + 1) : null;
    },
  },
};

function fetchCompanyBoards(cfg, errors, started) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TABS.companies);
  const cutoff = Date.now() - cfg.maxAgeHours * 3600e3;
  const complete = {};
  if (!sheet || sheet.getLastRow() < 2) return { jobs: [], complete };

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
  const companies = [];
  rows.forEach(([name, link], i) => {
    name = String(name).trim();
    link = String(link).trim();
    const row = i + 2;
    if (!name || !link || name.startsWith('{{') || link.startsWith('{{')) return;
    const board = detectBoard(link);
    if (!board) {
      sheet.getRange(row, 3, 1, 2).setValues([['—', '✗ Not a web link']]);
      return;
    }
    sheet.getRange(row, 3).setValue(board.type === 'firecrawl' ? 'other page (Firecrawl)' : board.type);
    companies.push(Object.assign(board, { name, row }));
  });

  const results = new Map(companies.map(c => [c, { jobs: [], error: '', complete: false, skipped: '' }]));
  let pending = companies.filter(c => c.type !== 'firecrawl').map(c => ({ c, page: 0, req: BOARDS[c.type].request(c, 0) }));
  for (let round = 0; pending.length && round < 10; round++) {
    const responses = fetchAllSafe(pending.map(p => Object.assign({ muteHttpExceptions: true }, p.req)));
    const next = [];
    responses.forEach((res, i) => {
      const { c, page } = pending[i];
      const r = results.get(c);
      const code = res.getResponseCode();
      if (code !== 200) {
        r.error = code === 404 ? 'not found — check the link' : code === 0 ? `couldn't reach the site (${res.error})` : `HTTP ${code}`;
        return;
      }
      let data;
      try { data = JSON.parse(res.getContentText()); } catch (e) { r.error = 'unexpected reply — check the link'; return; }
      const jobs = BOARDS[c.type].parse(data, c).map(j => Object.assign(j, { source: c.type }));
      r.jobs.push(...jobs);
      const more = BOARDS[c.type].next && Date.now() - started < MAX_RUN_MS ? BOARDS[c.type].next(data, c, page, jobs, cutoff) : null;
      if (more) next.push({ c, page: page + 1, req: more });
      else r.complete = !!BOARDS[c.type].fullList;
    });
    pending = next;
  }

  companies.filter(c => c.type === 'firecrawl').forEach(c => {
    const r = results.get(c);
    if (!cfg.firecrawlKey) { r.skipped = 'needs a Firecrawl key in Settings (or use a supported job link)'; return; }
    if (Date.now() - started > MAX_RUN_MS) { r.skipped = 'skipped, out of time'; return; }
    if (!isDue(`firecrawl:${c.id}`, cfg.firecrawlEveryHours * 60)) { r.skipped = 'waiting (checked recently)'; return; }
    try { r.jobs = fetchFirecrawl(cfg, c); } catch (e) { r.error = e.message; }
  });

  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d HH:mm');
  const jobs = [];
  companies.forEach(c => {
    const r = results.get(c);
    let status;
    if (r.error) {
      status = `✗ ${r.error}`;
      errors.push(`${c.name}: ${r.error}`);
    } else if (r.skipped) {
      status = `– ${r.skipped}`;
    } else {
      const fresh = r.jobs.filter(j => { const d = toDate(j.posted); return d && d.getTime() >= cutoff; }).length;
      status = BOARDS[c.type] && BOARDS[c.type].next
        ? `✓ ${fresh} fresh (read newest ${r.jobs.length})`
        : `✓ ${r.jobs.length} open, ${fresh} fresh`;
    }
    sheet.getRange(c.row, 4).setValue(`${stamp} ${status}`);
    if (r.complete) complete[`${c.name}|${c.type}`] = new Set(r.jobs.map(j => canonicalJobLink(j.link) || j.link));
    jobs.push(...r.jobs);
  });
  return { jobs, complete };
}

function fetchFirecrawl(cfg, c) {
  const res = UrlFetchApp.fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${cfg.firecrawlKey}` },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      url: c.id,
      onlyMainContent: true,
      maxAge: 0, // always a fresh copy of the page, never Firecrawl's cache
      formats: [{
        type: 'json',
        prompt: 'List every job opening shown on this careers page. For each: the job title, the location, the link to the job, and the posting date if the page shows one.',
        schema: {
          type: 'object',
          properties: {
            jobs: {
              type: 'array',
              items: {
                type: 'object',
                properties: { title: { type: 'string' }, location: { type: 'string' }, url: { type: 'string' }, posted: { type: 'string' } },
                required: ['title'],
              },
            },
          },
        },
      }],
    }),
  });
  const data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200 || data.success === false) {
    throw new Error(`Firecrawl: ${data.error || 'HTTP ' + res.getResponseCode()}`);
  }
  const listed = (data.data && data.data.json && data.data.json.jobs) || [];
  return listed.map(j => ({
    company: c.name, title: j.title, location: j.location,
    posted: parseLooseDate(j.posted), link: resolveUrl(j.url, c.id) || `${c.id}#${encodeURIComponent(j.title)}`,
    source: 'firecrawl', sourceKey: `firecrawl:${c.id}`,
  }));
}

// ── Source 1a: LinkedIn public job search (no account, every field) ──────
// Newest first, limited to your freshness window and level. The first refresh
// reads deeper; later ones read the newest pages only.

// Same search terms everywhere: Job Bank's if set, else the LinkedIn keywords row (filled from your field).
function linkedinSearches(cfg) {
  return cfg.jobBankSearches.length ? cfg.jobBankSearches : (cfg.apifyKeywords.length ? cfg.apifyKeywords : cfg.searches);
}

function fetchLinkedInGuest(cfg, errors, started) {
  if (!isDue('linkedin', 14)) return [];
  const props = PropertiesService.getDocumentProperties();
  const pages = props.getProperty('linkedinDone') ? 2 : 5;
  const where = PROVINCES[cfg.province] ? `${PROVINCES[cfg.province]}, Canada` : 'Canada';
  const reqs = [];
  linkedinSearches(cfg).forEach(q => {
    for (let p = 0; p < pages; p++) {
      reqs.push({
        url: 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?' + [
          `keywords=${encodeURIComponent(q)}`, `location=${encodeURIComponent(where)}`,
          `f_TPR=r${Math.min(cfg.maxAgeHours, 24 * 30) * 3600}`, 'sortBy=DD', `start=${p * 10}`,
          cfg.level >= 0 ? `f_E=${encodeURIComponent(LINKEDIN_EXPERIENCE[cfg.level])}` : '',
          LINKEDIN_WORKPLACE[cfg.workStyle] ? `f_WT=${encodeURIComponent(LINKEDIN_WORKPLACE[cfg.workStyle])}` : '',
        ].filter(Boolean).join('&'),
        muteHttpExceptions: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' },
      });
    }
  });
  const jobs = [];
  let blocked = 0;
  fetchAllSafe(reqs).forEach(res => {
    if (res.getResponseCode() !== 200) { blocked++; return; }
    parseLinkedInGuest(res.getContentText()).forEach(j => jobs.push(j));
  });
  if (blocked === reqs.length) errors.push('LinkedIn busy — will try again next refresh');
  else props.setProperty('linkedinDone', '1');
  return jobs;
}

function parseLinkedInGuest(html) {
  return String(html || '').split(/<li[\s>]/).slice(1).map(card => {
    const pick = re => decodeEntities(((card.match(re) || [])[1] || '').replace(/\s+/g, ' ').trim());
    return {
      title: pick(/base-search-card__title[^>]*>([\s\S]*?)</),
      company: pick(/base-search-card__subtitle[^>]*>[\s\S]*?>([^<]+)</) || pick(/base-search-card__subtitle[^>]*>([^<]+)</),
      location: pick(/job-search-card__location[^>]*>([^<]+)</),
      posted: localDay(pick(/datetime="([^"]+)"/)),
      link: pick(/base-card__full-link[^>]*href="([^"?]+)/) || pick(/href="(https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"?]+)/),
      source: 'LinkedIn',
    };
  }).filter(j => j.title && j.link);
}

// "2026-09-29" (a date with no time) → noon local time that day, never in the future.
function localDay(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return v;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return d > new Date() ? new Date() : d;
}

// ── Source 1c: the class job feed (Indeed, LinkedIn, Job Bank via GitHub) ──
// A scraper on GitHub Actions (github.com/black-s1k/jobscout-feed) searches the
// boards that block Google's servers and publishes one file per field.

const CLASS_FEED = 'https://raw.githubusercontent.com/black-s1k/jobscout-feed/main/feed/';
const FEED_FILES = { [IT_FIELD]: 'tech' };

function fetchClassFeed(cfg, errors) {
  const res = fetchAllSafe([{ url: `${CLASS_FEED}${FEED_FILES[cfg.field]}.json`, muteHttpExceptions: true }])[0];
  if (res.getResponseCode() !== 200) {
    errors.push(`class feed: ${res.error || 'HTTP ' + res.getResponseCode()}`);
    return [];
  }
  return (JSON.parse(res.getContentText()).jobs || []).map(j => ({
    title: j.title, company: j.company, location: j.location,
    posted: localDay(j.posted), link: j.link, source: j.source || 'class feed',
  }));
}

// ── Source 1d: Amazon and Randstad Canada (big Canadian job feeds) ─────────

// amazon.jobs — every Amazon/AWS job in Canada. Dates are days, read as local noon.
function fetchAmazon(cfg, errors) {
  const url = page => `https://amazon.jobs/en/search.json?normalized_country_code%5B%5D=CAN&sort=recent&result_limit=100&offset=${page * 100}`;
  const parse = res => {
    if (res.getResponseCode() !== 200) { errors.push(`Amazon: ${res.error || 'HTTP ' + res.getResponseCode()}`); return { jobs: [], hits: 0 }; }
    const d = JSON.parse(res.getContentText());
    return {
      hits: d.hits || 0,
      jobs: (d.jobs || []).map(j => ({
        company: 'Amazon', title: j.title, location: [j.city, PROVINCES[j.state] || j.state, 'Canada'].filter(Boolean).join(', '),
        posted: amazonDay(j.posted_date), link: `https://amazon.jobs${j.job_path}`, source: 'Amazon',
      })),
    };
  };
  const first = parse(fetchAllSafe([{ url: url(0), muteHttpExceptions: true }])[0]);
  const pages = Math.min(Math.ceil(first.hits / 100), 8);
  const rest = [];
  for (let p = 1; p < pages; p++) rest.push({ url: url(p), muteHttpExceptions: true });
  return first.jobs.concat(...fetchAllSafe(rest).map(r => parse(r).jobs));
}

function amazonDay(v) {
  const d = new Date(v);
  if (!v || isNaN(d.getTime())) return null;
  d.setHours(12, 0, 0, 0);
  return d > new Date() ? new Date() : d;
}

// Randstad Canada — the search the randstad.ca site itself uses, newest first.
// Pages are read 4 at a time until they reach jobs older than Max job age.
function fetchRandstad(cfg, errors, started) {
  const cutoff = Date.now() - cfg.maxAgeHours * 3600e3;
  const request = page => ({
    url: 'https://www.randstad.ca/api/search/search-results', method: 'post', contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({ data: {
      currentRoute: { path: '/jobs/:searchParams*', url: '/jobs/', isExact: true, params: {}, routeName: 'search' },
      currentLanguage: 'en',
      searchParams: { isInternal: false, locationData: {}, specialism: null, subSpecialism: null, jobCategory: null, page },
      cookies: { sortBy: 'date,relevancy', searchData: { originalLocation: 'https://www.randstad.ca/jobs/' } },
    } }),
  });
  const slug = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const jobs = [];
  for (let page = 1; page <= 12 && Date.now() - started < MAX_RUN_MS; page += 4) {
    let fresh = true;
    fetchAllSafe([0, 1, 2, 3].map(i => request(page + i))).forEach(res => {
      if (res.getResponseCode() !== 200) { errors.push(`Randstad: ${res.error || 'HTTP ' + res.getResponseCode()}`); fresh = false; return; }
      const hits = ((JSON.parse(res.getContentText()).searchResults || {}).hits || {}).hits || [];
      const batch = hits.map(h => {
        const s = h._source || {};
        const info = s.JobInformation || {};
        const loc = s.JobLocation || {};
        const dates = s.JobDates || {};
        const when = String(dates.DateCreatedTime || dates.DateCreated || '');
        return {
          company: 'Randstad', title: info.Title, source: 'Randstad',
          location: [loc.City, loc.Region, 'Canada'].filter(Boolean).join(', '),
          posted: /^\d{4}-\d{2}-\d{2} \d/.test(when) ? new Date(when.replace(' ', 'T') + 'Z') : when, // UTC
          link: `https://www.randstad.ca/jobs/${slug(info.Title)}_${slug(loc.City)}_${h._id}/`,
        };
      });
      jobs.push(...batch);
      if (!batch.length || !oldestIsFresh(batch, cutoff)) fresh = false;
    });
    if (!fresh) break;
  }
  return jobs;
}

// ── Source 1c: Eluta.ca (Canadian jobs from employer websites) ────────────
// Eluta shows when it last saw a job, not when it was posted, so only postings
// that are new since the previous check are added (the first check just remembers).

function fetchEluta(cfg, errors) {
  if (!isDue('eluta', 60)) return [];
  const where = PROVINCES[cfg.province] || '';
  const qs = linkedinSearches(cfg);
  const res = fetchAllSafe(qs.map(q => ({
    url: `https://www.eluta.ca/search?q=${encodeURIComponent(q)}${where ? '&l=' + encodeURIComponent(where) : ''}`,
    muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (JobScout; Google Sheets)' },
  })));
  const jobs = [];
  let failed = 0;
  res.forEach((r, i) => {
    if (r.getResponseCode() !== 200) { failed++; return; }
    parseEluta(r.getContentText()).forEach(j => jobs.push(Object.assign(j, { sourceKey: `eluta:${qs[i].toLowerCase()}` })));
  });
  if (failed === res.length) {
    backOff('eluta', 6);
    errors.push('Eluta not reachable right now — will retry in a few hours');
  }
  return jobs;
}

function parseEluta(html) {
  return String(html || '').replace(/<!--[\s\S]*?-->/g, '').split('class="organic-job').slice(1).map(b => {
    const pick = re => decodeEntities(((b.match(re) || [])[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    const path = pick(/data-url="([^"?]+)/);
    return {
      title: pick(/class="lk-job-title"[^>]*>([^<]+)</),
      company: pick(/class="[^"]*employer[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/),
      location: pick(/class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/),
      link: path ? `https://www.eluta.ca/${path}` : '',
      source: 'Eluta',
    };
  }).filter(j => j.title && j.link);
}

// ── Source 1b: Government of Canada Job Bank (free, every field) ──────────

// Job Bank rate-limits busy callers, so be gentle: one search per refresh, rotating
// through your searches, at most every 30 minutes. A busy reply just means "try later".
function fetchJobBank(cfg, errors) {
  if (!isDue('jobbank', 30)) return [];
  const props = PropertiesService.getDocumentProperties();
  const n = Number(props.getProperty('jobbankNext') || 0);
  const q = cfg.jobBankSearches[n % cfg.jobBankSearches.length];
  props.setProperty('jobbankNext', String(n + 1));
  const res = fetchAllSafe([{
    url: 'https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed?sort=D&searchstring=' + encodeURIComponent(q)
      + (PROVINCES[cfg.province] ? `&fprov=${cfg.province}` : ''),
    muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (JobScout; Google Sheets)' },
  }])[0];
  if (res.getResponseCode() !== 200) {
    backOff('jobbank', 6);
    errors.push('Job Bank not reachable right now — will retry in a few hours');
    return [];
  }
  return parseJobBankFeed(res.getContentText()); // an empty reply just means no new jobs
}

function parseJobBankFeed(xml) {
  return String(xml || '').split('<entry>').slice(1).map(e => {
    const pick = re => ((e.match(re) || [])[1] || '').trim();
    const title = decodeEntities(pick(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/));
    const where = pick(/Location:<\/strong>\s*([^<]+)</).replace(/\s+/g, ' ');
    return {
      title: title.charAt(0).toUpperCase() + title.slice(1),
      company: decodeEntities(pick(/Employer:<\/strong>\s*([^<]+)</)),
      location: where ? where.replace(/\s*\((\w\w)\)/g, (m, p) => `, ${PROVINCES[p] || p};`).replace(/;\s*$/, '').replace(/;/g, ' ·') + ', Canada' : 'Canada',
      posted: pick(/<updated>([^<]+)<\/updated>/),
      link: pick(/<link[^>]*href="([^"]+)"/),
      source: 'Job Bank',
    };
  }).filter(j => j.title && j.link);
}

// ── Finding new companies automatically ───────────────────────────────────
// 1. Any job whose link is already on a supported careers system → add that employer.
// 2. Employer names from other sources → try the likely Greenhouse / Lever / Ashby /
//    SmartRecruiters address; keep it if it has jobs in your locations.
// The first run looks up many names; later runs top up a few (Google limits daily fetches).

function discoverCompanies(found, cfg, started) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TABS.companies);
  if (!sheet) return 0;
  const last = sheet.getLastRow();
  const rows = last > 1 ? sheet.getRange(2, 1, last - 1, 5).getValues() : [];
  const knownNames = new Set(rows.map(r => normName(r[0])));
  const firstRun = !rows.some(r => /auto-found/.test(String(r[4])));
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d');
  const toAdd = [];

  // 1. Links that point straight at a careers system.
  found.forEach(j => {
    const b = detectBoard(j.link);
    if (!b || b.type === 'firecrawl' || !j.company || knownNames.has(normName(j.company))) return;
    knownNames.add(normName(j.company));
    toAdd.push([j.company, boardHomeUrl(b), `auto-found ${stamp} (from job links)`]);
  });

  // 2. Guess careers systems from employer names we haven't tried before.
  const seenSheet = SpreadsheetApp.getActive().getSheetByName(TABS.seen);
  const seenLast = seenSheet.getLastRow();
  const tried = new Set(seenLast > 1 ? seenSheet.getRange(2, 1, seenLast - 1, 2).getValues()
    .filter(r => r[0] === 'company-lookup').map(r => String(r[1])) : []);
  const limit = firstRun ? 30 : 8;
  const names = [];
  found.forEach(j => {
    const n = normName(j.company);
    if (n.length < 3 || knownNames.has(n) || tried.has(n) || names.some(x => x.n === n)) return;
    names.push({ n, name: cleanText(j.company) });
  });
  const batch = names.slice(0, limit);
  if (batch.length && Date.now() - started < MAX_RUN_MS - 45e3) {
    const probes = [];
    batch.forEach(c => slugGuesses(c.name).forEach(slug => ['greenhouse', 'lever', 'ashby', 'smartrecruiters'].forEach(type =>
      probes.push({ c, board: { type, id: slug, name: c.name } }))));
    const responses = fetchAllSafe(probes.map(p => Object.assign({ muteHttpExceptions: true }, BOARDS[p.board.type].request(p.board, 0))));
    const hit = new Map();
    responses.forEach((res, i) => {
      const { c, board } = probes[i];
      if (hit.has(c.n) || res.getResponseCode() !== 200) return;
      let jobs = [];
      try { jobs = BOARDS[board.type].parse(JSON.parse(res.getContentText()), board); } catch (e) { return; }
      const local = jobs.filter(j => !cfg.locations.length || !j.location || locationUnclear(j.location)
        || cfg.locations.some(l => String(j.location).toLowerCase().includes(l)));
      if (local.length) hit.set(c.n, [c.name, boardHomeUrl(board), `auto-found ${stamp} (${local.length} jobs near you)`]);
    });
    hit.forEach(row => toAdd.push(row));
    const now = new Date();
    seenSheet.getRange(seenLast + 1, 1, batch.length, 3).setValues(batch.map(c => ['company-lookup', c.n, now]));
  }
  return addCompanies(toAdd);
}

function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(inc|ltd|llc|corp|corporation|co|limited|plc|gmbh|canada|group|the)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
}

function slugGuesses(name) {
  const words = String(name).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w && !/^(inc|ltd|llc|corp|corporation|co|limited|the)$/.test(w));
  const joined = words.join('');
  return [joined].filter(s => s && s.length >= 3);
}

function boardHomeUrl(b) {
  return {
    greenhouse: `https://boards.greenhouse.io/${b.id}`,
    lever: `https://jobs.${b.eu ? 'eu.' : ''}lever.co/${b.id}`,
    ashby: `https://jobs.ashbyhq.com/${b.id}`,
    smartrecruiters: `https://jobs.smartrecruiters.com/${b.id}`,
    workday: `https://${b.host}/${b.site}`,
  }[b.type];
}

// ── Source 2: remote job boards ────────────────────────────────────────────

function fetchRemoteBoards(errors) {
  const names = Object.keys(REMOTE_BOARDS);
  const responses = fetchAllSafe(names.map(n => ({
    url: REMOTE_BOARDS[n].url, muteHttpExceptions: true, headers: { 'User-Agent': 'JobScout/1.0 (Google Sheets)' },
  })));
  const jobs = [];
  responses.forEach((res, i) => {
    const name = names[i];
    if (res.getResponseCode() !== 200) { errors.push(`${name}: ${res.error || 'HTTP ' + res.getResponseCode()}`); return; }
    try {
      REMOTE_BOARDS[name].parse(JSON.parse(res.getContentText())).forEach(j => jobs.push(Object.assign(j, { source: name })));
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  });
  return jobs;
}

function remoteLabel(where) {
  const w = String(where || '').trim();
  return w && !/^(anywhere|worldwide|remote)$/i.test(w) ? `Remote · ${w}` : 'Remote · Anywhere';
}

// ── Source 3: job-alert emails ─────────────────────────────────────────────

function fetchAlertEmails(cfg) {
  const days = Math.max(Math.ceil(cfg.maxAgeHours / 24), 1);
  const threads = GmailApp.search(`label:${cfg.alertLabel.replace(/\s+/g, '-')} newer_than:${days}d`, 0, 100);
  const jobs = [];
  threads.forEach(t => t.getMessages().forEach(m => {
    const sender = m.getFrom().replace(/<.*>/, '').replace(/"/g, '').trim();
    parseAlertEmail(m.getBody()).forEach(j => jobs.push(Object.assign(j, {
      posted: m.getDate(), source: `email: ${sender}`, preFiltered: true,
    })));
  }));
  return jobs;
}

// Pulls job links (and their visible titles) out of an alert email's HTML.
function parseAlertEmail(html) {
  const skip = /^(view|apply|see|easy apply|view job|view jobs|see all|see more|unsubscribe|manage|job alert|search|save)\b/i;
  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const byLink = new Map();
  let m;
  while ((m = anchor.exec(html))) {
    const link = canonicalJobLink(decodeEntities(m[1]));
    if (!link) continue;
    const lines = htmlToText(m[2]).split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const text = lines.find(l => l.length >= 4 && l.length <= 150 && !skip.test(l));
    const job = byLink.get(link) || { link, title: '', company: '', location: '' };
    if (text && !job.title) {
      job.title = text;
      if (lines.length > 1) { job.company = lines[1] || ''; job.location = lines[2] || ''; }
    }
    byLink.set(link, job);
  }
  return [...byLink.values()].filter(j => j.title);
}

// One stable link per job, so the same job from two emails or sources collapses.
function canonicalJobLink(url) {
  let m;
  if ((m = url.match(/linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/?]*-)?(\d{6,})/i))) return `https://www.linkedin.com/jobs/view/${m[1]}`;
  if ((m = url.match(/linkedin\.com\/.*[?&](?:currentJobId|jobId)=(\d{6,})/i))) return `https://www.linkedin.com/jobs/view/${m[1]}`;
  if ((m = url.match(/indeed\.[a-z.]+\/.*?[?&]jk=([0-9a-f]{8,})/i))) return `https://www.indeed.com/viewjob?jk=${m[1]}`;
  if ((m = url.match(/glassdoor\.[a-z.]+\/.*?[?&](?:jobListingId|jl)=(\d+)/i))) return `https://www.glassdoor.com/job-listing/?jl=${m[1]}`;
  if ((m = url.match(/ziprecruiter\.[a-z.]+\/(?:c|jobs|k)\/[^?#]+/i))) return `https://www.${m[0]}`;
  if (/myworkdayjobs\.com\/.+\/job\//i.test(url)) return url.split('?')[0];
  return null;
}

// ── Source 4: Apify LinkedIn search (optional) ─────────────────────────────
// Never waits for a scrape: each refresh imports the last finished run, and
// starts a new one when it's due. Results show up one refresh later.

function fetchApify(cfg, errors) {
  const base = `https://api.apify.com/v2/acts/${APIFY_ACTOR}`;
  const opts = { headers: { Authorization: `Bearer ${cfg.apifyToken}` }, muteHttpExceptions: true };
  const props = PropertiesService.getDocumentProperties();
  const getJson = url => {
    const res = UrlFetchApp.fetch(url, opts);
    if (res.getResponseCode() === 401) throw new Error('Apify token not accepted — copy it again from console.apify.com');
    if (res.getResponseCode() === 404) return null;
    if (res.getResponseCode() !== 200) throw new Error(`Apify HTTP ${res.getResponseCode()}`);
    return JSON.parse(res.getContentText());
  };

  let jobs = [];
  const done = getJson(`${base}/runs/last?status=SUCCEEDED`);
  const run = done && done.data;
  if (run && run.id !== props.getProperty('apifyImported')) {
    const items = getJson(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?clean=true&limit=1000`) || [];
    jobs = items.map(normalizeApifyItem).filter(j => j.title && j.link);
    props.setProperty('apifyImported', run.id);
  }

  const latest = getJson(`${base}/runs/last`);
  const busy = latest && latest.data && ['READY', 'RUNNING'].includes(latest.data.status);
  if (!busy && isDue('apify', cfg.apifyEveryMin)) {
    const hours = Math.min(cfg.maxAgeHours, 24 * 7);
    const urls = cfg.apifyKeywords.map(k => 'https://www.linkedin.com/jobs/search/?' + [
      `keywords=${encodeURIComponent(k)}`,
      cfg.apifyLocation ? `location=${encodeURIComponent(cfg.apifyLocation)}` : '',
      `f_TPR=r${hours * 3600}`,
      cfg.level >= 0 ? `f_E=${encodeURIComponent(LINKEDIN_EXPERIENCE[cfg.level])}` : '',
      LINKEDIN_WORKPLACE[cfg.workStyle] ? `f_WT=${encodeURIComponent(LINKEDIN_WORKPLACE[cfg.workStyle])}` : '',
      'sortBy=DD',
    ].filter(Boolean).join('&'));
    const res = UrlFetchApp.fetch(`${base}/runs`, Object.assign({}, opts, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ urls, scrapeCompany: false, limitPerSource: cfg.apifyMax }),
    }));
    if (res.getResponseCode() !== 201 && res.getResponseCode() !== 200) {
      const body = res.getContentText();
      errors.push(`Apify could not start a search: ${(body.match(/"message"\s*:\s*"([^"]+)/) || [])[1] || 'HTTP ' + res.getResponseCode()}`);
    }
  }
  return jobs;
}

function normalizeApifyItem(it) {
  const pick = (...keys) => { for (const k of keys) if (it[k] !== undefined && it[k] !== null && it[k] !== '') return it[k]; return ''; };
  let company = pick('companyName', 'company', 'company_name');
  if (company && typeof company === 'object') company = company.name || '';
  const postedRaw = pick('postedAt', 'publishedAt', 'postedDate', 'listedAt', 'datePosted', 'postedTime', 'date');
  return {
    title: pick('title', 'jobTitle', 'position', 'positionName'),
    company,
    location: pick('location', 'jobLocation', 'place'),
    link: pick('link', 'jobUrl', 'url', 'jobLink', 'applyUrl'),
    posted: parseLooseDate(postedRaw),
    source: 'Apify: LinkedIn',
    freshBySearch: true, // the search itself was limited to the freshness window
    preFiltered: true,
  };
}

// ── Source 5: Adzuna (optional) ────────────────────────────────────────────

function fetchAdzuna(cfg, query) {
  const params = {
    app_id: cfg.adzunaId, app_key: cfg.adzunaKey, what: query, results_per_page: 50,
    max_days_old: Math.max(Math.ceil(cfg.maxAgeHours / 24), 1), sort_by: 'date', 'content-type': 'application/json',
  };
  if (cfg.adzunaWhere) params.where = cfg.adzunaWhere;
  const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
  const res = UrlFetchApp.fetch(`https://api.adzuna.com/v1/api/jobs/${cfg.adzunaCountry}/search/1?${qs}`, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(`HTTP ${res.getResponseCode()} — check your Adzuna ID and key`);
  return (JSON.parse(res.getContentText()).results || []).map(r => ({
    company: r.company && r.company.display_name, title: htmlToText(r.title),
    location: r.location && r.location.display_name, posted: r.created, link: r.redirect_url, source: 'Adzuna',
  }));
}

// ── Source 6: webhook (advanced) ───────────────────────────────────────────
// Deploy → New deployment → Web app → "Anyone". Outside scrapers POST:
// {"secret": "...", "jobs": [{"title","company","location","link","posted","source"}]}

function doPost(e) {
  const reply = obj => ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: 'body is not JSON' }); }
  const cfg = readSettings();
  if (!cfg.webhookSecret || body.secret !== cfg.webhookSecret) return reply({ ok: false, error: 'wrong or missing secret' });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return reply({ ok: false, error: 'busy, try again' });
  try {
    const jobs = (Array.isArray(body.jobs) ? body.jobs : []).map(j => ({
      title: j.title, company: j.company, location: j.location, link: j.link,
      posted: j.posted, source: String(j.source || 'webhook'), preFiltered: true,
      freshBySearch: j.freshBySearch === true, // sender already limited the search to recent posts
    }));
    const result = saveJobs(jobs, cfg, null);
    if (cfg.emailMe && result.added.length) emailSummary(result.added);
    return reply({ ok: true, received: jobs.length, added: result.added.length });
  } finally {
    lock.releaseLock();
  }
}

// ── Auto-refresh & email ───────────────────────────────────────────────────

function autoRefreshOn() {
  removeRefreshTriggers();
  ScriptApp.newTrigger('refreshJobs').timeBased().everyMinutes(15).create();
  SpreadsheetApp.getActive().toast('Auto-refresh is ON: new jobs every 15 minutes, even with this tab closed.', 'Job Scout', 8);
}

function autoRefreshOff() {
  removeRefreshTriggers();
  SpreadsheetApp.getActive().toast('Auto-refresh is OFF. Use "Refresh jobs now" whenever you want.', 'Job Scout', 8);
}

function removeRefreshTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'refreshJobs')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function emailSummary(jobs) {
  const tz = Session.getScriptTimeZone();
  const lines = jobs.slice(0, 40).map(j =>
    `• ${j.title}${j.company ? ' — ' + j.company : ''}${j.location ? ' (' + j.location + ')' : ''}\n  posted ${Utilities.formatDate(j.posted, tz, 'MMM d HH:mm')} · ${j.link}`);
  if (jobs.length > 40) lines.push(`…and ${jobs.length - 40} more in the sheet.`);
  // The sheet's name in the subject, so several sheets' emails can be told apart.
  const name = SpreadsheetApp.getActive().getName();
  const tag = [name === 'Job Scout' ? '' : name, 'IT'].filter(Boolean).join(' · ');
  const to = String(readRawSettings()['Send job emails to'] || '').replace(/\s+/g, '');
  MailApp.sendEmail(
    to && !to.startsWith('{{') ? to : Session.getEffectiveUser().getEmail(),
    // Time in the subject so Gmail keeps each email separate instead of threading them.
    `Job Scout: ${jobs.length} new job(s) · ${tag} · ${Utilities.formatDate(new Date(), tz, 'MMM d, h:mm a')}`,
    `${lines.join('\n')}\n\nOpen your sheet: ${SpreadsheetApp.getActive().getUrl()}`);
}

// ── Helpers ────────────────────────────────────────────────────────────────

// UrlFetchApp.fetchAll gives up on everything if one site can't be reached;
// retry one at a time so a single dead link only affects its own row.
// Sent in batches of 40 so one dead site only slows down its own batch.
function fetchAllSafe(requests) {
  const out = [];
  for (let i = 0; i < requests.length; i += 40) {
    const batch = requests.slice(i, i + 40);
    try {
      out.push(...UrlFetchApp.fetchAll(batch));
    } catch (e) {
      batch.forEach(r => {
        try {
          out.push(UrlFetchApp.fetch(r.url, r));
        } catch (err) {
          out.push({ getResponseCode: () => 0, getContentText: () => '', error: String(err.message || err).split(':')[0] });
        }
      });
    }
  }
  return out;
}

// Skip a source for `hours` (it pushes the "last checked" time into the future).
function backOff(key, hours) {
  PropertiesService.getDocumentProperties().setProperty(`due:${key}`, String(Date.now() + hours * 3600e3));
}

// True (and remembers now) when at least `minutes` passed since the last time.
function isDue(key, minutes) {
  const props = PropertiesService.getDocumentProperties();
  const last = Number(props.getProperty(`due:${key}`) || 0);
  if (Date.now() - last < minutes * 60e3) return false;
  props.setProperty(`due:${key}`, String(Date.now()));
  return true;
}

function oldestIsFresh(jobs, cutoff) {
  const dates = jobs.map(j => toDate(j.posted)).filter(Boolean);
  return dates.length > 0 && Math.min(...dates.map(d => d.getTime())) >= cutoff;
}

// Workday says "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago".
function workdayPosted(text) {
  const t = String(text || '').toLowerCase();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (t.includes('today')) return midnight;
  if (t.includes('yesterday')) return new Date(midnight.getTime() - 864e5);
  const m = t.match(/(\d+)\+?\s*days?/);
  return m ? new Date(midnight.getTime() - Number(m[1]) * 864e5) : null;
}

// Dates, epoch numbers, "3 hours ago", "today", "yesterday".
function parseLooseDate(v) {
  if (!v) return null;
  const direct = toDate(v);
  if (direct) return direct;
  const t = String(v).toLowerCase();
  const now = Date.now();
  if (/just now|moments? ago/.test(t)) return new Date(now);
  if (t.includes('today')) return new Date(now);
  if (t.includes('yesterday')) return new Date(now - 864e5);
  const m = t.match(/(\d+)\+?\s*(minute|min|hour|hr|day|week|month)s?\s*ago/);
  if (!m) return null;
  const unit = { minute: 6e4, min: 6e4, hour: 36e5, hr: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2]];
  return new Date(now - Number(m[1]) * unit);
}

function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) {
    const n = Number(v);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  if (!/\d{4}-\d{2}-\d{2}|\d{1,2} \w{3} \d{4}|\w{3},? \d{1,2},? \d{4}/.test(String(v))) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function resolveUrl(href, pageUrl) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  const origin = (String(pageUrl).match(/^https?:\/\/[^/]+/i) || [''])[0];
  if (h.startsWith('/')) return origin + h;
  return String(pageUrl).replace(/[^/]*$/, '') + h;
}

// The same job posted on several boards gets one row: company, title and city are compared
// after removing what boards add ("BMO Financial Group" = "BMO", "(Hybrid)", " - Toronto, ON").
const COMPANY_ALIASES = {
  royalbankof: 'rbc', rbcroyalbank: 'rbc', bankofmontreal: 'bmo', torontodominionbank: 'td', tdbank: 'td',
  bankofnovascotia: 'scotiabank', canadianimperialbankofcommerce: 'cibc', amazoncom: 'amazon',
  amazonwebservices: 'amazon', bellcanada: 'bell', bce: 'bell',
};

function pairKey(company, title, location) {
  let co = String(company || '').toLowerCase()
    .replace(/\b(inc|ltd|llc|corp|corporation|co|limited|plc|gmbh|the|canada|group|financial|holdings)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
  co = COMPANY_ALIASES[co] || co;
  const t = String(title || '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s+[-–|@]\s+(remote|hybrid|on-?site|in[- ]office|canada|ontario|toronto|gta|mississauga|brampton|markham|vaughan|ottawa|waterloo|hamilton|[a-z .]+,\s*(on|bc|ab|qc)\b).*$/, ' ')
    .replace(/\b(full|part)[- ]time\b|\b(contract|permanent|temporary|temp|hybrid|remote|on-?site)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
  const city = String(location || '').toLowerCase().split(/[,·(]/)[0].replace(/[^a-z]/g, '');
  return `${co}|${t}|${city}`;
}

function cleanText(s) {
  return decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç' };

function decodeEntities(s) {
  // Twice, because some feeds double-encode ("&amp;ndash;").
  let out = String(s || '');
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&([a-z]+);/gi, (m, name) => (NAMED_ENTITIES[name.toLowerCase()] !== undefined ? NAMED_ENTITIES[name.toLowerCase()] : m))
      .replace(/&amp;/g, '&');
  }
  return out;
}

function htmlToText(html) {
  return decodeEntities(decodeEntities(html)
    .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr|\/td)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
