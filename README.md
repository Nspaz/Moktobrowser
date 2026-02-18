# Moktobrowser

**BulletproofOctoMobilePlaywright** - Advanced TypeScript/Playwright/CDP automation script that simulates realistic mobile device behavior with Octo Browser integration.

## Features

### Mobile Emulation
- **iPhone 15 Pro Configuration**: Accurate viewport (393x852), Retina display (3x scale), mobile user agent
- **Touch Emulation**: CDP-enabled touch events with multi-touch support (5 points)
- **Device Metrics Override**: Portrait orientation, mobile screen settings
- **Mobile Headers**: `Sec-CH-UA-Mobile: ?1` for proper mobile detection

### Sensor Simulation
- **Real-time Gyroscope Drift**: DeviceOrientation (alpha, beta, gamma) with randomWalk noise
- **GPS Drift**: Geolocation updates with realistic walking-speed movement
- **Noise Mathematics**: Configurable movement noise (0.18 default) with clamping
- **Virtual Sensors**: Accelerometer, gyroscope, and magnetometer overrides

### Automation & Evasion
- **API Integration**: POST to Octo Browser API with retry logic (exponential backoff)
- **Continuous Navigation**: Loop through URLs with random timing
- **Tracing**: Screenshots, snapshots, and sources captured to trace.zip
- **Flags**: `--start-maximized`, `--disable-backgrounding-occluded-windows`, `--enable-touch-events`

### Reliability Features
- **Health Monitor**: Watchdog checks page responsiveness every 60s
- **Auto-Heal**: Automatic restart on failures (max 7 attempts)
- **Process Handlers**: Graceful shutdown on SIGINT/SIGTERM/SIGQUIT
- **Error Recovery**: Uncaught exceptions and unhandled rejections trigger restart
- **Pino Logging**: Structured JSON logging with pretty output

## Installation


New behavior (exactly what you asked for):
	•	Y/N prompt has 30-second timeout → if you don’t answer or it times out → automatically treats as “N” (no MoneyMe).
	•	No infinite loop ever.
	•	Only 1 or 2 automation cycles max:
	◦	If you choose Y and MoneyMe page loads successfully → runs exactly 1 cycle on MoneyMe → then clean shutdown.
	◦	If you choose N, timeout, or navigation fails → runs exactly 2 cycles (on sensor-tester) → then clean shutdown.
	•	After the cycles finish → automatically stops the Octo profile, closes browser, saves trace.zip, and exits. No zombies, no forever running.
Your “(imported) iphone” profile + custom port still auto-detected perfectly.

Full `Program.cs` (replace everything)
using Microsoft.Playwright;
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Timers;

namespace OctoBulletproof
{
    public class OctoProfileListItem
    {
        public string Uuid { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
    }

    public class BulletproofOctoMobilePlaywright : IDisposable
    {
        private readonly string _profileUuid;
        private readonly int _localApiPort;
        private readonly string _targetMoneyMeUrl = "https://moneyme.com.au/u?c=MTQwMjE4MTM";

        private IBrowser? _browser;
        private IBrowserContext? _context;
        private IPage? _page;
        private ICDPSession? _cdp;
        private System.Timers.Timer? _sensorTimer;
        private System.Timers.Timer? _healthTimer;
        private bool _isRunning;
        private int _restartCount;
        private readonly int _maxRestarts = 7;
        private readonly HttpClient _http = new();
        private readonly CancellationTokenSource _cts = new();
        private bool _moneyMeSuccess = false;

        public BulletproofOctoMobilePlaywright(string profileUuid, int localApiPort)
        {
            _profileUuid = profileUuid;
            _localApiPort = localApiPort;
            SetupShutdownHandlers();
        }

        private void Log(string level, string message)
        {
            var color = level.ToLower() switch
            {
                "error" => ConsoleColor.Red,
                "warn" => ConsoleColor.Yellow,
                "info" => ConsoleColor.Cyan,
                _ => ConsoleColor.White
            };
            Console.ForegroundColor = color;
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] [{level.ToUpper()}] {message} | {_profileUuid.Substring(0, 8)}");
            Console.ResetColor();
        }

        private async Task RetryAsync(Func> action, int maxAttempts = 6)
        {
            for (int attempt = 1; attempt <= maxAttempts; attempt++)
            {
                try { return await action(); }
                catch (Exception ex)
                {
                    Log("WARN", $"Attempt {attempt}/{maxAttempts} failed: {ex.Message}");
                    if (attempt == maxAttempts) throw;
                    await Task.Delay(1200 * attempt + Random.Shared.Next(300));
                }
            }
            throw new Exception("Retry exhausted");
        }

        private async Task StartOctoProfileAsync()
        {
            return await RetryAsync(async () =>
            {
                var payload = new
                {
                    uuid = _profileUuid,
                    headless = Environment.GetEnvironmentVariable("HEADLESS") == "true",
                    debug_port = true,
                    timeout = 240,
                    only_local = true,
                    flags = new[] { "--start-maximized", "--enable-touch-events" }
                };

                var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
                var response = await _http.PostAsync($"http://localhost:{_localApiPort}/api/profiles/start", content);
                response.EnsureSuccessStatusCode();

                var json = await response.Content.ReadAsStringAsync();
                using var doc = JsonDocument.Parse(json);
                var ws = doc.RootElement.GetProperty("ws_endpoint").GetString();
                if (string.IsNullOrEmpty(ws)) throw new Exception("No ws_endpoint");
                Log("INFO", "✅ Octo Android profile started");
                return ws;
            });
        }

        public static async Task<(string Uuid, int Port)> AutoDetectProfileAndPortAsync()
        {
            int port = 58888;
            while (true)
            {
                Console.Write($"Enter Octo Local API port [{port}]: ");
                var input = Console.ReadLine()?.Trim();
                if (!string.IsNullOrEmpty(input) && int.TryParse(input, out int p)) port = p;

                try
                {
                    using var http = new HttpClient();
                    var res = await http.GetAsync($"http://localhost:{port}/api/profiles");
                    if (res.IsSuccessStatusCode)
                    {
                        Console.WriteLine($"✅ Connected to Octo on port {port}");
                        break;
                    }
                }
                catch { }

                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"❌ Cannot connect to port {port}.");
                Console.WriteLine("   Open Octo Browser → ⚙️ Settings → Local API → copy the exact Port value.");
                Console.ResetColor();
            }

            using var http2 = new HttpClient();
            var listJson = await http2.GetStringAsync($"http://localhost:{port}/api/profiles");
            var profiles = JsonSerializer.Deserialize>(listJson) ?? new List();

            var iphoneProfiles = profiles.FindAll(p => p.Name.ToLowerInvariant().Contains("iphone"));

            if (iphoneProfiles.Count == 1)
            {
                var uuid = iphoneProfiles[0].Uuid;
                Console.WriteLine($"✅ Auto-detected profile \"{iphoneProfiles[0].Name}\" → {uuid}");
                return (uuid, port);
            }

            Console.WriteLine("Found profiles:");
            for (int i = 0; i < profiles.Count; i++)
                Console.WriteLine($"  {i + 1}. {profiles[i].Name} → {profiles[i].Uuid}");

            Console.Write("\nPaste exact UUID or type number from list: ");
            var choice = Console.ReadLine()?.Trim();

            if (int.TryParse(choice, out int idx) && idx > 0 && idx <= profiles.Count)
                return (profiles[idx - 1].Uuid, port);

            return (choice!, port);
        }

        public async Task LaunchAsync()
        {
            _isRunning = true;
            var ws = await StartOctoProfileAsync();

            var pw = await Playwright.CreateAsync();
            _browser = await pw.Chromium.ConnectOverCDPAsync(ws);

            _context = _browser.Contexts.Count > 0 ? _browser.Contexts[0] : await _browser.NewContextAsync();
            _page = _context.Pages.Count > 0 ? _context.Pages[0] : await _context.NewPageAsync();

            await _context.GrantPermissionsAsync(["geolocation"]);
            await _context.SetGeolocationAsync(new Geolocation { Latitude = 51.5074, Longitude = -0.1278, Accuracy = 5 });

            await _page.SetViewportSizeAsync(393, 852);
            await _page.SetExtraHTTPHeadersAsync(new Dictionary { ["Sec-CH-UA-Mobile"] = "?1" });

            _cdp = await _context.NewCDPSessionAsync(_page);

            await _cdp.SendAsync("Emulation.setTouchEmulationEnabled", new { enabled = true });
            await _cdp.SendAsync("Emulation.setDeviceMetricsOverride", new
            {
                width = 393, height = 852, deviceScaleFactor = 3, mobile = true,
                screenOrientation = new { angle = 0, type = "portraitPrimary" }
            });

            await _cdp.SendAsync("Emulation.setSensorOverrideEnabled", new { enabled = true, type = "accelerometer" });
            await _cdp.SendAsync("Emulation.setSensorOverrideEnabled", new { enabled = true, type = "gyroscope" });
            await _cdp.SendAsync("Emulation.setSensorOverrideEnabled", new { enabled = true, type = "magnetometer" });

            await _context.Tracing.StartAsync(new TracingStartOptions { Screenshots = true, Snapshots = true });

            Log("INFO", "🚀 Playwright + CDP connected");

            await SetupSensorOverridesAsync();
            StartSensorSimulation();
            StartHealthMonitor();

            // === Y/N PROMPT WITH 30s TIMEOUT ===
            Console.WriteLine();
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.Write($"Do you want to navigate to {_targetMoneyMeUrl} now? (y/n) [30s timeout]: ");
            Console.ResetColor();

            string? resp;
            var readTask = Task.Run(() => Console.ReadLine());
            var timeoutTask = Task.Delay(30000);
            if (await Task.WhenAny(readTask, timeoutTask) == readTask)
            {
                resp = await readTask;
            }
            else
            {
                Console.WriteLine("\n⏰ Timeout - skipping MoneyMe.");
                resp = "n";
            }

            resp = resp?.Trim().ToLowerInvariant();

            if (resp == "y" || resp == "yes" || resp == "1")
            {
                Log("INFO", "🚀 Navigating to MoneyMe...");
                try
                {
                    await _page!.GotoAsync(_targetMoneyMeUrl, new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 90000 });
                    _moneyMeSuccess = true;
                    Log("INFO", "✅ MoneyMe page loaded successfully");
                }
                catch (Exception ex)
                {
                    Log("ERROR", $"MoneyMe navigation failed: {ex.Message}");
                    _moneyMeSuccess = false;
                }
            }
            else
            {
                Log("INFO", "Skipping MoneyMe. Loading sensor tester.");
                await _page!.GotoAsync("https://sensor-tester.glitch.me", new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle });
                _moneyMeSuccess = false;
            }

            await RunContinuousAutomationAsync();
        }

        private async Task SetupSensorOverridesAsync()
        {
            await _cdp!.SendAsync("DeviceOrientation.setDeviceOrientationOverride", new { alpha = 35, beta = 25, gamma = 10, absolute = true });
        }

        private void StartSensorSimulation()
        {
            _sensorTimer = new System.Timers.Timer(2800);
            _sensorTimer.Elapsed += async (_, _) =>
            {
                if (!_isRunning || _cdp == null) return;
                try
                {
                    var alpha = Clamp(RandomWalk(180, 0.18), 0, 360);
                    var beta = Clamp(RandomWalk(25, 0.18), -60, 60);
                    var gamma = Clamp(RandomWalk(12, 0.18), -45, 45);

                    await _cdp.SendAsync("DeviceOrientation.setDeviceOrientationOverride", new { alpha, beta, gamma, absolute = true });

                    if (Random.Shared.NextDouble() < 0.22)
                    {
                        var drift = (Random.Shared.NextDouble() - 0.5) * 0.003;
                        await _context!.SetGeolocationAsync(new Geolocation
                        {
                            Latitude = 51.5074 + drift,
                            Longitude = -0.1278 + drift * 1.3,
                            Accuracy = 5
                        });
                    }
                }
                catch { }
            };
            _sensorTimer.Start();
        }

        private void StartHealthMonitor()
        {
            _healthTimer = new System.Timers.Timer(60000);
            _healthTimer.Elapsed += async (_, _) =>
            {
                try
                {
                    await (_page?.EvaluateAsync("() => navigator.userAgent") ?? Task.CompletedTask);
                    Log("INFO", "Health check OK");
                }
                catch
                {
                    Log("ERROR", "Health check failed → restarting");
                    await RestartAsync();
                }
            };
            _healthTimer.Start();
        }

        private async Task RunContinuousAutomationAsync()
        {
            int maxCycles = _moneyMeSuccess ? 1 : 2;
            for (int cycle = 0; cycle < maxCycles; cycle++)
            {
                try
                {
                    Log("INFO", $"📱 Running automation cycle {cycle + 1}/{maxCycles}");
                    // ←←← YOUR REAL AUTOMATION CODE GOES HERE (clicks, scrolls, fills, etc.)

                    if (cycle < maxCycles - 1)
                        await Task.Delay(25000 + Random.Shared.Next(55000), _cts.Token);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    Log("ERROR", $"Cycle error: {ex.Message}");
                    await Task.Delay(12000);
                }
            }

            Log("INFO", "✅ All automation cycles completed. Shutting down...");
            await StopAllAsync();
            Environment.Exit(0);
        }

        private double RandomWalk(double current, double noise) => current + (Random.Shared.NextDouble() - 0.5) * noise * 70;
        private double Clamp(double val, double min, double max) => Math.Max(min, Math.Min(max, val));

        private async Task RestartAsync()
        {
            if (_restartCount >= _maxRestarts) { Log("ERROR", "Max restarts reached"); Environment.Exit(1); }
            _restartCount++;
            Log("WARN", $"♻️ Restarting ({_restartCount}/{_maxRestarts})");
            await StopAllAsync();
            await Task.Delay(8000);
            await LaunchAsync();
        }

        private async Task StopAllAsync()
        {
            _isRunning = false;
            _sensorTimer?.Stop();
            _healthTimer?.Stop();

            try { await _context?.Tracing.StopAsync(new TracingStopOptions { Path = $"trace-{DateTime.Now:yyyyMMddHHmmss}.zip" }); } catch { }
            try { await _browser?.CloseAsync(); } catch { }

            try
            {
                var stopContent = new StringContent(JsonSerializer.Serialize(new { uuid = _profileUuid }), Encoding.UTF8, "application/json");
                await _http.PostAsync($"http://localhost:{_localApiPort}/api/profiles/stop", stopContent);
            }
            catch { }

            Log("INFO", "✅ Clean shutdown complete");
        }

        private void SetupShutdownHandlers()
        {
            Console.CancelKeyPress += async (s, e) => { e.Cancel = true; await StopAllAsync(); Environment.Exit(0); };
            AppDomain.CurrentDomain.ProcessExit += async (s, e) => await StopAllAsync();
        }

        public void Dispose() => _cts.Cancel();
    }

    class Program
    {
        static async Task Main(string[] args)
        {
            Console.WriteLine("=== Octo Bulletproof Mobile Automation (limited 1-2 cycles) ===");

            var (uuid, port) = await BulletproofOctoMobilePlaywright.AutoDetectProfileAndPortAsync();

            using var bot = new BulletproofOctoMobilePlaywright(uuid, port);
            await bot.LaunchAsync();
        }
    }
}
```CS
Setup reminder
	•	NuGet: Microsoft.Playwright
	•	playwright install (once)
	•	F5 → type your custom port → it auto-finds “(imported) iphone” → 30s Y/N prompt → 1 or 2 cycles → auto-exit.
Drop your real clicks/fills/etc. inside the // ←←← YOUR REAL AUTOMATION CODE GOES HERE comment.
This is now exactly the limited-run version you wanted. Ready for immediate use on your profile. Let me know when you want to add specific MoneyMe automation steps! 🚀 _


# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env and add your Octo Browser profile UUID
nano .env
```

## Configuration

### Environment Variables

Create a `.env` file with the following:

```env
OCTO_PROFILE_UUID=your-profile-uuid-here
OCTO_API_URL=http://localhost:58888/api/profiles/start
HEADLESS=false
LOG_LEVEL=info
```

### Getting Your Profile UUID

1. Open Octo Browser → Profiles list
2. Hover over your iPhone/mobile profile
3. Copy the UUID from the profile details
4. Or use API: `GET http://localhost:58888/api/profiles`

### Sensor Configuration

Customize sensor behavior in the script:

```typescript
const config = {
  viewport: { width: 393, height: 852 },        // iPhone 15 Pro
  geo: { lat: 37.7749, lon: -122.4194 },        // Starting location
  orientation: {
    alphaRange: [0, 360],                        // Compass heading
    betaRange: [-60, 60],                        // Tilt front/back
    gammaRange: [-45, 45],                       // Tilt left/right
    intervalMs: 2800                             // Update frequency
  },
  movementNoise: 0.18                            // Drift intensity
};
```

## Usage

### Development Mode
```bash
npm run dev
```

### Production Build
```bash
npm run build
npm start
```

## Architecture

### Core Functions

#### `launch()`
- Initializes WebSocket connection to Octo Browser
- Establishes CDP session for low-level control
- Configures Touch/Retina emulation
- Grants permissions and sets initial geolocation

#### `startOctoProfile()`
- POST request to Octo API with profile UUID
- Retry logic with exponential backoff (6 attempts)
- Returns WebSocket endpoint for CDP connection

#### `setupSensorOverrides()`
- Initializes DeviceOrientation override
- Sets initial gyroscope values (alpha, beta, gamma)
- Enables virtual sensor hardware

#### `startSensorSimulation()`
- setInterval (default 2.8s) for continuous updates
- Applies `randomWalk()` with `clamp()` to orientation angles
- Occasional GPS drift (22% probability per tick)
- CDP sends for real-time sensor value updates

#### `runContinuousAutomation()`
- Navigation loop through configured URLs
- Random timing (25-80s) between pages
- Demonstrates mobile automation patterns

#### `startHealthMonitor()`
- Watchdog checks every 60 seconds
- Validates page state and responsiveness
- Triggers restart if unhealthy

#### `restart()`
- Auto-heal mechanism with retry limit
- Clean shutdown of existing session
- Re-launch with fresh state

#### `stopAll()`
- Lifecycle management for graceful shutdown
- Saves tracing data to timestamped zip
- Cleans up all resources (CDP, page, context, browser)
- Stops Octo profile via API

#### `setupProcessHandlers()`
- Signal handlers for SIGINT/SIGTERM/SIGQUIT
- Global error handlers for uncaught exceptions
- Ensures clean exit in all scenarios

### Logging

Pino structured logging with metadata:
```typescript
log('info', 'Message', { key: 'value' });
// Output: {"level":30,"time":"...","profile":"abc12345","mobile":true,"key":"value","msg":"Message"}
```

## Requirements

- **Node.js**: 18+ (for native fetch API)
- **Octo Browser**: Running locally with API enabled (default port 58888)
- **Playwright**: 1.40.0+
- **Operating System**: Windows, macOS, or Linux

## Testing URLs

The script includes several test URLs for validation:
- `https://sensor-tester.glitch.me` - DeviceOrientation/Motion API testing
- `https://www.whatismybrowser.com/` - User agent validation
- `https://browserleaks.com/javascript` - Browser fingerprinting check
- `https://arh.antoinevastel.com/bots/areyouheadless` - Headless detection

## Troubleshooting

### "OCTO_PROFILE_UUID not set"
- Ensure `.env` file exists in project root
- Verify profile UUID is correct (no quotes needed)

### "Failed to connect to CDP"
- Check Octo Browser is running
- Verify API URL is correct (default: `http://localhost:58888`)
- Ensure profile exists and is not already running

### Sensor values not changing
- Check browser console for DeviceOrientation API availability
- Some test sites may not expose sensor data
- Use `sensor-tester.glitch.me` for real-time validation

## License

MIT
