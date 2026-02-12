import axios from 'axios';

async function test(url: string) {
    try {
        console.log(`Testing connectivity to ${url}...`);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 30000
        });
        console.log(`[${url}] Status: ${response.status}, Length: ${response.data.length}`);
    } catch (err: any) {
        console.log(`[${url}] Error: ${err.message}`);
    }
}

await test('https://www.google.com');
await test('https://www.indeed.com/jobs?q=software+engineer&l=austin');
await test('https://in.indeed.com/jobs?q=java&l=indore');
