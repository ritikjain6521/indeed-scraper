import { Actor } from 'apify';
import { CheerioCrawler, Dataset, RequestQueue, log } from 'crawlee';
import * as fs from 'fs';
import * as path from 'path';

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
}

interface Input {
    position?: string;
    location?: string;
    country?: string;
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
}

await Actor.init();

const input = await Actor.getInput<Input>();
if (!input) {
    await Actor.exit('Missing input. Please provide at least "position", "startUrls", or "bulkQueries".');
    throw new Error('Missing input');
}

// Robust input validation
const position = input.position?.trim();
const location = input.location?.trim() || '';
const country = (input.country || 'US').trim().toUpperCase();
const maxItems = Number(input.maxItems) || 1000;
const resetSeenKeys = Boolean(input.resetSeenKeys);
const maxConcurrency = Number(input.maxConcurrency) || 10;
const scrapeCompanyDetails = Boolean(input.scrapeCompanyDetails);
const maxCompanyPages = Number(input.maxCompanyPages) || 0;

// Domain mapping
const domains: Record<string, string> = {
    'US': 'indeed.com',
    'IN': 'in.indeed.com',
    'GB': 'uk.indeed.com',
    'UK': 'uk.indeed.com',
    'CA': 'ca.indeed.com',
    'AU': 'au.indeed.com'
};
const domain = domains[country] || 'indeed.com';
const baseUrl = `https://${domain}`;

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
let totalSavedItems = 0;
let scrapedCompanyCount = 0;
const seenCompanies = new Set<string>();

const requestQueue = await RequestQueue.open();
let enqueuedCount = 0;

// Helper to build URL
const buildUrl = (q: string, l: string = '', start: number = 0) => {
    const url = new URL(`${baseUrl}/jobs`);
    url.searchParams.set('q', q);
    if (l) url.searchParams.set('l', l);
    if (start > 0) url.searchParams.set('start', start.toString());

    return url.toString();
};

// Helper to add search with expansion logic
const enqueueSearch = async (q: string, l: string) => {
    const url = buildUrl(q, l);
    const sessionKey = `search-${q}-${l}`;
    log.info(`Enqueuing search: "${q}" in "${l}"`);
    await requestQueue.addRequest({
        url,
        userData: { label: 'START', page: 0, startUrl: url, sessionKey, q, l }
    });
    enqueuedCount++;

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

// 3. Add primary search
if (position) {
    await enqueueSearch(position, location);
}

// 4. Add company searches
if (input.companyNames && Array.isArray(input.companyNames)) {
    for (const company of input.companyNames) {
        if (!company) continue;
        // Search by company name
        await enqueueSearch(`company:"${company}"`, location);
    }
}

// 5. Add bulk searches
if (input.bulkQueries && Array.isArray(input.bulkQueries)) {
    for (const bq of input.bulkQueries) {
        if (!bq.query) continue;
        await enqueueSearch(bq.query, bq.location || '');
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

log.info(`[INFO] Starting 10K Preset Scraper for "${position}" in "${location}" (${country})`);
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
    async requestHandler({ $, request, log, session, crawler }) {
        const { label, page: pageNum = 0, referer, startUrl, sessionKey, duplicateCount = 0, q, l } = request.userData;

        if (label === 'COMPANY_DETAIL') {
            if (maxCompanyPages > 0 && scrapedCompanyCount >= maxCompanyPages) {
                log.info('Reached maxCompanyPages limit. Skipping.');
                return;
            }

            log.info(`Scraping company details: ${request.url}`);
            const companyName = $('h1').first().text().trim() || $('.css-1h50q69').text().trim();
            const details: any = {
                url: request.url,
                name: companyName,
                scrapedAt: new Date().toISOString(),
                type: 'company_detail'
            };

            // Extract common details from the "About" section or sidebar
            $('[data-testid="companyInfo-section"] div, .css-1w0lcsz div').each((_, el) => {
                const text = $(el).text();
                if (text.includes('Website')) details.website = $(el).find('a').attr('href');
                if (text.includes('Industry')) details.industry = text.replace('Industry', '').trim();
                if (text.includes('Company size')) details.size = text.replace('Company size', '').trim();
                if (text.includes('Headquarters')) details.headquarters = text.replace('Headquarters', '').trim();
                if (text.includes('Revenue')) details.revenue = text.replace('Revenue', '').trim();
            });


            // Push to separate dataset for company details (better organization in Apify UI)
            const companyDataset = await Actor.openDataset('company-details');
            await companyDataset.pushData(details);
            scrapedCompanyCount++;
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

        // Fallback: If no HTML cards found, check for Mosaic-data JSON (common on stealth-blocked Page 2+)
        if (totalFoundOnPage === 0) {
            log.info('No job cards found in HTML. Executing deep JSON extraction...');
            const htmlSnippet = $.html().substring(0, 1000);
            log.info(`HTML Head Snippet: ${htmlSnippet.replace(/\s+/g, ' ')}`);

            try {
                // Indeed stores data in several possible script tags depending on region/device
                const scriptSources = [
                    'window.mosaic.providerData["mosaic-provider-jobcards"]',
                    'window._initialData',
                    'mosaic.providerData',
                    'window.initialData',
                    '_initialData',
                ];

                let foundJson = false;
                for (const s of $('script').toArray()) {
                    const scriptText = $(s).html() || '';
                    if (scriptText.length < 10) continue;

                    for (const source of scriptSources) {
                        if (scriptText.includes(source)) {
                            log.info(`Found candidate script source: ${source}`);
                            // Try to extract the JSON object
                            const jsonMatch = scriptText.match(/({[\s\S]+?});/);
                            if (jsonMatch) {
                                try {
                                    // Clean up common JS assignments
                                    let cleanJson = jsonMatch[1].trim();
                                    if (cleanJson.endsWith(';')) cleanJson = cleanJson.slice(0, -1);

                                    const rawData = JSON.parse(cleanJson);
                                    const jobs = rawData?.metaData?.mosaicProviderJobCardsModel?.results ||
                                        rawData?.jobCards ||
                                        rawData?.results ||
                                        rawData?.props?.pageProps?.initialData?.jobCards || [];

                                    if (jobs.length > 0 && !foundJson) {
                                        foundJson = true;
                                        totalFoundOnPage = jobs.length;
                                        log.info(`SUCCESS: Extracted ${jobs.length} jobs from ${source} JSON.`);
                                        for (const job of jobs) {
                                            if (totalSavedItems >= maxItems) break;
                                            const jobKey = job.jobkey || job.jk || job.jobKey;
                                            if (!jobKey || seenKeys.has(jobKey)) continue;

                                            seenKeys.add(jobKey);
                                            newJobsOnPage++;
                                            totalSavedItems++;

                                            results.push({
                                                jobKey,
                                                title: job.title || job.displayTitle || 'Unknown Title',
                                                company: job.company || job.companyName || 'Unknown Company',
                                                location: job.formattedLocation || job.location || 'Unknown Location',
                                                salary: job.estimatedSalary || job.salarySnippet?.text || null,
                                                link: `${baseUrl}/viewjob?jk=${jobKey}`,
                                                companyRating: job.companyRating || null,
                                                companyReviewCount: job.companyReviewCount || null,
                                                pageNumber: pageNum + 1,
                                                scrapedAt: new Date().toISOString(),
                                                source: 'mosaic_json'
                                            });

                                            // Enqueue company details if requested
                                            if (scrapeCompanyDetails) {
                                                let companyUrl = job.companyOverviewLink || job.companyRelativeUrl || job.company?.overviewUrl;

                                                // Fallback to constructing from name if no link provided
                                                if (!companyUrl && job.companyName) {
                                                    const companySlug = job.companyName.replace(/\s+/g, '-');
                                                    companyUrl = `/cmp/${companySlug}`;
                                                }

                                                if (companyUrl) {
                                                    // Ensure absolute URL
                                                    if (!companyUrl.startsWith('http')) {
                                                        companyUrl = `${baseUrl}${companyUrl.startsWith('/') ? '' : '/'}${companyUrl}`;
                                                    }

                                                    if (!seenCompanies.has(companyUrl)) {
                                                        if (maxCompanyPages === 0 || seenCompanies.size < maxCompanyPages) {
                                                            seenCompanies.add(companyUrl);
                                                            log.info(`Enqueuing company details (JSON): ${companyUrl}`);
                                                            await crawler.addRequests([{
                                                                url: companyUrl,
                                                                userData: { label: 'COMPANY_DETAIL' }
                                                            }]);
                                                        } else {
                                                            log.info(`Max company pages reached. Skipping: ${companyUrl}`);
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                } catch (e) { }
                            }
                        }
                    }
                }
            } catch (jsonErr: any) {
                log.error(`Deep JSON extraction failed: ${jsonErr.message}`);
            }
        }

        // Standard HTML Extraction (only if JSON didn't already find anything)
        if (newJobsOnPage === 0) {
            for (const element of jobCards.toArray()) {
                if (totalSavedItems >= maxItems) break;

                try {
                    const card = $(element);
                    const rawLink = card.find('h2.jobTitle a').attr('href') || '';
                    if (!rawLink) continue;

                    const fullLink = rawLink.startsWith('http') ? rawLink : `${baseUrl}${rawLink}`;
                    const jobKey = fullLink.match(/jk=([a-zA-Z0-9]+)/)?.[1] || fullLink;

                    if (seenKeys.has(jobKey)) continue;

                    const jobTitle = card.find('.jobTitle span[title]').text().trim() ||
                        card.find('.jobTitle').text().trim();
                    const company = card.find('[data-testid="company-name"]').text().trim();
                    const jobLocation = card.find('[data-testid="text-location"]').text().trim();
                    const salary = card.find('.salary-snippet-container').text().trim() || null;

                    seenKeys.add(jobKey);
                    newJobsOnPage++;
                    totalSavedItems++;

                    results.push({
                        jobKey,
                        title: jobTitle,
                        company,
                        location: jobLocation,
                        salary,
                        link: fullLink,
                        pageNumber: pageNum + 1,
                        scrapedAt: new Date().toISOString(),

                    });

                    // Enqueue company details if requested
                    if (scrapeCompanyDetails) {
                        let companyLink = card.find('[data-testid="company-name"] a, a[data-testid="company-name"]').attr('href');

                        // Fallback 1: Try broader selector
                        if (!companyLink) {
                            companyLink = card.find('.companyName a').attr('href');
                        }

                        // Fallback 2: Construct from company name
                        if (!companyLink && company) {
                            // Basic slugification - can be improved if needed
                            const companySlug = company.replace(/\s+/g, '-');
                            companyLink = `/cmp/${companySlug}`;
                        }

                        if (companyLink) {
                            // Ensure valid URL format
                            const absoluteCompanyLink = companyLink.startsWith('http')
                                ? companyLink
                                : `${baseUrl}${companyLink.startsWith('/') ? '' : '/'}${companyLink}`;

                            if (!seenCompanies.has(absoluteCompanyLink)) {
                                if (maxCompanyPages === 0 || seenCompanies.size < maxCompanyPages) {
                                    seenCompanies.add(absoluteCompanyLink);
                                    log.info(`Enqueuing company details (HTML): ${absoluteCompanyLink}`);
                                    await crawler.addRequests([{
                                        url: absoluteCompanyLink,
                                        userData: { label: 'COMPANY_DETAIL' }
                                    }]);
                                } else {
                                    log.info(`Max company pages reached. Skipping: ${absoluteCompanyLink}`);
                                }
                            }
                        } else {
                            log.warning(`No company link found or constructed in HTML for job: ${company}`);
                        }
                    }
                } catch (err: any) {
                    log.error(`Extraction error: ${err.message}`);
                }
            }
        }

        // If after both attempts we still have 0, and it's Page 2+, it's a hard block
        if (newJobsOnPage === 0 && pageNum > 0 && jobCards.length === 0) {
            log.warning(`Indeed Stealth Block on Page ${pageNum + 1}. No cards in HTML or Mosaic JSON.`);
            session?.retire();
            throw new Error(`Stealth block (no data) on page ${pageNum + 1}`);
        }

        const skippedJobs = totalFoundOnPage - newJobsOnPage;

        if (totalFoundOnPage > 0) {
            log.info(`Page ${pageNum + 1}: Found ${totalFoundOnPage} jobs. ${newJobsOnPage} new, ${skippedJobs} already seen.`);
        }

        if (results.length > 0) {
            await Dataset.pushData(results);
            session?.markGood();
        }

        log.info(`Progress: ${totalSavedItems}/${maxItems} unique jobs collected.`);

        // Pagination Logic - Avoid login wall on page 2+
        // Distinguish between finding NO jobs (end of search) and finding only DUPLICATES (overlap)
        let nextDuplicateCount = duplicateCount;

        if (totalFoundOnPage > 0 && newJobsOnPage === 0) {
            nextDuplicateCount++;
        } else if (newJobsOnPage > 0) {
            nextDuplicateCount = 0; // Reset if we find even one new job
        }

        // Hard stop if we find NO jobs at all for 3 pages (likely end of results)
        if (totalFoundOnPage === 0 && pageNum > 0) {
            const emptyPageCount = (request.userData.emptyPageCount || 0) + 1;
            if (emptyPageCount >= 3) {
                log.info(`Stopping query ${sessionKey} - End of results reached (3 consecutive empty pages).`);
                return;
            }
            request.userData.emptyPageCount = emptyPageCount;
        }

        // Lenient stop for duplicates (10 pages) to handle overlapping queries in bulk
        if (nextDuplicateCount >= 10) {
            log.info(`Stopping query ${sessionKey} due to Search Exhaustion (10 pages with 0 new jobs, but duplicates found).`);
            return;
        }

        if (totalSavedItems < maxItems && (totalFoundOnPage > 0 || pageNum < 5) && pageNum < 100) {
            const nextStart = (pageNum + 1) * 10;

            // Safely build next URL by taking the startUrl and updating the 'start' param
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

log.info(`[SUMMARY] Finished. Total jobs: ${totalSavedItems}. Total company profiles scraped: ${scrapedCompanyCount}.`);

// Monetization Logic - estimate run cost
const pricePerJob = 0.001; // $1 per 1000 jobs
const pricePerCompany = 0.005; // $5 per 1000 companies
const totalCost = (totalSavedItems * pricePerJob) + (scrapedCompanyCount * pricePerCompany);
log.info(`[MONETIZATION] Estimated Run Cost: $${totalCost.toFixed(4)} USD (Jobs: $${(totalSavedItems * pricePerJob).toFixed(4)} + Companies: $${(scrapedCompanyCount * pricePerCompany).toFixed(4)})`);

// Persist results and state
await Actor.setValue('SEEN_KEYS', Array.from(seenKeys));

// Export to jobs.json for local convenience
if (!Actor.isAtHome()) {
    try {
        const dataset = await Dataset.open();
        const { items } = await dataset.getData();
        fs.writeFileSync(path.join(process.cwd(), 'jobs.json'), JSON.stringify(items, null, 2));
        log.info(`Local export complete: ${items.length} jobs saved.`);
    } catch (e) {
        log.error('Failed to export jobs.json locally.');
    }
}

await Actor.exit();  
