import { WorkerService } from '../src/services/worker-service.ts';

const worker = new WorkerService();

try {
  await worker.start();
  console.log('[worker-direct] Worker started');
} catch (error) {
  console.error('[worker-direct] Worker failed to start', error);
  process.exit(1);
}
