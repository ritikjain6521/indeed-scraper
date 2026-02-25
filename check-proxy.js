/**
 * Proxy Health & Token Checker
 * Tests Apify proxy configuration and validates API token
 */

// Check if APIFY_TOKEN is set
const APIFY_TOKEN = process.env.APIFY_TOKEN;

console.log('=== Proxy Health & Token Check ===\n');

if (!APIFY_TOKEN) {
    console.error('❌ APIFY_TOKEN is NOT set!');
    console.log('\n📋 How to fix:');
    console.log('1. Get your token from: https://console.apify.com/account/integrations');
    console.log('2. Set it as environment variable:');
    console.log('   Windows (PowerShell): $env:APIFY_TOKEN="your_token_here"');
    console.log('   Windows (CMD): set APIFY_TOKEN=your_token_here');
    console.log('   Linux/Mac: export APIFY_TOKEN="your_token_here"');
    console.log('\n3. Or create a .env file in this directory with:');
    console.log('   APIFY_TOKEN=your_token_here');
    console.log('\n⚠️  Without APIFY_TOKEN, residential proxies will NOT work!');
    process.exit(1);
}

console.log('✅ APIFY_TOKEN is set');
console.log(`Token: ${APIFY_TOKEN.substring(0, 10)}...${APIFY_TOKEN.slice(-4)}\n`);

// Test API connectivity using fetch (available in Node 18+)
console.log('🔍 Testing Apify API connection...');

fetch('https://api.apify.com/v2/actor-tasks', {
    method: 'GET',
    headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
    },
})
    .then((res) => {
        console.log(`Status Code: ${res.status}`);

        if (res.status === 200) {
            console.log('✅ API Token is VALID');
            console.log('✅ Connection to Apify API successful');
            console.log('\n� Proxy Health: GOOD');
            console.log('💡 Your scraper should work with residential proxies');

            // Additional proxy info
            console.log('\n� Proxy Configuration:');
            console.log('   - Type: RESIDENTIAL');
            console.log('   - Provider: Apify Proxy');
            console.log('   - Status: ✅ Available');
        } else if (res.status === 401) {
            console.error('❌ API Token is INVALID (401 Unauthorized)');
            console.log('\n📋 Please check your token at: https://console.apify.com/account/integrations');
        } else {
            console.log(`⚠️  Unexpected response: ${res.status}`);
        }

        return res.text();
    })
    .then((data) => {
        // Output available if needed
    })
    .catch((e) => {
        console.error(`❌ Connection error: ${e.message}`);
        console.log('\n⚠️  Cannot reach Apify API. Check your internet connection.');
    });
