import cron from 'node-cron';
import { fetch } from 'undici';

const defaultInterval = '* * * * *';

function getBackendBaseUrl(port: number): string {
  return process.env.BACKEND_BASE_URL || `http://127.0.0.1:${port}`;
}

async function postCron(path: string, baseUrl: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'cron' }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[cron] ${path} failed: ${response.status} ${text}`);
    } else {
      console.log(`[cron] ${path} executed`);
    }
  } catch (error) {
    console.error(`[cron] ${path} error:`, error);
  }
}

export function startCronJobs(port: number): void {
  if (process.env.CRON_ENABLED === 'false') {
    console.log('[cron] disabled by CRON_ENABLED=false');
    return;
  }

  const baseUrl = getBackendBaseUrl(port);
  const autoSignalSchedule = process.env.AUTO_SIGNAL_CRON || defaultInterval;
  const positionMonitorSchedule = process.env.POSITION_MONITOR_CRON || defaultInterval;

  cron.schedule(autoSignalSchedule, () => {
    void postCron('/api/auto-signal-generator', baseUrl);
  });

  cron.schedule(positionMonitorSchedule, () => {
    void postCron('/api/position-monitor', baseUrl);
  });

  console.log(
    `[cron] jobs scheduled | auto-signal: "${autoSignalSchedule}" | position-monitor: "${positionMonitorSchedule}" | baseUrl: ${baseUrl}`
  );
}

