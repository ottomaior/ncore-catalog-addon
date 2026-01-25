const { exec } = require('child_process');
const cron = require('node-cron');

console.log('🕐 Cron scheduler started!');

// Run movie scraper every 3 hours
cron.schedule('0 */3 * * *', () => {
    console.log('⏰ Running movie scraper...');
    exec('cd scripts && python sync_rss_to_trakt.py', (error, stdout, stderr) => {
        if (error) {
            console.error(`Movie scraper error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`Movie scraper stderr: ${stderr}`);
        }
        console.log(`Movie scraper output: ${stdout}`);
        console.log('✅ Movie scraper completed!');
    });
});

// Run series scraper every 3 hours (offset by 30 minutes)
cron.schedule('30 */3 * * *', () => {
    console.log('⏰ Running series scraper...');
    exec('cd scripts && python sync_series_rss_to_trakt.py', (error, stdout, stderr) => {
        if (error) {
            console.error(`Series scraper error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`Series scraper stderr: ${stderr}`);
        }
        console.log(`Series scraper output: ${stdout}`);
        console.log('✅ Series scraper completed!');
    });
});

console.log('📋 Scheduled tasks:');
console.log('  - Movies: Every 3 hours (00:00, 03:00, 06:00, ...)');
console.log('  - Series: Every 3 hours (00:30, 03:30, 06:30, ...)');
