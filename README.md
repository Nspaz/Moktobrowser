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

```bash
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
