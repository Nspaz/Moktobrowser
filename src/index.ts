import { chromium, Browser, BrowserContext, Page, CDPSession } from 'playwright';
import dotenv from 'dotenv';
import chalk from 'chalk';
import pino from 'pino';

dotenv.config();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Sensor simulation constants
const NOISE_MULTIPLIER = 70; // Amplifies random noise for realistic gyroscope drift
const GEO_DRIFT_PROBABILITY = 0.22; // 22% chance per tick to apply GPS drift (simulates sporadic movement)
const GEO_DRIFT_AMOUNT = 0.003; // Base drift distance in degrees (~330m at equator)
const LON_DRIFT_MULTIPLIER = 1.3; // Longitude drifts slightly more to simulate natural walking patterns

interface SensorConfig {
  geo: { lat: number; lon: number; accuracy?: number; intervalMs?: number };
  orientation: { alphaRange: [number, number]; betaRange: [number, number]; gammaRange: [number, number]; intervalMs?: number };
  movementNoise: number;
  viewport: { width: number; height: number };
}

const IPHONE_15_PRO: SensorConfig = {
  geo: { lat: 40.7128, lon: -74.0060, accuracy: 5, intervalMs: 45_000 },
  orientation: { alphaRange: [0, 360], betaRange: [-60, 60], gammaRange: [-45, 45], intervalMs: 2_800 },
  movementNoise: 0.18,
  viewport: { width: 393, height: 852 },
};

class BulletproofOctoMobilePlaywright {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private profileUuid: string;
  private wsEndpoint: string | null = null;
  private isRunning = false;
  private sensorInterval: NodeJS.Timeout | null = null;
  private healthInterval: NodeJS.Timeout | null = null;
  private restartCount = 0;
  private readonly MAX_RESTARTS = 7;
  private config: SensorConfig;
  private currentGeo: { lat: number; lon: number };
  private currentOrientation: { alpha: number; beta: number; gamma: number };

  constructor(uuid: string, config: Partial<SensorConfig> = {}) {
    this.profileUuid = uuid;
    this.config = { ...IPHONE_15_PRO, ...config };
    this.currentGeo = { lat: this.config.geo.lat, lon: this.config.geo.lon };
    this.currentOrientation = { alpha: 35, beta: 25, gamma: 10 };
    this.setupProcessHandlers();
  }

  private log = (level: 'info' | 'warn' | 'error' | 'debug', msg: string, meta?: any) => {
    logger[level]({ profile: this.profileUuid.slice(0, 8), mobile: true, ...meta }, msg);
  };

  /**
   * Retry function with exponential backoff
   */
  private retry = async <T>(fn: () => Promise<T>, maxAttempts = 6, baseDelay = 1200): Promise<T> => {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        this.log('warn', `Attempt ${attempt}/${maxAttempts} failed`, { error: lastError.message });
        
        if (attempt === maxAttempts) {
          throw new Error(`Failed after ${maxAttempts} attempts: ${lastError.message}`);
        }
        
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 30_000);
        this.log('info', `Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError!;
  };

  /**
   * Start Octo profile with API POST and retry logic
   */
  async startOctoProfile(): Promise<string> {
    return this.retry(async () => {
      const apiUrl = process.env.OCTO_API_URL || 'http://localhost:58888/api/profiles/start';
      
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uuid: this.profileUuid,
          headless: process.env.HEADLESS === 'true',
          debug_port: true,
          timeout: 240,
          only_local: true,
          flags: [
            '--start-maximized',
            '--disable-backgrounding-occluded-windows',
            '--enable-touch-events'
          ],
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Octo API ${res.status}: ${text}`);
      }
      
      const data: any = await res.json();
      if (!data.ws_endpoint) {
        throw new Error('No ws_endpoint in response');
      }
      
      const wsEndpoint: string = data.ws_endpoint;
      this.wsEndpoint = wsEndpoint;
      this.log('info', chalk.green('✅ Octo mobile profile started'), { ws: wsEndpoint });
      return wsEndpoint;
    });
  }

  /**
   * Stop Octo profile
   */
  private async stopOctoProfile() {
    if (!this.profileUuid) return;
    
    try {
      const apiUrl = process.env.OCTO_API_URL?.replace('/start', '/stop') || 'http://localhost:58888/api/profiles/stop';
      
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: this.profileUuid }),
      });
      
      if (res.ok) {
        this.log('info', 'Octo profile stopped via API');
      }
    } catch (error) {
      this.log('warn', 'Failed to stop Octo profile via API', { error });
    }
  }

  /**
   * Setup process handlers for lifecycle management
   */
  private setupProcessHandlers() {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

    signals.forEach(signal => {
      process.on(signal, async () => {
        this.log('info', chalk.yellow(`Received ${signal}, shutting down gracefully...`));
        await this.stopAll();
      });
    });

    process.on('uncaughtException', async (error) => {
      this.log('error', 'Uncaught exception', { error: error.message, stack: error.stack });
      await this.restart();
    });

    process.on('unhandledRejection', async (reason) => {
      this.log('error', 'Unhandled rejection', { reason });
      await this.restart();
    });

    this.log('info', 'Process handlers setup complete');
  }

  /**
   * Launch browser with WS/CDP/Emulation (Touch/Retina)
   */
  async launch() {
    this.isRunning = true;
    const ws = await this.startOctoProfile();

    // Connect to Octo Browser via CDP
    this.browser = await chromium.connectOverCDP(ws, { timeout: 60_000 });
    this.context = this.browser.contexts()[0] || await this.browser.newContext();
    this.page = this.context.pages()[0] || await this.context.newPage();

    // Mobile-specific bulletproofing
    await this.context.grantPermissions(['geolocation']);
    await this.context.setGeolocation({
      latitude: this.config.geo.lat,
      longitude: this.config.geo.lon,
      accuracy: this.config.geo.accuracy
    });

    // Force iPhone viewport size
    await this.page.setViewportSize(this.config.viewport);
    
    // Set mobile header for evasion
    await this.page.setExtraHTTPHeaders({ 'Sec-CH-UA-Mobile': '?1' });

    // Initialize CDP session
    this.cdp = await this.context.newCDPSession(this.page);

    // Enable touch emulation via CDP
    await this.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    
    // Set device metrics with Retina scale (3x for iPhone 15 Pro)
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: this.config.viewport.width,
      height: this.config.viewport.height,
      deviceScaleFactor: 3,
      mobile: true,
      screenOrientation: { angle: 0, type: 'portraitPrimary' },
    });

    // Enable virtual sensors for realistic mobile behavior
    await this.cdp.send('Emulation.setSensorOverrideEnabled', { enabled: true, type: 'accelerometer' });
    await this.cdp.send('Emulation.setSensorOverrideEnabled', { enabled: true, type: 'gyroscope' });
    await this.cdp.send('Emulation.setSensorOverrideEnabled', { enabled: true, type: 'magnetometer' });

    // Enable tracing with snapshots and screenshots
    await this.context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    this.log('info', chalk.green('🚀 Playwright + CDP connected to mobile profile'));

    // Setup sensor overrides and start simulations
    await this.setupSensorOverrides();
    this.startSensorSimulation();
    this.startHealthMonitor();

    // Run continuous automation
    await this.runContinuousAutomation();
  }

  /**
   * Setup sensor overrides - Initialize sensors
   */
  private async setupSensorOverrides() {
    if (!this.cdp) {
      throw new Error('CDP session not initialized');
    }

    await this.cdp.send('DeviceOrientation.setDeviceOrientationOverride', {
      alpha: this.currentOrientation.alpha,
      beta: this.currentOrientation.beta,
      gamma: this.currentOrientation.gamma,
    });
    
    this.log('info', chalk.green('All mobile sensor overrides + touch emulation active'));
  }

  /**
   * Random walk for sensor drift with realistic noise
   */
  private randomWalk = (current: number, noise: number) => {
    return current + (Math.random() - 0.5) * noise * NOISE_MULTIPLIER;
  };

  /**
   * Clamp value between min and max
   */
  private clamp = (val: number, min: number, max: number) => {
    return Math.max(min, Math.min(max, val));
  };

  /**
   * Start sensor simulation - setInterval calls randomWalk/clamp → CDP drifts Gyro/Geo
   */
  private startSensorSimulation() {
    const { intervalMs = 2_800 } = this.config.orientation;
    
    this.sensorInterval = setInterval(async () => {
      if (!this.isRunning || !this.cdp) return;
      
      try {
        const { alphaRange, betaRange, gammaRange } = this.config.orientation;
        const { movementNoise } = this.config;
        
        // Apply random walk to orientation with clamping
        this.currentOrientation.alpha = this.clamp(
          this.randomWalk(this.currentOrientation.alpha, movementNoise),
          ...alphaRange
        );
        this.currentOrientation.beta = this.clamp(
          this.randomWalk(this.currentOrientation.beta, movementNoise),
          ...betaRange
        );
        this.currentOrientation.gamma = this.clamp(
          this.randomWalk(this.currentOrientation.gamma, movementNoise),
          ...gammaRange
        );

        // Update device orientation via CDP
        await this.cdp.send('DeviceOrientation.setDeviceOrientationOverride', {
          alpha: this.currentOrientation.alpha,
          beta: this.currentOrientation.beta,
          gamma: this.currentOrientation.gamma,
        });

        // Gentle geolocation drift (realistic walking speed)
        // Only drift occasionally to simulate realistic movement
        if (Math.random() < GEO_DRIFT_PROBABILITY) {
          const drift = (Math.random() - 0.5) * GEO_DRIFT_AMOUNT;
          this.currentGeo.lat += drift;
          this.currentGeo.lon += drift * LON_DRIFT_MULTIPLIER;
          
          await this.context!.setGeolocation({
            latitude: this.currentGeo.lat,
            longitude: this.currentGeo.lon,
            accuracy: this.config.geo.accuracy,
          });
        }
      } catch (e) {
        this.log('warn', 'Sensor tick failed (retrying next cycle)', { error: (e as Error).message });
      }
    }, intervalMs);
    
    this.log('info', chalk.green('📡 Sensor simulation started'), { intervalMs });
  }

  /**
   * Health monitor - Watchdog functionality
   */
  private startHealthMonitor() {
    const healthCheckInterval = 60_000; // 60s heartbeat
    
    this.healthInterval = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        if (!this.page || this.page.isClosed()) {
          this.log('warn', '💔 Health check failed: Page is closed');
          await this.restart();
          return;
        }

        // Check if page is responsive
        const isHealthy = await this.page.evaluate(() => {
          return document.readyState === 'complete';
        }).catch(() => false);

        if (!isHealthy) {
          this.log('warn', '💔 Health check failed: Page not responsive');
          await this.restart();
        } else {
          this.log('debug', '💚 Health check passed');
        }
      } catch (error) {
        this.log('error', 'Error in health monitor', { error: (error as Error).message });
        await this.restart();
      }
    }, healthCheckInterval);
    
    this.log('info', chalk.green('💓 Health monitor started'), { interval: healthCheckInterval });
  }

  /**
   * Run continuous automation - Nav loop
   */
  private async runContinuousAutomation() {
    const testUrls = [
      'https://sensor-tester.glitch.me',
      'https://www.whatismybrowser.com/',
      'https://browserleaks.com/javascript',
      'https://arh.antoinevastel.com/bots/areyouheadless'
    ];

    while (this.isRunning) {
      try {
        this.log('info', chalk.blue('📱 Starting mobile automation cycle...'));
        
        const url = testUrls[Math.floor(Math.random() * testUrls.length)];
        await this.page!.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        
        this.log('info', chalk.green(`✅ Loaded: ${url}`));
        
        // Simulate realistic mobile interaction timing
        const waitTime = 25_000 + Math.random() * 55_000;
        this.log('info', `⏳ Waiting ${Math.round(waitTime / 1000)}s before next cycle...`);
        await new Promise(r => setTimeout(r, waitTime));
      } catch (err) {
        this.log('error', 'Automation cycle crashed', { error: (err as Error).message });
        await new Promise(r => setTimeout(r, 12_000));
      }
    }
  }

  /**
   * Restart automation with auto-heal
   */
  private async restart() {
    if (this.restartCount >= this.MAX_RESTARTS) {
      this.log('error', chalk.red(`❌ Max restart attempts (${this.MAX_RESTARTS}) reached`));
      await this.stopAll(true);
      return;
    }

    this.restartCount++;
    this.log('info', chalk.yellow(`🔄 Restarting (attempt ${this.restartCount}/${this.MAX_RESTARTS})...`));

    try {
      await this.stopAll(true);
      await new Promise(resolve => setTimeout(resolve, 5000));
      await this.launch();
      this.restartCount = 0; // Reset on successful restart
      this.log('info', chalk.green('✅ Restart successful'));
    } catch (error) {
      this.log('error', 'Restart failed', { error: (error as Error).message });
      await new Promise(resolve => setTimeout(resolve, 5000));
      await this.restart(); // Try again
    }
  }

  /**
   * Stop all automation and cleanup
   */
  private async stopAll(silent = false) {
    if (!silent) {
      this.log('info', chalk.yellow('🛑 Stopping all automation...'));
    }

    this.isRunning = false;

    // Clear intervals
    if (this.sensorInterval) {
      clearInterval(this.sensorInterval);
      this.sensorInterval = null;
    }

    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    // Save tracing
    try {
      if (this.context) {
        const tracePath = `trace-${Date.now()}.zip`;
        await this.context.tracing.stop({ path: tracePath });
        this.log('info', chalk.green(`📦 Trace saved to ${tracePath}`));
      }
    } catch (error) {
      this.log('warn', 'Failed to save trace', { error: (error as Error).message });
    }

    // Detach CDP
    if (this.cdp) {
      try {
        await this.cdp.detach();
      } catch (e) {
        // Ignore detach errors
      }
      this.cdp = null;
    }

    // Close page
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.close();
      } catch (e) {
        // Ignore close errors
      }
      this.page = null;
    }

    // Close context
    if (this.context) {
      try {
        await this.context.close();
      } catch (e) {
        // Ignore close errors
      }
      this.context = null;
    }

    // Close browser
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {
        // Ignore close errors
      }
      this.browser = null;
    }

    // Stop Octo profile via API
    await this.stopOctoProfile();

    if (!silent) {
      this.log('info', chalk.green('✅ All automation stopped'));
      process.exit(0);
    }
  }
}

// ====================== USAGE ======================
async function main() {
  const uuid = process.env.OCTO_PROFILE_UUID;
  
  if (!uuid) {
    console.error(chalk.red('❌ OCTO_PROFILE_UUID not set in .env'));
    console.log(chalk.yellow('\n💡 How to get UUID:'));
    console.log('1. Open Octo Browser → Profiles list');
    console.log('2. Hover over your iPhone profile → copy the UUID');
    console.log('3. Or use API: GET http://localhost:58888/api/profiles\n');
    console.log(chalk.cyan('Example .env file:'));
    console.log('OCTO_PROFILE_UUID=your-profile-uuid-here');
    console.log('OCTO_API_URL=http://localhost:58888/api/profiles/start');
    console.log('HEADLESS=false');
    console.log('LOG_LEVEL=info');
    process.exit(1);
  }

  console.log(chalk.green('🚀 Starting BulletproofOctoMobilePlaywright\n'));

  const bot = new BulletproofOctoMobilePlaywright(uuid, {
    viewport: { width: 393, height: 852 }, // iPhone 15 Pro
    geo: { lat: 37.7749, lon: -122.4194, accuracy: 5 }, // San Francisco
    movementNoise: 0.18,
  });

  await bot.launch();
}

main().catch(err => {
  logger.error({ err }, chalk.red('Fatal error'));
  process.exit(1);
});

export default BulletproofOctoMobilePlaywright;
