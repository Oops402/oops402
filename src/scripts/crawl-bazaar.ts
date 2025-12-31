/**
 * Development script to crawl and cache x402 bazaar resources
 * 
 * Usage: 
 *   npm run crawl-bazaar - Crawl bazaar resources and save to Supabase
 *   npm run crawl-bazaar -- --migrate - Migrate existing JSON file to Supabase (one-time)
 */

import { crawlAllResources } from '../modules/x402/bazaarService.js';
import { migrateJsonToDatabase } from '../modules/x402/bazaarDbService.js';
import { logger } from '../modules/shared/logger.js';

async function main() {
  const args = process.argv.slice(2);
  const shouldMigrate = args.includes('--migrate');

  try {
    if (shouldMigrate) {
      console.log('Starting migration of JSON bazaar resources to Supabase...');
      await migrateJsonToDatabase();
      console.log('Migration completed successfully!');
    } else {
      console.log('Starting bazaar resources crawl...');
      await crawlAllResources();
      console.log('Bazaar resources crawl completed successfully!');
    }
    process.exit(0);
  } catch (error) {
    console.error('Failed:', error);
    logger.error('Bazaar script failed', error as Error);
    process.exit(1);
  }
}

main();

