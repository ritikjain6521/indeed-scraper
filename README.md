# Indeed Job Scraper

A high-performance, production-ready Indeed job scraper built on [Apify](https://apify.com) using `CheerioCrawler`. Designed for bulk scraping across multiple countries with optional company detail enrichment.

---

## Key Features

- **High-Speed Scraping** — Powered by `CheerioCrawler` (no browser overhead); handles thousands of jobs efficiently.
- **Multi-Country Support** — Scrape jobs simultaneously from US, India, UK, Canada, and Australia.
- **Mosaic JSON Extraction** — Extracts rich structured data directly from Indeed's internal Mosaic JSON (primary path), with HTML card fallback.
- **Company Detail Enrichment** — Optionally visits company profile pages to extract industry, employee count, revenue, founded year, website, emails, and phone numbers.
- **Duplicate Prevention** — Cross-run deduplication using a persistent `SEEN_KEYS` store; duplicate jobs are tracked and skipped.
- **Smart Pagination** — Automatically follows pages up to 100 per search query; stops early when duplicates dominate.
- **Anti-Blocking** — Session pool (50 sessions, 10 uses each), mobile Chrome headers, and randomized request delays (3–9s).
- **Bulk Searches** — Run multiple `position + location + country` queries in a single execution via `bulkQueries`.
- **Deep Search Expansion** — For remote searches exceeding 1,000 items, automatically expands into regional sub-searches.
- **Job Age & Type Filtering** — Filter results by posting recency (`maxAge`) and employment type (`jobType`).

---

## Extracted Data Fields

Each scraped job record contains the following fields:

| Field | Description |
|---|---|
| `jobKey` | Unique Indeed job identifier |
| `jobTitle` | Job title |
| `companyName` | Company name |
| `location` | Job location (city, state, or "Remote") |
| `salary` | Raw salary text from listing |
| `salaryGuide` | Structured salary object: `{ min, max, type, currency, text }` |
| `jobType` | Employment type (Full-time, Part-time, Contract, etc.) |
| `isRemote` | `true` if job is remote |
| `occupation` | Inferred job category (e.g. Engineering & Technology) |
| `age` | Relative post time (e.g. "3 days ago") |
| `datePublished` | ISO 8601 publish date |
| `postedToday` | `true` if posted today |
| `expired` | `true` if listing has expired |
| `applyUrl` | Direct apply link |
| `jobUrl` / `link` | Full URL to the job listing |
| `descriptionText` | Plain-text job description snippet |
| `descriptionHtml` | HTML job description snippet |
| `benefits` | List of benefits (e.g. Health insurance, Paid time off) |
| `attributes` | Raw taxonomy attributes array from Indeed |
| `workingSystem` | Work model (Remote, Hybrid, On-site) |
| `shiftAndSchedule` | Shift info (e.g. "Monday to Friday") |
| `requirements` | Extracted requirements/qualifications text |
| `hiringDemand` | `{ isUrgentHire, isHighVolumeHiring }` |
| `rating` | Company rating: `{ score, count }` |
| `emails` | Emails found in job description |
| `phones` | Phone numbers found in job description |
| `companyUrl` | Link to company profile on Indeed |
| `companyLogoUrl` | Company square logo URL |
| `companyHeaderUrl` | Company header/banner image URL |
| `locale` | Country/language locale of the job |
| `scrapedAt` | ISO 8601 timestamp of when the job was scraped |

### Company Enrichment Fields *(when `scrapeCompanyDetails: true`)*

| Field | Description |
|---|---|
| `companyBriefDescription` | Short company tagline or meta description |
| `companyIndustry` | Industry sector |
| `companyNumEmployees` | Employee count or range |
| `companyRevenue` | Revenue range |
| `companyFounded` | Year founded |
| `corporateWebsite` | Company's external website URL |
| `companyEmails` | Emails from the company profile page |
| `companyPhones` | Phone numbers from the company profile page |
| `companyScrapedAt` | Timestamp when company details were fetched |

---

## Example Output

```json
{
  "jobKey": "808e0e8a386c0fa6",
  "jobUrl": "https://in.indeed.com/viewjob?jk=808e0e8a386c0fa6",
  "jobTitle": "Software Engineer III",
  "companyName": "Indeed",
  "location": "Remote",
  "salary": "₹53,60,000 - ₹80,40,000 a year",
  "salaryGuide": {
    "min": 5360000,
    "max": 8040000,
    "type": "year",
    "currency": "INR",
    "text": "₹53,60,000 - ₹80,40,000 a year"
  },
  "jobType": "Full-time",
  "isRemote": true,
  "occupation": "Engineering & Technology",
  "age": "27 days ago",
  "datePublished": "2026-01-27T08:01:21.300Z",
  "postedToday": false,
  "expired": false,
  "benefits": ["Paid time off", "Health insurance", "Life insurance"],
  "workingSystem": "Remote",
  "hiringDemand": {
    "isUrgentHire": false,
    "isHighVolumeHiring": false
  },
  "rating": { "score": 4.2, "count": 1756 },
  "companyLogoUrl": "https://d2q79iu7y748jz.cloudfront.net/...",
  "companyHeaderUrl": "https://d2q79iu7y748jz.cloudfront.net/...",
  "companyUrl": "https://in.indeed.com/cmp/Indeed",
  "emails": [],
  "phones": [],
  "locale": "IN",
  "scrapedAt": "2026-02-23T10:45:00.000Z"
}
```

---

## Input Configuration

| Parameter | Type | Default | Description |
|---|---|---|---|
| `position` | String | `"Software Engineer"` | Job title/keyword to search for |
| `location` | String | `""` | City, state, or leave blank for all locations |
| `country` | String | `"US"` | Single country code (legacy; use `countries` for multi) |
| `countries` | Array | `[]` | Multiple country codes: `US`, `IN`, `GB`, `CA`, `AU` |
| `maxItems` | Integer | `100` | Maximum number of unique jobs to collect |
| `maxAge` | Integer | — | Filter to jobs posted within N days |
| `jobType` | String | `""` | Filter by: `fulltime`, `parttime`, `contract`, `temporary`, `internship` |
| `startUrls` | Array | `[]` | Direct Indeed search URLs to scrape |
| `companyUrls` | Array | `[]` | Direct Indeed company job-listing URLs |
| `companyNames` | Array | `[]` | Search for jobs from specific companies |
| `bulkQueries` | Array | `[]` | Multiple `{ query, location, country }` objects for one run |
| `scrapeCompanyDetails` | Boolean | `true` | Visit company pages to enrich job records |
| `companySizes` | Array | `[]` | Filter jobs by company size. Options: `self-employed`, `1-10`, `11-50`, `51-200`, `201-500`, `501-1000`, `1001-5000`, `5001-10000`, `10001+`. Requires `scrapeCompanyDetails: true` |
| `maxCompanyPages` | Integer | `0` | Max company detail pages to scrape (0 = unlimited) |
| `maxConcurrency` | Integer | `10` | Parallel pages processed simultaneously |
| `resetSeenKeys` | Boolean | `false` | Clear the duplicate memory before this run |
| `proxyConfiguration` | Object | Residential | Proxy settings (Residential proxy strongly recommended) |

### Example Input

```json
{
  "position": "Data Analyst",
  "location": "Remote",
  "countries": ["US", "IN", "GB"],
  "maxItems": 500,
  "maxAge": 7,
  "jobType": "fulltime",
  "scrapeCompanyDetails": true,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

---

## Usage Tips

- **Use Residential Proxies** — Indeed aggressively blocks datacenter IPs. Always use residential proxies for reliable results.
- **Set `maxItems` conservatively** — Start with 100–500 for testing. Scale up once you confirm the proxy and session setup is stable.
- **Use `maxAge` for fresh jobs** — Set `maxAge: 3` or `maxAge: 7` to collect only recently posted jobs and avoid old listings.
- **Enable `scrapeCompanyDetails`** for enriched data — Industry, employee count, revenue, and corporate website are only available when this is `true`.
- **Multi-country runs** — Use the `countries` array (e.g. `["US", "IN", "GB"]`) to scrape the same position across markets in one run.
- **Avoid duplicate runs** — Leave `resetSeenKeys: false` so the scraper remembers previously collected jobs across runs. Set to `true` only when you want a completely fresh dataset.
- **Bulk queries** — Use `bulkQueries` to search multiple different positions in one run without launching separate actors.
- **Company URLs** — To scrape all jobs listed on a company's Indeed page (e.g. every open role at Google), use `companyUrls`.
- **Filter by company size** — Use `companySizes` to target jobs from companies of specific sizes (e.g. `["51-200", "201-500"]` for mid-size companies). This filter requires `scrapeCompanyDetails: true` because company size is only available after visiting the company profile page. Jobs from companies with no size information are **not filtered out** — they pass through.

---

## Local Development

### Prerequisites

- Node.js 18+
- Apify CLI: `npm install -g apify-cli`

### Setup

```bash
# Install dependencies
npm install

# Log in to Apify (required for proxy and storage)
apify login

# Run locally with the default input in storage/key_value_stores/default/INPUT.json
apify run
```

### Build

```bash
npm run build
```

The TypeScript source compiles from `src/main.ts` to `dist/`.

---

## Pricing & Credits

This actor uses **pay-per-event** monetization on the Apify platform:

| Event | Description | Cost |
|---|---|---|
| `job-standard-scraped` | Job scraped without company detail enrichment | Per job |
| `job-premium-scraped` | Job scraped and merged with full company details | Per job (higher rate) |
| `job-skipped-duplicate` | Duplicate job detected and skipped | Minimal/tracking charge |

> **Note:** Company detail scraping (`scrapeCompanyDetails: true`) produces `job-premium-scraped` events, which cost more credits but include rich enrichment fields (industry, employees, revenue, website, etc.). Disable company detail scraping for lower-cost, basic job data only.

Credit checks run before and during the scrape. If credits are exhausted mid-run, the actor exits cleanly to prevent unexpected overages.
