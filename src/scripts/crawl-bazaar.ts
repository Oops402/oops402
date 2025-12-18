/**
 * Development script to crawl and cache x402 bazaar resources
 * 
 * Usage: npm run crawl-bazaar
 */

import { crawlAllResources } from '../modules/x402/bazaarService.js';
import { logger } from '../modules/shared/logger.js';

async function main() {
  try {
    console.log('Starting bazaar resources crawl...');
    await crawlAllResources();
    console.log('Bazaar resources crawl completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Failed to crawl bazaar resources:', error);
    logger.error('Bazaar crawl script failed', error as Error);
    process.exit(1);
  }
}

main();

