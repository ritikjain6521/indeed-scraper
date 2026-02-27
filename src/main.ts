import { Actor } from 'apify';
import { CheerioCrawler, Dataset, RequestQueue, log } from 'crawlee';

/**
 * Indeed 10K Jobs Production-Safe Preset
 * Specifically tuned for IN / US / UK with CheerioCrawler
 * Features:
 * - High-speed scraping (Cheerio)
 * - Anti-blocking headers & Session consistency
 * - No login wall on page-2 logic
 * - Stable long runs (2-4 hours)
 * - Company details extraction (Website, Industry, etc.)
 */

interface BulkQuery {
    query: string;
    location?: string;
    country?: string;
}

interface Input {
    position?: string;
    location?: string;
    country?: string;
    countries?: string[];
    maxItems?: number;
    bulkQueries?: BulkQuery[];
    startUrls?: { url: string }[];
    companyUrls?: { url: string }[];
    companyNames?: string[];
    resetSeenKeys?: boolean;
    maxConcurrency?: number;
    proxyConfiguration?: any;
    proxyUrls?: string[];
    scrapeCompanyDetails?: boolean;
    maxCompanyPages?: number;
    maxAge?: number;
    jobType?: string;
}

await Actor.init();

// Monetization counters
let totalJobsScraped = 0;
let totalCompaniesScraped = 0;
let totalJobsWithMetadata = 0;
let totalDuplicatesSkipped = 0;

// Credit check helper
const chargeAndCheck = async (options: { eventName: string, count: number }) => {
    if (!Actor.isAtHome() || options.count === 0) return;
    try {
        await Actor.charge(options);
    } catch (err: any) {
        const msg = err.message?.toLowerCase() || '';
        if (msg.includes('insufficient') || msg.includes('credit') || msg.includes('funds') || msg.includes('balance')) {
            log.error(`[CRITICAL] Credit exhaustion: ${err.message}. Aborting to prevent further usage.`);
            await Actor.exit(`Credit exhaustion: ${err.message}`);
        }
        log.error(`[CHARGE ERROR] ${err.message}`);
    }
};

if (Actor.isAtHome()) {
    log.info('Checking credit balance before start...');
    try {
        // Test charge with 0 count to verify credit state
        await Actor.charge({ eventName: 'job-standard-scraped', count: 0 });
    } catch (err: any) {
        const msg = err.message?.toLowerCase() || '';
        if (msg.includes('insufficient') || msg.includes('credit') || msg.includes('funds')) {
            await Actor.exit(`Cannot start: Insufficient credits. ${err.message}`);
        }
    }
}

const input = (await Actor.getInput<Input>()) || {} as Input;

// Robust input validation with defaults from schema
const country = (input.country || 'US').trim().toUpperCase();
const location = input.location?.trim() || '';

// If no search criteria provided, default to "Software Engineer"
let position = input.position?.trim();
if (!position && !input.startUrls?.length && !input.companyUrls?.length && !input.companyNames?.length && !input.bulkQueries?.length) {
    log.info('No search criteria provided. Using default search: "Software Engineer"');
    position = 'Software Engineer';
}

const maxItems = Number(input.maxItems) || 100;
const resetSeenKeys = Boolean(input.resetSeenKeys);
const maxConcurrency = Number(input.maxConcurrency) || 10;
const scrapeCompanyDetails = input.scrapeCompanyDetails !== false; // Default to true
const maxCompanyPages = Number(input.maxCompanyPages) || 0;
const maxAge = Number(input.maxAge) || null;
const jobType = input.jobType || '';

// Domain mapping
const domains: Record<string, string> = {
    'US': 'indeed.com',
    'IN': 'in.indeed.com',
    'GB': 'uk.indeed.com',
    'UK': 'uk.indeed.com',
    'CA': 'ca.indeed.com',
    'AU': 'au.indeed.com'
};

const getCountryDomain = (countryCode: string) => domains[countryCode.toUpperCase()] || 'indeed.com';
const getCountryBaseUrl = (countryCode: string) => `https://${getCountryDomain(countryCode)}`;


// Global Regions for Deep Search Expansion (supports US, IN, GB/UK, CA, AU)
const GLOBAL_REGIONS: Record<string, string[]> = {
    'US': [
        'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
        'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
        'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
        'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
        'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
    ],
    'IN': [
        'Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai', 'Kolkata', 'Pune', 'Ahmedabad',
        'Surat', 'Jaipur', 'Lucknow', 'Kanpur', 'Nagpur', 'Indore', 'Bhopal', 'Visakhapatnam',
        'Maharashtra', 'Karnataka', 'Tamil Nadu', 'Telangana', 'Gujarat', 'Rajasthan',
        'Uttar Pradesh', 'West Bengal', 'Madhya Pradesh', 'Andhra Pradesh'
    ],
    'GB': [
        'London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Liverpool',
        'Edinburgh', 'Bristol', 'Sheffield', 'Newcastle', 'Nottingham', 'Southampton'
    ],
    'UK': [
        'London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Liverpool',
        'Edinburgh', 'Bristol', 'Sheffield', 'Newcastle', 'Nottingham', 'Southampton'
    ],
    'CA': [
        'Ontario', 'Quebec', 'British Columbia', 'Alberta', 'Manitoba', 'Saskatchewan',
        'Nova Scotia', 'Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Ottawa'
    ],
    'AU': [
        'New South Wales', 'Victoria', 'Queensland', 'Western Australia', 'South Australia',
        'Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide'
    ]
};

// Persistence for Seen Keys to avoid duplicates across runs
let persistentKeys: any = [];
try {
    persistentKeys = await Actor.getValue('SEEN_KEYS');
    if (!Array.isArray(persistentKeys)) persistentKeys = [];
} catch (err) {
    persistentKeys = [];
}

if (resetSeenKeys) {
    log.info('Resetting seen keys as requested.');
    persistentKeys = [];
}

const seenKeys = new Set<string>(persistentKeys);
const seenCompanies = new Set<string>(); // Used to deduplicate enqueuing COMPANY_DETAIL
let totalSavedItems = 0;

const requestQueue = await RequestQueue.open();
// Buffer for jobs waiting for company details
const pendingJobs = new Map<string, any[]>();
const companyCache = new Map<string, any>();
let enqueuedCount = 0;

// Helper to build URL
const buildUrl = (q: string, l: string = '', start: number = 0, countryCode: string = country) => {
    const baseUrl = getCountryBaseUrl(countryCode);
    const url = new URL(`${baseUrl}/jobs`);
    url.searchParams.set('q', q);
    if (l) url.searchParams.set('l', l);
    if (start > 0) url.searchParams.set('start', start.toString());
    if (maxAge) url.searchParams.set('fromage', maxAge.toString());
    if (jobType) url.searchParams.set('jt', jobType);

    return url.toString();
};

// Helper to add search with expansion logic
const enqueueSearch = async (q: string, l: string, countryCode: string = country) => {
    const url = buildUrl(q, l, 0, countryCode);
    const sessionKey = `search-${q}-${l}-${countryCode}`;
    log.info(`Enqueuing search: "${q}" in "${l}" (${countryCode})`);
    await requestQueue.addRequest({
        url,
        userData: { label: 'START', page: 0, startUrl: url, sessionKey, q, l, country: countryCode }
    });
    enqueuedCount++;

    // Global Deep Search Expansion
    const regions = GLOBAL_REGIONS[countryCode.toUpperCase()];
    if (regions && l.toLowerCase().includes('remote') && maxItems > 1000) {
        log.info(`[DEEP SEARCH] Expanding "${q}" into ${regions.length} regions for ${countryCode} to find more unique jobs...`);

        // Charge for deep search expansion
        await chargeAndCheck({ eventName: 'deep-search-request', count: 1 });

        for (const region of regions) {
            const regionUrl = buildUrl(q, region, 0, countryCode);
            const regionSessionKey = `search-${q}-${region}-${countryCode}`;
            await requestQueue.addRequest({
                url: regionUrl,
                userData: { label: 'START', page: 0, startUrl: regionUrl, sessionKey: regionSessionKey, q, l: region, country: countryCode }
            });
            enqueuedCount++;
        }
    }
};

// 1. Add direct Start URLs
if (input.startUrls && Array.isArray(input.startUrls)) {
    for (const { url } of input.startUrls) {
        if (!url) continue;
        log.info(`Enqueuing direct URL: ${url}`);
        await requestQueue.addRequest({
            url,
            userData: { label: 'START', page: 0, startUrl: url }
        });
        enqueuedCount++;
    }
}

// 2. Add company direct URLs
if (input.companyUrls && Array.isArray(input.companyUrls)) {
    for (const { url } of input.companyUrls) {
        if (!url) continue;
        log.info(`Enqueuing direct company URL: ${url}`);
        await requestQueue.addRequest({
            url,
            userData: { label: 'START', page: 0, startUrl: url }
        });
        enqueuedCount++;
    }
}

// 3. Add primary searches (supports multiple countries)
const countriesToScrape = (input.countries && input.countries.length > 0)
    ? input.countries
    : [country];

if (position) {
    for (const c of countriesToScrape) {
        await enqueueSearch(position, location, c);
    }
}

// 4. Add company searches
if (input.companyNames && Array.isArray(input.companyNames)) {
    for (const company of input.companyNames) {
        if (!company) continue;
        for (const c of countriesToScrape) {
            await enqueueSearch(`company:"${company}"`, location, c);
        }
    }
}

// 5. Add bulk searches
if (input.bulkQueries && Array.isArray(input.bulkQueries)) {
    for (const bq of input.bulkQueries) {
        if (!bq.query) continue;
        if (bq.country) {
            await enqueueSearch(bq.query, bq.location || '', bq.country);
        } else {
            for (const c of countriesToScrape) {
                await enqueueSearch(bq.query, bq.location || '', c);
            }
        }
    }
}

// Validation: Stop if no requests enqueued
const queueInfo = await requestQueue.getInfo();
if (enqueuedCount === 0 && queueInfo?.totalRequestCount === 0) {
    const errorMsg = 'No search queries, company names, or start URLs provided. Nothing to scrape.';
    log.error(errorMsg);
    await Actor.exit(errorMsg);
}

// Proxy configuration - Residential is highly recommended for 10K jobs
const proxyConfiguration = input.proxyUrls?.length
    ? await Actor.createProxyConfiguration({ proxyUrls: input.proxyUrls })
    : await Actor.createProxyConfiguration(input.proxyConfiguration || { groups: ['RESIDENTIAL'] });

log.info(`[INFO] Starting 10K Preset Scraper for "${position}" in "${location}" (${countriesToScrape.join(', ')})`);
log.info(`[SETTINGS] maxItems=${maxItems}, maxConcurrency=${maxConcurrency}, proxy=${input.proxyUrls?.length ? 'Custom URL' : (input.proxyConfiguration?.useApifyProxy !== false ? 'Apify Proxy' : 'No Proxy')}`);

const crawler = new CheerioCrawler({
    requestQueue,
    proxyConfiguration,
    maxConcurrency,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 50,
        sessionOptions: {
            maxUsageCount: 10,
        },
    },
    // Production tuning for stability
    requestHandlerTimeoutSecs: 60,
    maxRequestRetries: 20, // Increased to 20 for extremely aggressive rotation on blocks

    preNavigationHooks: [
        async ({ request }) => {
            // Mobile headers - exactly as in the 'perfect' version
            request.headers = {
                ...request.headers,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Ch-Ua': '"Not_A Brand";v="24", "Chromium";v="120", "Google Chrome";v="120"',
                'Sec-Ch-Ua-Mobile': '?1',
                'Sec-Ch-Ua-Platform': '"Android"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
            };
        },
    ],
    postNavigationHooks: [
        async ({ response, session, log }) => {
            if (response && response.statusCode === 403) {
                log.warning(`Proactively retiring session due to 403 on ${response.url}`);
                session?.retire();
            }
        },
    ],

    // Core Logic
    async requestHandler({ $, request, log, session }) {
        const { label, page: pageNum = 0, referer, startUrl, sessionKey, duplicateCount = 0, q, l, country: countryCode = country } = request.userData;

        if (label === 'COMPANY_DETAIL') {
            const { companyUrl, jobData: sampleJobData } = request.userData;
            log.info(`Extracting company details for: ${sampleJobData.companyName}`);

            // Improved Phone & Email Extraction
            const telLinks = $('a[href^="tel:"]').map((_, el) => $(el).attr('href')?.replace('tel:', '').trim()).get();

            // Clean text by removing scripts and styles to avoid matching IDs/Timestamps/Decimals in JSON blobs
            const $cleanBody = $('body').clone();
            $cleanBody.find('script, style, head, header, footer').remove();
            const cleanText = $cleanBody.text();

            const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
            const regexMatches = cleanText.match(phoneRegex) || [];

            // Validate matches to remove common junk (timestamps, coordinates, IDs, floating points)
            const validatedPhones = regexMatches.filter(p => {
                const digits = p.replace(/\D/g, '');
                // Standard international/local phones are 7-15 digits
                if (digits.length < 7 || digits.length > 15) return false;

                // Reject timestamps (long sequences starting with 11, 16, 17)
                if (digits.length >= 10 && (digits.startsWith('11') || digits.startsWith('16') || digits.startsWith('17'))) {
                    const num = parseInt(digits.substring(0, 10), 10);
                    if (num > 1000000000 && num < 2000000000) return false;
                }

                // Reject decimals that look like ratings or coordinates (e.g. 4.1111 or 123.456.789)
                if (p.includes('.')) {
                    const parts = p.split('.');
                    if (parts.some(part => part.length === 1)) return false; // "3.333"
                    if (parts.length > 3) return false; // Too many parts
                }

                return true;
            });

            const mobileMatches = Array.from(new Set([...telLinks, ...validatedPhones]));

            const bodyHtml = $.html();
            const rawEmailMatches = cleanText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
            const companyEmails = Array.from(new Set(
                rawEmailMatches
                    .map(e => e.toLowerCase())
                    .filter(e => !e.match(/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf|pdf|zip)/i))
            ));

            const companyDetails: any = {
                companyBriefDescription: null,
                companyDescription: null,
                companyAddresses: [] as string[],
                companyIndustry: null,
                companyNumEmployees: null,
                companyRevenue: null,
                companyFounded: null,
                companyHeaderUrl: null,
                companyLinks: { corporateWebsite: null as string | null },
                companyEmails,
            };

            const extractText = (selector: string): string | null => $(selector).first().text().trim() || null;
            const extractAttr = (selector: string, attr: string): string | null => $(selector).first().attr(attr)?.trim() || null;

            // ── Aggressive Mosaic / window JSON Extraction ──
            $('script').each((_, script) => {
                const scriptText = $(script).html() || '';
                if (scriptText.length < 200) return;

                // Try multiple JSON block patterns
                const jsonCandidates: string[] = [];

                // Pattern 1: mosaic provider assignment
                for (const m of scriptText.matchAll(/window\.mosaic\.providerData\["[\w-]+"\]\s*=\s*(\{[\s\S]+?\});\s*(?:window\.mosaic|$)/gm)) {
                    jsonCandidates.push(m[1]);
                }
                // Pattern 2: window.__INITIAL_DATA__
                for (const m of scriptText.matchAll(/window\.__(?:INITIAL_DATA|initialData|appData)__\s*=\s*(\{[\s\S]+?\});/gm)) {
                    jsonCandidates.push(m[1]);
                }
                // Pattern 3: any large JSON object assignment
                for (const m of scriptText.matchAll(/=\s*(\{[\s\S]{300,}\});/gm)) {
                    jsonCandidates.push(m[1]);
                }

                for (const jsonStr of jsonCandidates) {
                    try {
                        const data = JSON.parse(jsonStr);

                        // Recursive deep-find — returns first truthy value found for any key
                        const deepFind = (obj: any, keys: string[], depth = 0): any => {
                            if (!obj || typeof obj !== 'object' || depth > 12) return null;
                            for (const k of keys) {
                                if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
                            }
                            for (const k of Object.keys(obj)) {
                                const r = deepFind(obj[k], keys, depth + 1);
                                if (r !== null && r !== undefined && r !== '') return r;
                            }
                            return null;
                        };

                        // Collect all address-like strings
                        const addrRaw = deepFind(data, ['headquartersLocation', 'headquarters', 'address', 'hqLocation', 'companyAddress', 'location']);
                        if (addrRaw && typeof addrRaw === 'string' && addrRaw.length > 2) {
                            if (!companyDetails.companyAddresses.includes(addrRaw)) companyDetails.companyAddresses.push(addrRaw);
                        }

                        if (!companyDetails.companyBriefDescription) {
                            companyDetails.companyBriefDescription = deepFind(data, ['tagline', 'briefDescription', 'descriptionSummary', 'subtitle', 'slogan', 'shortDescription']);
                        }
                        if (!companyDetails.companyDescription) {
                            companyDetails.companyDescription = deepFind(data, ['description', 'about', 'extendedDescription', 'companyDescription', 'overview', 'longDescription', 'aboutSection']);
                            if (typeof companyDetails.companyDescription === 'object') {
                                companyDetails.companyDescription = companyDetails.companyDescription?.text || companyDetails.companyDescription?.content || JSON.stringify(companyDetails.companyDescription);
                            }
                        }
                        if (!companyDetails.companyNumEmployees) {
                            const emp = deepFind(data, ['employeeCount', 'size', 'employees', 'companySize', 'numEmployees', 'employeeRange', 'employeeCountRange']);
                            companyDetails.companyNumEmployees = emp ? (typeof emp === 'object' ? (emp.text || emp.label || emp.min + '-' + emp.max) : String(emp)) : null;
                        }
                        if (!companyDetails.companyRevenue) {
                            const rev = deepFind(data, ['revenue', 'annualRevenue', 'revenueModel', 'financials', 'revenueRange', 'revenueText']);
                            companyDetails.companyRevenue = rev ? (typeof rev === 'object' ? (rev.text || rev.label || rev.revenue) : String(rev)) : null;
                        }
                        if (!companyDetails.companyFounded) {
                            const f = deepFind(data, ['founded', 'yearFounded', 'foundingDate', 'foundedYear', 'companyFounded', 'yearEstablished']);
                            companyDetails.companyFounded = f ? String(f) : null;
                        }
                        if (!companyDetails.companyHeaderUrl) {
                            companyDetails.companyHeaderUrl = deepFind(data, ['headerImageUrl', 'coverImageUrl', 'heroImageUrl', 'headerPhoto', 'coverPhoto', 'bannerImageUrl', 'backgroundImageUrl']);
                        }
                        if (!companyDetails.companyIndustry) {
                            const ind = deepFind(data, ['industry', 'industryName', 'sector', 'companyIndustry', 'industryLabel']);
                            companyDetails.companyIndustry = ind ? (typeof ind === 'object' ? (ind.label || ind.name || ind.text) : String(ind)) : null;
                        }

                        // Social links
                        const lks = deepFind(data, ['links', 'socialLinks', 'contactLinks', 'externalLinks', 'socialMedia', 'companyLinks']);
                        if (lks && typeof lks === 'object') {
                            if (!companyDetails.companyLinks.corporateWebsite) {
                                const ws = lks.website || lks.corporateWebsite || lks.url || lks.corporateWebsiteUrl || lks.webUrl || null;
                                const isIndeed = ws?.toLowerCase().includes('indeed') && (ws?.toLowerCase().includes('.jobs') || ws?.toLowerCase().includes('events') || ws?.toLowerCase().includes('branding') || ws?.toLowerCase().includes('design'));
                                if (ws && !isIndeed) {
                                    companyDetails.companyLinks.corporateWebsite = ws;
                                }
                            }
                        }

                        // Try to find website in any array of links
                        const allLinks = deepFind(data, ['externalLinks', 'socialMediaLinks', 'companyLinksArray']);
                        if (Array.isArray(allLinks)) {
                            for (const linkObj of allLinks) {
                                const url = linkObj.url || linkObj.href || (typeof linkObj === 'string' ? linkObj : '');
                                if (!url || typeof url !== 'string') continue;
                                if (url.startsWith('http') && !url.match(/indeed|linkedin|twitter|facebook|x\.com|google|youtube|instagram/i)) {
                                    if (!companyDetails.companyLinks.corporateWebsite) companyDetails.companyLinks.corporateWebsite = url;
                                }
                            }
                        }
                    } catch (e) { /* ignore parse errors */ }
                }
            });

            // ── Enhanced DOM Fallbacks (broad selectors + common Indeed patterns) ──

            // Social links fallback (scan all links on page)
            if (!companyDetails.companyLinks.linkedin || !companyDetails.companyLinks.twitter || !companyDetails.companyLinks.facebook) {
                $('a[href]').each((_, el) => {
                    const href = $(el).attr('href') || '';
                    if (href.includes('linkedin.com/company') && !companyDetails.companyLinks.linkedin) companyDetails.companyLinks.linkedin = href;
                    if ((href.includes('twitter.com/') || href.includes('x.com/')) && !companyDetails.companyLinks.twitter) companyDetails.companyLinks.twitter = href;
                    if (href.includes('facebook.com/') && !companyDetails.companyLinks.facebook) companyDetails.companyLinks.facebook = href;
                });
            }

            // Description
            if (!companyDetails.companyDescription) {
                companyDetails.companyDescription =
                    extractText('[data-testid="AboutSection-description"]') ||
                    extractText('[data-testid="cmp-AboutSection-content"]') ||
                    extractText('.css-companyDescription') ||
                    extractText('#aboutSection-description') ||
                    extractText('.about-content-text') ||
                    extractText('[class*="aboutText"]') ||
                    extractText('[class*="companyDescription"]') ||
                    extractText('.cmp-AboutSection') ||
                    extractText('[class*="about"][class*="section"]');
            }

            // Brief description / tagline
            if (!companyDetails.companyBriefDescription) {
                companyDetails.companyBriefDescription =
                    extractAttr('meta[name="description"]', 'content') ||
                    extractAttr('meta[property="og:description"]', 'content') ||
                    extractText('.tagline') ||
                    extractText('[data-testid="company-tagline"]') ||
                    extractText('[class*="tagline"]') ||
                    extractText('[class*="headline"]');
            }

            // Industry
            if (!companyDetails.companyIndustry) {
                companyDetails.companyIndustry =
                    extractText('[data-testid="companyInfo-industry"]') ||
                    extractText('[data-testid="cmp-companyInfo-industry"]') ||
                    extractText('li:contains("Industry") [class*="value"]') ||
                    extractText('dt:contains("Industry") + dd') ||
                    extractText('[class*="industry"]') ||
                    (() => {
                        // Scan all <li> elements for 'Industry' label
                        let found: string | null = null;
                        $('li, tr').each((_, el) => {
                            const text = $(el).text();
                            if (/^industry:/i.test(text.trim())) {
                                found = text.replace(/^industry:/i, '').trim();
                                return false;
                            }
                            return undefined;
                        });
                        return found;
                    })();
            }

            // Employee count
            if (!companyDetails.companyNumEmployees) {
                companyDetails.companyNumEmployees =
                    extractText('[data-testid="companyInfo-employeeCount"]') ||
                    extractText('[data-testid="cmp-companyInfo-employeeCount"]') ||
                    extractText('li:contains("Employee") [class*="value"]') ||
                    extractText('dt:contains("Employee") + dd') ||
                    extractText('.css-1wnv164') || // Specific indeed class for company info values
                    extractText('[class*="employeeCount"]') ||
                    extractText('[class*="companySize"]') ||
                    (() => {
                        let found: string | null = null;
                        $('li, tr, div, p').each((_, el) => {
                            const text = $(el).text().trim();
                            // Look for patterns like "10,001+ employees", "501-1,000 employees", etc.
                            if (/employees?|staff|size/i.test(text)) {
                                const m = text.match(/([\d,]+[-+]?[\d,]*\s*(?:to\s*[\d,]+)?\s*(?:employees?|staff|people))/i);
                                if (m && m[1].length < 30) { found = m[1]; return false; }
                                // Second pass: just numbers followed by employees if already contains "size" or similar label
                                if (text.length < 50 && /\d+/.test(text)) {
                                    const m2 = text.match(/(\d[\d,]*[-+]?\d*)/);
                                    if (m2) { found = m2[1]; return false; }
                                }
                            }
                            return undefined;
                        });
                        return found;
                    })();
            }

            // Revenue
            if (!companyDetails.companyRevenue) {
                companyDetails.companyRevenue =
                    extractText('[data-testid="companyInfo-revenue"]') ||
                    extractText('[data-testid="cmp-companyInfo-revenue"]') ||
                    extractText('li:contains("Revenue") [class*="value"]') ||
                    extractText('dt:contains("Revenue") + dd') ||
                    extractText('[class*="revenue"]') ||
                    (() => {
                        let found: string | null = null;
                        $('li, tr').each((_, el) => {
                            const text = $(el).text().trim();
                            if (/revenue/i.test(text)) {
                                const m = text.match(/revenue[:\s]*([^\n]+)/i);
                                if (m) { found = m[1].trim(); return false; }
                            }
                            return undefined;
                        });
                        return found;
                    })();
            }

            // Founded year
            if (!companyDetails.companyFounded) {
                const rawFounded =
                    extractText('[data-testid="companyInfo-founded"]') ||
                    extractText('[data-testid="cmp-companyInfo-founded"]') ||
                    extractText('li:contains("Founded") [class*="value"]') ||
                    extractText('dt:contains("Founded") + dd') ||
                    extractText('[class*="founded"]');

                if (rawFounded) {
                    const yearMatch = rawFounded.match(/\d{4}/);
                    companyDetails.companyFounded = yearMatch ? yearMatch[0] : null;
                } else {
                    companyDetails.companyFounded = (() => {
                        let found: string | null = null;
                        $('li, tr').each((_, el) => {
                            const text = $(el).text().trim();
                            if (/founded/i.test(text)) {
                                const m = text.match(/founded[:\s]*(\d{4})/i);
                                if (m) { found = m[1]; return false; }
                            }
                            return undefined;
                        });
                        return found;
                    })();
                }
            }

            // Addresses / HQ
            if (companyDetails.companyAddresses.length === 0) {
                const hqSelectors = [
                    '[data-testid="company-location"]',
                    '[data-testid="cmp-companyInfo-headquarters"]',
                    '[data-testid="companyInfo-headquarters"]',
                    'li:contains("Headquarters") [class*="value"]',
                    'dt:contains("Headquarters") + dd',
                    'dt:contains("Location") + dd',
                    '[class*="headquarters"]',
                    '[class*="location-text"]',
                    '.location-text',
                ];
                for (const sel of hqSelectors) {
                    const hq = extractText(sel);
                    if (hq) { companyDetails.companyAddresses = [hq]; break; }
                }
                // Also scan page for address pattern
                if (companyDetails.companyAddresses.length === 0) {
                    $('li, p, span').each((_, el) => {
                        const text = $(el).text().trim();
                        if (/headquarters[:\s]/i.test(text) && text.length < 120) {
                            const addr = text.replace(/headquarters[:\s]*/i, '').trim();
                            if (addr.length > 3) companyDetails.companyAddresses = [addr];
                            return false;
                        }
                        return undefined;
                    });
                }
            }

            // Header image from meta tags
            if (!companyDetails.companyHeaderUrl) {
                companyDetails.companyHeaderUrl =
                    extractAttr('meta[property="og:image"]', 'content') ||
                    extractAttr('[data-testid="companyBrandingHeader"] img', 'src') ||
                    extractAttr('[class*="headerImage"] img', 'src') ||
                    extractAttr('[class*="coverImage"] img', 'src') ||
                    extractAttr('[class*="heroImage"] img', 'src');
            }

            // Website from anchor hrefs
            if (!companyDetails.companyLinks.corporateWebsite) {
                // Find generic external website links (not indeed/social)
                $('a[href]').each((_, el) => {
                    const href = $(el).attr('href') || '';
                    if (
                        href.startsWith('http') &&
                        !href.includes('indeed.com') &&
                        !href.includes('google.com') &&
                        !href.includes('indeed.jobs') &&
                        !href.match(/linkedin|twitter|facebook|x\.com|youtube|instagram/i)
                    ) {
                        companyDetails.companyLinks.corporateWebsite = href;
                        return false;
                    }
                    return undefined;
                });
            }

            const scrapedAt = new Date().toISOString();


            const companyInfo = {
                companyBriefDescription: companyDetails.companyBriefDescription,
                companyIndustry: companyDetails.companyIndustry,
                companyNumEmployees: companyDetails.companyNumEmployees,
                companyRevenue: companyDetails.companyRevenue,
                companyFounded: companyDetails.companyFounded,
                corporateWebsite: (() => {
                    const ws = companyDetails.companyLinks.corporateWebsite;
                    if (!ws) return null;
                    const lowws = ws.toLowerCase();
                    if (lowws.includes('indeed') && (lowws.includes('.jobs') || lowws.includes('events') || lowws.includes('branding') || lowws.includes('design') || lowws.includes('share') || lowws.includes('hiring'))) return null;
                    return ws;
                })(),
                companyPhones: mobileMatches,
                companyEmails: companyEmails,
                companyHeaderUrl: companyDetails.companyHeaderUrl || sampleJobData.companyHeaderUrl,
                // Merging rating - use company profile rating if it has more data
                rating: (companyDetails.rating?.count > (sampleJobData.rating?.count || 0)) ? companyDetails.rating : sampleJobData.rating,
                companyScrapedAt: scrapedAt,
            };

            // Cache for future jobs of the same company
            companyCache.set(companyUrl, companyInfo);

            // Push all pending jobs for this company
            const jobsWaiting = pendingJobs.get(companyUrl);
            if (jobsWaiting && jobsWaiting.length > 0) {
                log.info(`Pushing ${jobsWaiting.length} jobs for ${sampleJobData.companyName} with merged company details.`);
                const finalJobs = jobsWaiting.map(j => ({
                    ...j,
                    ...companyInfo,
                    // Merge job-level and company-level contacts
                    emails: Array.from(new Set([...(j.emails || []), ...companyEmails])),
                    phones: Array.from(new Set([...(j.phones || []), ...mobileMatches]))
                }));
                await Dataset.pushData(finalJobs);
                totalJobsScraped += finalJobs.length;
                totalJobsWithMetadata += finalJobs.length;
                pendingJobs.delete(companyUrl);

                // Charge as Premium for merged jobs
                await chargeAndCheck({ eventName: 'job-premium-scraped', count: finalJobs.length });
            }

            totalCompaniesScraped++;
            return;
        }

        // Diagnostic: Log session status
        if (pageNum > 0) {
            const hasCookies = (session?.getCookieString(request.url)?.length ?? 0) > 0;
            log.info(`Page ${pageNum + 1} session check: ${hasCookies ? 'Has Cookies' : 'NO COOKIES'}`);
        }

        // Ensure session consistency for pagination
        if (sessionKey && !session?.userData.sessionKey) {
            session!.userData.sessionKey = sessionKey;
        }

        // Randomized delay to mimic human behavior (3-9 seconds)
        const delay = Math.floor(Math.random() * 6000) + 3000;
        log.info(`Waiting ${delay}ms before processing ${request.url} (Page ${pageNum + 1})`);
        await new Promise(res => setTimeout(res, delay));

        // Detection of blocking or walls
        const title = $('title').text().trim();
        const bodyText = $('body').text();
        const url = request.loadedUrl || request.url;

        const isBlocked = bodyText.includes('create an account or sign in') ||
            bodyText.includes('To see more than one page of jobs') ||
            bodyText.includes('Access to this page has been denied') ||
            bodyText.includes('while we verify') ||
            title.includes('Human Verification') ||
            title.includes('Just a moment') ||
            bodyText.includes('pgid=auth') ||
            bodyText.includes('pgid=captcha') ||
            url.includes('common/error') ||
            url.includes('/captcha');

        if (isBlocked) {
            log.warning(`Indeed block detected on page ${pageNum + 1}. Title: "${title}". Retiring session...`);
            session?.retire();
            throw new Error(`Blocked by Indeed on page ${pageNum + 1}`);
        }

        const noResults = bodyText.includes('did not match any jobs') ||
            bodyText.includes('try different keywords') ||
            $('.no_results_yield').length > 0;

        if (noResults) {
            log.info('No more results for this query.');
            return;
        }

        const jobCards = $('.job_seen_beacon');
        log.info(`Found ${jobCards.length} job elements via HTML.`);

        const results: any[] = [];
        let newJobsOnPage = 0;
        let totalFoundOnPage = jobCards.length;

        // ─────────────────────────────────────────────────────────────────────
        // PRIMARY EXTRACTION: Always try Mosaic JSON first.
        // The Mosaic JSON (embedded in every Indeed search page) contains ALL
        // rich fields: jobType, attributes, benefits, description, salary guide,
        // companyHeaderUrl, rating, hiringDemand, etc.
        // HTML card extraction is a last-resort fallback with very limited data.
        // ─────────────────────────────────────────────────────────────────────
        log.info('Attempting Mosaic JSON extraction (primary path)...');

        const mosaicScriptSources = [
            'window.mosaic.providerData["mosaic-provider-jobcards"]',
            'mosaic.providerData',
            'window._initialData',
            'window.initialData',
            '_initialData',
        ];

        let mosaicExtracted = false;
        try {
            for (const s of $('script').toArray()) {
                if (mosaicExtracted) break;
                const scriptText = $(s).html() || '';
                if (scriptText.length < 100) continue;

                for (const src of mosaicScriptSources) {
                    if (!scriptText.includes(src)) continue;

                    log.info(`Found Mosaic candidate script: "${src}"`);

                    // For the main mosaic provider, extract exactly its assignment value.
                    // For others, try to grab the largest JSON-like object.
                    let rawData: any = null;
                    try {
                        if (src === 'window.mosaic.providerData["mosaic-provider-jobcards"]') {
                            const m = scriptText.match(/window\.mosaic\.providerData\s*\[\s*"mosaic-provider-jobcards"\s*\]\s*=\s*(\{[\s\S]*?\});\s*(?:window\.mosaic|$)/);
                            if (m) rawData = JSON.parse(m[1]);
                        }
                        if (!rawData) {
                            // Greedy: try to find the biggest JSON blob in this script
                            const m = scriptText.match(/=\s*(\{[\s\S]{200,}\})\s*;/);
                            if (m) rawData = JSON.parse(m[1]);
                        }
                    } catch (_parseErr) {
                        // Try a progressively smaller match
                        try {
                            const m = scriptText.match(/(\{[\s\S]{200,}\})/);
                            if (m) rawData = JSON.parse(m[1]);
                        } catch (_e2) { /* ignore */ }
                    }

                    if (!rawData) continue;

                    const jobs: any[] =
                        rawData?.metaData?.mosaicProviderJobCardsModel?.results ||
                        rawData?.jobCards ||
                        rawData?.results ||
                        rawData?.props?.pageProps?.initialData?.jobCards ||
                        [];

                    if (jobs.length === 0) continue;

                    mosaicExtracted = true;
                    totalFoundOnPage = jobs.length;
                    log.info(`✅ Mosaic JSON extracted ${jobs.length} jobs from "${src}".`);

                    for (const job of jobs) {
                        if (totalSavedItems >= maxItems) break;
                        const jobKey = job.jobkey || job.jk || job.jobKey;
                        if (!jobKey) continue;
                        if (seenKeys.has(jobKey)) {
                            totalDuplicatesSkipped++;
                            await chargeAndCheck({ eventName: 'job-skipped-duplicate', count: 1 });
                            continue;
                        }

                        seenKeys.add(jobKey);
                        newJobsOnPage++;
                        totalSavedItems++;

                        // ── Taxonomy attributes (used for multiple fields below) ──
                        const taxAttrs: any[] = job.taxonomyAttributes || job.jobMosaicAttributes?.categoryAttributes || [];

                        // Helper: get all labels from a taxonomy category
                        const getTaxValues = (categoryLabel: string): string[] => {
                            const cat = taxAttrs.find((a: any) => (a.categoryLabel || a.label) === categoryLabel);
                            return (cat?.attributes || cat?.values || []).map((v: any) => v.label || v).filter(Boolean);
                        };

                        // ── Age / posted relative text ──
                        const jobAge: string | null =
                            job.formattedRelativeTime || job.pubDate || job.relativeTime ||
                            job.age || job.postingDateDisplayText ||
                            job.hiringInsights?.age || job.hiringInsightsModel?.age || null;

                        // ── Salary guide (structured) — check multiple nested paths ──
                        const salaryRaw = job.estimatedSalary || job.salaryGuide || job.salaryRange ||
                            job.salary?.estimatedSalary || job.salaryModel?.estimatedSalary || null;

                        let salaryGuide: any = null;
                        if (salaryRaw) {
                            salaryGuide = {
                                min: salaryRaw.min ?? salaryRaw.minimum ?? null,
                                max: salaryRaw.max ?? salaryRaw.maximum ?? null,
                                type: salaryRaw.type ?? salaryRaw.salaryType ?? null,
                                currency: salaryRaw.currency ?? salaryRaw.currencyCode ?? null,
                                text: salaryRaw.text ?? salaryRaw.formattedRange ?? job.salarySnippet?.text ?? null,
                            };
                        } else if (job.salarySnippet?.text) {
                            salaryGuide = { min: null, max: null, type: null, currency: null, text: job.salarySnippet.text };
                        }

                        // Parse salary text if min/max are missing
                        if (salaryGuide && salaryGuide.text && (salaryGuide.min === null || salaryGuide.max === null)) {
                            const textValues = salaryGuide.text.replace(/,/g, '').match(/\d+/g);
                            if (textValues && textValues.length > 0) {
                                const nums = textValues.map(Number);
                                if (nums.length >= 2) {
                                    if (salaryGuide.min === null) salaryGuide.min = Math.min(...nums);
                                    if (salaryGuide.max === null) salaryGuide.max = Math.max(...nums);
                                } else if (nums.length === 1) {
                                    if (salaryGuide.text.toLowerCase().includes('from') || salaryGuide.text.toLowerCase().includes('starting')) {
                                        if (salaryGuide.min === null) salaryGuide.min = nums[0];
                                    } else if (salaryGuide.text.toLowerCase().includes('up to')) {
                                        if (salaryGuide.max === null) salaryGuide.max = nums[0];
                                    } else {
                                        if (salaryGuide.min === null) salaryGuide.min = nums[0];
                                        if (salaryGuide.max === null) salaryGuide.max = nums[0];
                                    }
                                }
                            }
                            // Guess type from text if missing
                            if (!salaryGuide.type) {
                                if (/year|annum/i.test(salaryGuide.text)) salaryGuide.type = 'year';
                                else if (/month/i.test(salaryGuide.text)) salaryGuide.type = 'month';
                                else if (/week/i.test(salaryGuide.text)) salaryGuide.type = 'week';
                                else if (/hour/i.test(salaryGuide.text)) salaryGuide.type = 'hour';
                                else if (/day/i.test(salaryGuide.text)) salaryGuide.type = 'day';
                            }
                            // Guess currency if missing
                            if (!salaryGuide.currency) {
                                if (salaryGuide.text.includes('₹')) salaryGuide.currency = 'INR';
                                else if (salaryGuide.text.includes('$')) salaryGuide.currency = (country === 'CA' ? 'CAD' : (country === 'AU' ? 'AUD' : 'USD'));
                                else if (salaryGuide.text.includes('£')) salaryGuide.currency = 'GBP';
                                else if (salaryGuide.text.includes('€')) salaryGuide.currency = 'EUR';
                                else {
                                    const currentDomain = getCountryDomain(countryCode);
                                    const domainCurrencies: Record<string, string> = { 'in.indeed.com': 'INR', 'uk.indeed.com': 'GBP', 'ca.indeed.com': 'CAD', 'au.indeed.com': 'AUD' };
                                    salaryGuide.currency = domainCurrencies[currentDomain] || 'USD';
                                }
                            }
                        }

                        // ── Hiring demand ──
                        const hiringDemand = {
                            isUrgentHire: !!(job.hiringInsights?.isUrgentHire || job.hiringInsightsModel?.isUrgentHire || job.urgentHire),
                            isHighVolumeHiring: !!(job.hiringInsights?.isHighVolumeHiring || job.hiringInsightsModel?.isHighVolumeHiring || job.highVolumeHiring),
                        };

                        // ── Emails — scan full description, snippet, and all text fields ──
                        const rawDesc: string = [
                            job.snippet, job.jobDescription, job.description,
                            job.sanitizedHtml, job.descriptionHtml, job.formattedDescription,
                            job.jobDescriptionText, job.snippetText
                        ].filter(Boolean).join(' ');
                        const emailMatches: string[] = rawDesc.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
                        const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
                        const phoneMatches = rawDesc.match(phoneRegex) || [];

                        // ── Job type — structured field wins; fall back to taxonomy (job-types, job-types-cc) ──
                        const jobTypeFromTax = getTaxValues('job-types')[0] || getTaxValues('job-types-cc')[0] || null;
                        const jobTypeVal: string | null =
                            job.jobType ||
                            (Array.isArray(job.jobTypes) ? job.jobTypes[0] : null) ||
                            job.employmentType ||
                            jobTypeFromTax ||
                            null;

                        // ── Benefits — from job.benefits or taxonomy ──
                        const benefitsFromTax = getTaxValues('benefits');
                        const benefitsVal: string[] =
                            (Array.isArray(job.benefits) && job.benefits.length > 0 ? job.benefits :
                                Array.isArray(job.benefitsModel?.benefitsList) && job.benefitsModel.benefitsList.length > 0 ? job.benefitsModel.benefitsList :
                                    benefitsFromTax.length > 0 ? benefitsFromTax : []);

                        // Snippet fallback for benefits
                        if (benefitsVal.length === 0 && job.snippet) {
                            const lowSnippet = job.snippet.toLowerCase();
                            if (lowSnippet.includes('insurance')) benefitsVal.push('Insurance');
                            if (lowSnippet.includes('health')) benefitsVal.push('Health Care');
                            if (lowSnippet.includes('401k') || lowSnippet.includes('retirement')) benefitsVal.push('Retirement Plan');
                            if (lowSnippet.includes('paid time off') || lowSnippet.includes('pto')) benefitsVal.push('Paid Time Off');
                        }

                        // ── Shift and schedule — from taxonomy ──
                        const scheduleFromTax = getTaxValues('schedules');
                        const shiftsFromTax = getTaxValues('shifts');
                        const shiftAndScheduleVal: string | null =
                            job.shiftAndSchedule ||
                            job.shiftAndScheduleModel?.shiftAndScheduleText ||
                            (scheduleFromTax.length > 0 ? scheduleFromTax.join(', ') : null) ||
                            (shiftsFromTax.length > 0 ? shiftsFromTax.join(', ') : null) ||
                            null;

                        // ── Working system — from taxonomy or direct field ──
                        const workingSystemVal: string | null =
                            job.workSchedule || job.workingSystem ||
                            job.workModel ||
                            getTaxValues('remote')[0] ||
                            getTaxValues('work-location')[0] ||
                            getTaxValues('work-settings')[0] ||
                            null;

                        // ── Occupation — direct field or taxonomy ──
                        let occupationVal: string | null =
                            job.occupation || job.occupationType ||
                            job.jobCategory || job.category ||
                            job.taxonomyAttributes?.find((a: any) => /occupation|industry|category/i.test(a.label || a.categoryLabel))?.attributes?.[0]?.label ||
                            getTaxValues('occupation')[0] || getTaxValues('industry')[0];

                        if (!occupationVal) {
                            const title = (job.displayTitle || job.title || '').toLowerCase();
                            if (title.match(/software|engineer|developer|tech|it|data|programmer|cloud/)) occupationVal = 'Engineering & Technology';
                            else if (title.match(/nurse|health|medical|doctor|clinical|care/)) occupationVal = 'Healthcare';
                            else if (title.match(/sales|account|marketing|business development/)) occupationVal = 'Sales & Marketing';
                            else if (title.match(/manager|director|lead|supervisor/)) occupationVal = 'Management';
                            else if (title.match(/design|creative|artist|ui|ux/)) occupationVal = 'Design & Creative';
                            else if (title.match(/customer|support|client/)) occupationVal = 'Customer Service';
                            else if (title.match(/finance|accountant|banking|tax/)) occupationVal = 'Finance & Accounting';
                            else if (title.match(/hr|human resources|recruiter/)) occupationVal = 'Human Resources';
                            else if (title.match(/legal|lawyer|compliance/)) occupationVal = 'Legal';
                            else if (title.match(/driver|delivery|logistics|warehouse/)) occupationVal = 'Logistics & Transport';
                        }

                        // ── Description HTML — multiple paths ──
                        const descHtml: string | null =
                            job.sanitizedHtml || job.descriptionHtml ||
                            job.formattedDescription || job.htmlDescriptionModel?.htmlContent ||
                            job.htmlDescription || null;

                        // ── Company header URL — multiple paths ──
                        const companyHeaderUrlVal: string | null =
                            job.companyHeaderImageUrl ||
                            job.companyBrandingAttributes?.headerImageUrl ||
                            job.companyBrandingAttributes?.logoUrl ||
                            job.branding?.headerImageUrl ||
                            job.headerImageUrl ||
                            job.companyProfileAttributes?.headerImageUrl ||
                            null;

                        // ── Rating — try all known paths; ensure score/count are real values ──
                        let ratingVal: { score: number | null, count: number | null } | null = null;
                        const rScore = job.ratingModel?.rating ?? job.companyRating ?? job.rating?.score ?? null;
                        const rCount = job.ratingModel?.count ?? job.companyReviewCount ?? job.rating?.count ?? null;
                        if (rScore != null || rCount != null) {
                            ratingVal = { score: rScore ?? null, count: rCount ?? null };
                        }

                        // ── Locale — direct field or from job's location language hint ──
                        const localeVal: string | null =
                            job.locale || job.language || job.searchLocale ||
                            job.jobLocationModel?.countryCode || null;

                        // ── numOfCandidates ──
                        const numCandidates: number | null =
                            job.numOfCandidates ?? job.candidateCount ??
                            job.hiringInsights?.numApplicants ?? job.hiringInsightsModel?.numOfCandidates ??
                            (job.hiringInsights?.hiringMultipleCandidates ? 2 : null);

                        // ── Requirements — direct or formatted ──
                        const edu = getTaxValues('education');
                        const exp = getTaxValues('experience');
                        const quals = job.qualifications || job.qualificationsModel?.qualifications ||
                            job.jobMosaicAttributes?.qualificationsAttributes || [];
                        const qualsText = Array.isArray(quals) ? (typeof quals === 'string' ? quals : quals.map((q: any) => q.label || q).filter(Boolean).join(', ')) : (typeof quals === 'string' ? quals : '');

                        const requirementsVal: string | null =
                            job.requirements || job.formattedRequirements ||
                            job.requirementsModel?.requirements ||
                            (qualsText.length > 2 ? qualsText : null) ||
                            (() => {
                                const desc = (job.jobDescriptionText || job.snippet || '').split('\n');
                                const reqLines = desc.filter((l: string) => /require|must have|skill|experience|qualifi|proficient|knowledge/i.test(l)).slice(0, 5);
                                return reqLines.length > 0 ? reqLines.join(', ') : null;
                            })() ||
                            (edu.length > 0 ? `Education: ${edu.join(', ')}` : '') +
                            (exp.length > 0 ? ` Experience: ${exp.join(', ')}` : '') || null;

                        // ── Description-based Contact Extraction ──
                        const descFull = `${job.jobDescriptionText || ''} ${job.snippet || ''}`;
                        const descEmails = descFull.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
                        const descPhones = descFull.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
                        const validatedDescPhones = descPhones.filter(p => p.replace(/\D/g, '').length >= 7 && p.replace(/\D/g, '').length <= 15);


                        // ── Company logo & URL (from Mosaic JSON) ──
                        const companyLogoUrlVal: string | null =
                            job.companyLogoUrl ||
                            job.companyBrandingAttributes?.logoUrl ||
                            job.companyBrandingAttributes?.squareLogoUrl ||
                            job.companyBrandingAttributes?.headerLogoUrl ||
                            job.squareLogoUrl || null;

                        const currentBaseUrl = getCountryBaseUrl(countryCode);
                        const companyUrlVal: string | null = job.companyOverviewLink
                            ? (job.companyOverviewLink.startsWith('http') ? job.companyOverviewLink : `${currentBaseUrl}${job.companyOverviewLink.startsWith('/') ? '' : '/'}${job.companyOverviewLink}`)
                            : (job.companyRelativeUrl
                                ? `${currentBaseUrl}${job.companyRelativeUrl.startsWith('/') ? '' : '/'}${job.companyRelativeUrl}`
                                : (job.company || job.companyName ? `${currentBaseUrl}/cmp/${(job.company || job.companyName).replace(/\s+/g, '-')}` : null));

                        const jobData = {
                            dataType: 'job' as const,
                            jobKey,
                            jobUrl: `${currentBaseUrl}/viewjob?jk=${jobKey}`,
                            jobTitle: job.displayTitle || job.title || 'Unknown Title',
                            companyName: job.companyName || job.company || 'Unknown Company',
                            location: job.formattedLocation || job.jobLocationModel?.formattedLocation || job.location || 'Unknown Location',
                            salary: job.salarySnippet?.text || job.estimatedSalary?.text || job.salarySnippet?.label || null,
                            salaryGuide,
                            companyLogoUrl: (companyLogoUrlVal && companyLogoUrlVal.includes('placeholder')) ? null : companyLogoUrlVal,
                            companyUrl: companyUrlVal,
                            age: jobAge,
                            datePublished: job.createDate ? new Date(job.createDate).toISOString()
                                : (job.datePosted ? new Date(job.datePosted).toISOString() : null),
                            postedToday: !!(
                                (jobAge && /just\s*posted|today/i.test(jobAge)) ||
                                job.hiringInsights?.isPostedToday ||
                                job.hiringInsightsModel?.isPostedToday
                            ),
                            expired: job.expired ?? false,
                            link: `${currentBaseUrl}/viewjob?jk=${jobKey}`,
                            applyUrl: job.applyUrl || job.applyLink || job.thirdPartyApplyUrl || null,
                            jobType: jobTypeVal,
                            isRemote: !!(
                                job.remoteWork || job.remoteLocation ||
                                job.jobLocationModel?.remoteWorkModel ||
                                (job.formattedLocation && /remote/i.test(job.formattedLocation))
                            ),
                            occupation: occupationVal,
                            attributes: taxAttrs.map((a: any) => ({
                                label: a.categoryLabel || a.label || '',
                                values: (a.attributes || a.values || []).map((v: any) => v.label || v),
                            })),
                            benefits: benefitsVal,
                            workingSystem: workingSystemVal,
                            shiftAndSchedule: shiftAndScheduleVal,
                            descriptionText: job.snippet || job.jobDescription || null,
                            descriptionHtml: descHtml || (job.snippet ? `<p>${job.snippet}</p>` : null),
                            companyHeaderUrl: companyHeaderUrlVal,
                            rating: ratingVal,
                            hiringDemand,
                            emails: Array.from(new Set([...emailMatches, ...descEmails])),
                            phones: Array.from(new Set([...phoneMatches, ...validatedDescPhones])),
                            requirements: requirementsVal || null,
                            numOfCandidates: numCandidates,
                            locale: localeVal || country,
                        };

                        if (scrapeCompanyDetails && companyUrlVal) {
                            if (companyCache.has(companyUrlVal)) {
                                // Already cached, merge and push now
                                const companyInfo = companyCache.get(companyUrlVal);
                                const fullJob = {
                                    ...jobData,
                                    ...companyInfo,
                                    // Also merge company-level contacts into job fields
                                    emails: Array.from(new Set([...(jobData.emails || []), ...(companyInfo.companyEmails || [])])),
                                    phones: Array.from(new Set([...(jobData.phones || []), ...(companyInfo.companyPhones || [])]))
                                };
                                await Dataset.pushData(fullJob);
                                totalJobsScraped++;
                                totalJobsWithMetadata++;
                                // Charge as Premium
                                await chargeAndCheck({ eventName: 'job-premium-scraped', count: 1 });
                            } else {
                                // Buffer job and enqueue company detail if not already seen
                                if (!pendingJobs.has(companyUrlVal)) {
                                    pendingJobs.set(companyUrlVal, []);
                                }
                                pendingJobs.get(companyUrlVal)!.push(jobData);

                                if (!seenCompanies.has(companyUrlVal)) {
                                    seenCompanies.add(companyUrlVal);
                                    await requestQueue.addRequest({
                                        url: companyUrlVal,
                                        uniqueKey: companyUrlVal,
                                        userData: { label: 'COMPANY_DETAIL', companyUrl: companyUrlVal, jobData },
                                    });
                                }
                            }
                        } else {
                            // No company details requested, push immediately
                            await Dataset.pushData(jobData);
                            totalJobsScraped++;
                            // Charge as Standard
                            await chargeAndCheck({ eventName: 'job-standard-scraped', count: 1 });
                        }


                    }
                    break;
                }
            }
        } catch (jsonErr: any) {
            log.warning(`Mosaic JSON extraction failed: ${jsonErr.message}`);
        }

        // ─────────────────────────────────────────────────────────────────────
        // FALLBACK: HTML card extraction — only runs if Mosaic JSON failed.
        // ─────────────────────────────────────────────────────────────────────
        if (!mosaicExtracted) {
            log.info('Mosaic JSON not found — falling back to HTML card extraction.');
            if (jobCards.length === 0) {
                log.info(`HTML Head Snippet: ${$.html().substring(0, 800).replace(/\s+/g, ' ')}`);
            }
        }

        if (!mosaicExtracted && newJobsOnPage === 0) {
            for (const element of jobCards.toArray()) {
                if (totalSavedItems >= maxItems) break;

                try {
                    const card = $(element);
                    const rawLink = card.find('h2.jobTitle a').attr('href') || '';
                    if (!rawLink) continue;

                    const currentBaseUrl = getCountryBaseUrl(countryCode);
                    const fullLink = rawLink.startsWith('http') ? rawLink : `${currentBaseUrl}${rawLink}`;
                    const jobKey = fullLink.match(/jk=([a-zA-Z0-9]+)/)?.[1] || fullLink;

                    if (seenKeys.has(jobKey)) {
                        totalDuplicatesSkipped++;
                        await chargeAndCheck({ eventName: 'job-skipped-duplicate', count: 1 });
                        continue;
                    }

                    const jobTitle = card.find('.jobTitle span[title]').text().trim() ||
                        card.find('.jobTitle').text().trim();
                    const company = card.find('[data-testid="company-name"]').text().trim();
                    const jobLocation = card.find('[data-testid="text-location"]').text().trim();
                    const salary = card.find('.salary-snippet-container').text().trim() ||
                        card.find('.salarySnippet').text().trim() ||
                        card.find('[data-testid="attribute_snippet_testid"]:contains("$")').text().trim() ||
                        card.find('[data-testid="attribute_snippet_testid"]:contains("₹")').text().trim() ||
                        null;
                    // Extract posted date - use only targeted selectors, then regex fallback
                    let postedAt = '';

                    // Strategy 1: Known CSS selectors for the posted date element
                    const dateSelectors = [
                        '.date',
                        '.underflow-relative-time',
                        'span[data-testid="myJobsStateDate"]',
                        '[data-testid="job-age"]',
                        '.result-footer .date',
                    ];
                    for (const sel of dateSelectors) {
                        const text = card.find(sel).text().trim();
                        if (text && /\d+\s*(day|hour|minute|week|month)s?\s*ago|just\s*posted|today|active/i.test(text)) {
                            postedAt = text;
                            break;
                        }
                    }

                    // Strategy 2: Regex scan of the entire card HTML for date-like text
                    if (!postedAt) {
                        const cardText = card.text() || '';
                        const agoMatch = cardText.match(/(?:posted\s*)?(\d+\+?\s*(?:day|hour|minute|week|month)s?\s*ago)/i);
                        if (agoMatch) {
                            postedAt = agoMatch[0].trim();
                        } else {
                            const otherMatch = cardText.match(/(just\s*posted|today|active\s*\d+\s*days?\s*ago)/i);
                            if (otherMatch) {
                                postedAt = otherMatch[0].trim();
                            }
                        }
                    }

                    seenKeys.add(jobKey);
                    newJobsOnPage++;
                    totalSavedItems++;

                    // ── Urgency / volume badges from HTML card ──
                    const isUrgentHire = /urgently\s*hiring/i.test(card.text());
                    const isHighVolumeHiring = /hiring\s*multiple|high\s*volume/i.test(card.text());
                    const isPostedToday = /just\s*posted|today/i.test(postedAt);
                    const isRemote = /remote/i.test(jobLocation);

                    // ── Job type badge from HTML card — iterate to avoid CSS contamination ──
                    let jobTypeHtml: string | null = null;
                    card.find('[data-testid="attribute_snippet_testid"], .attribute_snippet').each((_, el) => {
                        const txt = $(el).clone().children().remove().end().text().trim();
                        if (/^(full[- ]?time|part[- ]?time|contract|temporary|intern|casual|permanent|commission)$/i.test(txt)) {
                            jobTypeHtml = txt;
                            return false; // break
                        }
                        return true;
                    });

                    // ── Emails from snippet ──
                    const snippetText = card.find('.job-snippet, .summary').text() || '';
                    const emailMatches = snippetText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
                    const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
                    const phoneMatches = snippetText.match(phoneRegex) || [];

                    // ── Salary guide for HTML fallback ──
                    let salaryGuideHtml: any = null;
                    if (salary) {
                        salaryGuideHtml = { min: null, max: null, type: null, currency: null, text: salary };
                        const nums = salary.replace(/,/g, '').match(/\d+/g);
                        if (nums && nums.length > 0) {
                            const n = nums.map(Number);
                            if (n.length >= 2) {
                                salaryGuideHtml.min = Math.min(...n);
                                salaryGuideHtml.max = Math.max(...n);
                            } else {
                                salaryGuideHtml.min = n[0];
                                salaryGuideHtml.max = n[0];
                            }
                        }
                        if (/year|annum/i.test(salary)) salaryGuideHtml.type = 'year';
                        else if (/month/i.test(salary)) salaryGuideHtml.type = 'month';
                        else if (/week/i.test(salary)) salaryGuideHtml.type = 'week';
                        else if (/hour/i.test(salary)) salaryGuideHtml.type = 'hour';
                    }

                    // ── Try to find occupation or benefits in snippet ──
                    const snippetLower = snippetText.toLowerCase();
                    const titleLower = jobTitle.toLowerCase();
                    let occupationHtml: string | null = null;
                    if (titleLower.match(/software|engineer|developer|tech|it|data/)) occupationHtml = 'Engineering & Technology';
                    else if (titleLower.match(/nurse|health|medical|doctor|care/)) occupationHtml = 'Healthcare';
                    else if (titleLower.match(/sales|marketing/)) occupationHtml = 'Sales & Marketing';
                    else if (titleLower.match(/manager|director/)) occupationHtml = 'Management';
                    else if (titleLower.match(/design|creative/)) occupationHtml = 'Design & Creative';
                    else if (titleLower.match(/customer|support/)) occupationHtml = 'Customer Service';
                    else if (titleLower.match(/finance|accountant/)) occupationHtml = 'Finance & Accounting';
                    else if (titleLower.match(/driver|delivery|warehouse/)) occupationHtml = 'Logistics & Transport';

                    if (!occupationHtml && (snippetLower.includes('developer') || snippetLower.includes('engineer'))) occupationHtml = 'Engineering';
                    else if (!occupationHtml && snippetLower.includes('manager')) occupationHtml = 'Management';
                    else if (!occupationHtml && snippetLower.includes('sales')) occupationHtml = 'Sales';

                    const benefitsHtml: string[] = [];
                    if (snippetLower.includes('insurance')) benefitsHtml.push('Insurance');
                    if (snippetLower.includes('health')) benefitsHtml.push('Health');
                    if (snippetLower.includes('401k') || snippetLower.includes('pension')) benefitsHtml.push('Retirement');

                    const companyLogoUrlHtml = card.find('img.job-search-6-brand-logo-img').attr('src') ||
                        card.find('img[alt*="logo" i]').attr('src') || null;
                    const companyUrlHtml = card.find('a[data-testid="company-name"]').attr('href') ||
                        card.find('.companyName a').attr('href') ||
                        (company ? `/cmp/${company.replace(/\s+/g, '-')}` : null);
                    const fullCompanyUrlHtml = companyUrlHtml ? (companyUrlHtml.startsWith('http') ? companyUrlHtml : `${currentBaseUrl}${companyUrlHtml.startsWith('/') ? '' : '/'}${companyUrlHtml}`) : null;

                    const descEmailsHtml = snippetText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
                    const descPhonesHtml = snippetText.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g) || [];
                    const validatedDescPhonesHtml = descPhonesHtml.filter(p => p.replace(/\D/g, '').length >= 7 && p.replace(/\D/g, '').length <= 15);
                    const guessedReqs = (snippetText || '').split(/[;.]/).filter(s => /require|must|skill|exp|qualif/i.test(s)).join(', ').trim();

                    const jobData = {
                        dataType: 'job' as const,
                        jobKey,
                        jobUrl: fullLink,
                        jobTitle,
                        companyName: company,
                        location: jobLocation,
                        salary,
                        salaryGuide: salaryGuideHtml,
                        companyLogoUrl: companyLogoUrlHtml,
                        companyUrl: fullCompanyUrlHtml,
                        age: postedAt,
                        datePublished: null,
                        postedToday: isPostedToday,
                        expired: false,
                        link: fullLink,
                        applyUrl: null,
                        jobType: jobTypeHtml,
                        isRemote,
                        occupation: occupationHtml,
                        attributes: [],
                        benefits: benefitsHtml.length > 0 ? benefitsHtml : [],
                        workingSystem: isRemote ? 'Remote' : null,
                        shiftAndSchedule: null,
                        descriptionText: snippetText || null,
                        descriptionHtml: null,
                        companyHeaderUrl: null,
                        rating: null,
                        hiringDemand: { isUrgentHire, isHighVolumeHiring },
                        pageNumber: pageNum + 1,
                        source: 'html',
                        emails: Array.from(new Set([...emailMatches, ...descEmailsHtml])),
                        phones: Array.from(new Set([...phoneMatches, ...validatedDescPhonesHtml])),
                        requirements: guessedReqs || null,
                        numOfCandidates: null,
                        locale: country,
                    };

                    if (scrapeCompanyDetails && fullCompanyUrlHtml) {
                        if (companyCache.has(fullCompanyUrlHtml)) {
                            const companyInfo = companyCache.get(fullCompanyUrlHtml);
                            const fullJob = {
                                ...jobData,
                                ...companyInfo,
                                // Also merge company-level contacts into job fields
                                emails: Array.from(new Set([...(jobData.emails || []), ...(companyInfo.companyEmails || [])])),
                                phones: Array.from(new Set([...(jobData.phones || []), ...(companyInfo.companyPhones || [])]))
                            };
                            await Dataset.pushData(fullJob);
                            totalJobsScraped++;
                            totalJobsWithMetadata++;
                            // Charge as Premium
                            await chargeAndCheck({ eventName: 'job-premium-scraped', count: 1 });
                        } else {
                            if (!pendingJobs.has(fullCompanyUrlHtml)) {
                                pendingJobs.set(fullCompanyUrlHtml, []);
                            }
                            pendingJobs.get(fullCompanyUrlHtml)!.push(jobData);

                            if (company && !seenCompanies.has(fullCompanyUrlHtml)) {
                                seenCompanies.add(fullCompanyUrlHtml);
                                await requestQueue.addRequest({
                                    url: fullCompanyUrlHtml,
                                    uniqueKey: fullCompanyUrlHtml,
                                    userData: { label: 'COMPANY_DETAIL', companyUrl: fullCompanyUrlHtml, jobData },
                                });
                            }
                        }
                    } else {
                        await Dataset.pushData(jobData);
                        totalJobsScraped++;
                        // Charge as Standard (No metadata found/requested)
                        await chargeAndCheck({ eventName: 'job-standard-scraped', count: 1 });
                    }


                } catch (err: any) {
                    log.error(`Extraction error: ${err.message}`);
                }
            }
        }

        if (newJobsOnPage > 0) {
            session?.markGood();
        }

        if (newJobsOnPage === 0 && pageNum > 0 && jobCards.length === 0) {
            log.warning(`Indeed Stealth Block on Page ${pageNum + 1}. No cards in HTML or Mosaic JSON.`);
            session?.retire();
            throw new Error(`Stealth block (no data) on page ${pageNum + 1}`);
        }

        const skippedJobs = totalFoundOnPage - newJobsOnPage;
        if (totalFoundOnPage > 0) {
            log.info(`Page ${pageNum + 1}: Found ${totalFoundOnPage} jobs. ${newJobsOnPage} new, ${skippedJobs} already seen.`);
        }



        log.info(`Progress: ${totalSavedItems}/${maxItems} unique jobs collected. (Skipped ${totalDuplicatesSkipped} duplicates so far)`);

        let nextDuplicateCount = duplicateCount;
        if (totalFoundOnPage > 0 && newJobsOnPage === 0) {
            nextDuplicateCount++;
        } else if (newJobsOnPage > 0) {
            nextDuplicateCount = 0;
        }

        if (totalFoundOnPage === 0 && pageNum > 0) {
            const emptyPageCount = (request.userData.emptyPageCount || 0) + 1;
            if (emptyPageCount >= 3) return;
            request.userData.emptyPageCount = emptyPageCount;
        }

        if (nextDuplicateCount >= 10) return;

        if (totalSavedItems < maxItems && (totalFoundOnPage > 0 || pageNum < 5) && pageNum < 100) {
            const nextStart = (pageNum + 1) * 10;
            const nextUrlObj = new URL(startUrl);
            nextUrlObj.searchParams.set('start', nextStart.toString());
            const nextUrl = nextUrlObj.toString();

            await requestQueue.addRequest({
                url: nextUrl,
                userData: {
                    label: 'LIST',
                    page: pageNum + 1,
                    referer: request.url,
                    startUrl,
                    sessionKey,
                    duplicateCount: nextDuplicateCount,
                    emptyPageCount: request.userData.emptyPageCount || 0,
                    q,
                    l
                },
            });
            log.info(`Enqueued next page: ${nextUrl}`);
        }
    },

    // Handle failed requests
    async failedRequestHandler({ request, log }) {
        log.error(`Request ${request.url} failed after maximum retries. Check proxyhealth/token.`);
    },
});


try {
    log.info('Run started. Waiting for completion...');
    await crawler.run();
} catch (err) {
    log.error('Crawler failed:', { err });
}

log.info(`[SUMMARY] Finished. Total unique jobs collected: ${totalSavedItems}.`);
log.info(`[SUMMARY] Total jobs pushed to dataset: ${totalJobsScraped}.`);
log.info(`[SUMMARY] Total duplicate jobs skipped: ${totalDuplicatesSkipped}.`);
log.info(`[INFO] Jobs with merged company details: ${totalJobsWithMetadata}.`);
if (totalJobsScraped > totalJobsWithMetadata) {
    log.info(`[INFO] Jobs with only basic details (meta-scraping failed/skipped): ${totalJobsScraped - totalJobsWithMetadata}.`);
}

// Persist results and state
await Actor.setValue('SEEN_KEYS', Array.from(seenKeys));

// Cleanup: Push any jobs that were waiting for companies that failed or timed out
if (pendingJobs.size > 0) {
    const remainingJobs: any[] = [];
    for (const jobs of pendingJobs.values()) {
        remainingJobs.push(...jobs);
    }
    if (remainingJobs.length > 0) {
        log.info(`[CLEANUP] Pushing ${remainingJobs.length} jobs that were waiting for metadata (failed/timed out).`);
        await Dataset.pushData(remainingJobs);
        totalJobsScraped += remainingJobs.length;
        // Cleanup jobs are pushed without company details, so charge as Standard
        await chargeAndCheck({ eventName: 'job-standard-scraped', count: remainingJobs.length });
    }
}

await Actor.exit(); 