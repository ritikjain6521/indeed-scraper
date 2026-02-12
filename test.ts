import { chromium } from 'playwright';

console.log('Test: Starting browser launch...');

try {
    const browser = await chromium.launch({ headless: false });
    console.log('Test: Browser launched successfully!');

    const page = await browser.newPage();
    console.log('Test: Page created successfully!');

    await page.goto('https://www.google.com');
    console.log('Test: Navigation successful!');

    await browser.close();
    console.log('Test: All tests passed!');
} catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
}
