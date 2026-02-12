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
 */

interface BulkQuery {
    query: string;
    location?: string;
}

interface Input {
    position: string;
    location?: string;
    country?: string;
    maxItems?: number;
    bulkQueries?: BulkQuery[];
    resetSeenKeys?: boolean;
    maxConcurrency?: number;
    proxyConfiguration?: any;
    proxyUrls?: string[];
}

await Actor.init();

const input = await Actor.getInput<Input>();
if (!input) {
    await Actor.exit('Missing input. Please provide at least "position".');
    throw new Error('Missing input');
}

// Robust input validation
const position = input.position?.trim();
const location = input.location?.trim() || '';
const country = (input.country || 'US').trim().toUpperCase();
const maxItems = Number(input.maxItems) || 1000;
const resetSeenKeys = Boolean(input.resetSeenKeys);
const maxConcurrency = Number(input.maxConcurrency) || 10;

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

// US States for "Remote" expansion to bypass 1000-job limit
const US_STATE_CODES = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
];

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

const requestQueue = await RequestQueue.open();

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

    // Expansion: If user wants >1000 jobs and searching "Remote" in US, iterate through states
    // This bypasses the Indeed 1000-job-per-query limit
    if (country === 'US' && l.toLowerCase().includes('remote') && maxItems > 1000) {
        log.info(`[DEEP SEARCH] Expanding "${q}" into 50 US states to find more unique jobs...`);
        for (const stateCode of US_STATE_CODES) {
            const stateUrl = buildUrl(q, stateCode);
            const stateSessionKey = `search-${q}-${stateCode}`;
            await requestQueue.addRequest({
                url: stateUrl,
                userData: { label: 'START', page: 0, startUrl: stateUrl, sessionKey: stateSessionKey, q, l: stateCode }
            });
        }
    }
};

// Add primary search
if (position) {
    await enqueueSearch(position, location);
}

// Add bulk searches
if (input.bulkQueries && Array.isArray(input.bulkQueries)) {
    for (const bq of input.bulkQueries) {
        if (!bq.query) continue;
        await enqueueSearch(bq.query, bq.location || '');
    }
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
    async requestHandler({ $, request, log, session }) {
        const { label, page: pageNum = 0, referer, startUrl, sessionKey, duplicateCount = 0, q, l } = request.userData;

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
                $('script').toArray().forEach(s => {
                    const scriptText = $(s).html() || '';
                    if (scriptText.length < 10) return;

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
                                                pageNumber: pageNum + 1,
                                                scrapedAt: new Date().toISOString(),
                                                source: 'mosaic_json'
                                            });
                                        }
                                    }
                                } catch (e) { }
                            }
                        }
                    }
                });
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
                        source: 'html'
                    });
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
            // Use q and l from userData to ensure we paginate the correct search!
            const nextUrl = buildUrl(q || position || '', l || location || '', nextStart);

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

