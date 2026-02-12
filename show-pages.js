const fs = require('fs');

const data = JSON.parse(fs.readFileSync('jobs.json', 'utf8'));

// Group by page
const byPage = {};
data.forEach(job => {
    const page = job.pageNumber || 'No Page Info';
    if (!byPage[page]) byPage[page] = [];
    byPage[page].push(job);
});

// Sort pages
const pages = Object.keys(byPage).sort((a, b) => {
    if (a === 'No Page Info') return 1;
    if (b === 'No Page Info') return -1;
    return parseInt(a) - parseInt(b);
});

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║              INDEED JOBS - PAGE-WISE BREAKDOWN                 ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

pages.forEach(page => {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  PAGE ${page} - ${byPage[page].length} jobs`);
    console.log('='.repeat(70));

    byPage[page].forEach((job, i) => {
        console.log(`\n${i + 1}. ${job.title}`);
        console.log(`   Company: ${job.company}`);
        console.log(`   Location: ${job.location}`);
        if (job.salary) console.log(`   Salary: ${job.salary}`);
        if (job.rating) console.log(`   Rating: ${job.rating}`);
    });
});

console.log(`\n\n${'='.repeat(70)}`);
console.log(`TOTAL: ${data.length} jobs across ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`);
console.log('='.repeat(70) + '\n');
