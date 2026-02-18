#!/usr/bin/env node

/**
 * Validation script to check the BulletproofOctoMobilePlaywright implementation
 */

console.log('🔍 Validating BulletproofOctoMobilePlaywright implementation...\n');

const fs = require('fs');
const path = require('path');

const checks = [
  {
    name: 'TypeScript source file exists',
    check: () => fs.existsSync(path.join(__dirname, 'src/index.ts'))
  },
  {
    name: 'Compiled JavaScript exists',
    check: () => fs.existsSync(path.join(__dirname, 'dist/index.js'))
  },
  {
    name: 'Type definitions exist',
    check: () => fs.existsSync(path.join(__dirname, 'dist/index.d.ts'))
  },
  {
    name: 'package.json has required dependencies',
    check: () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
      return pkg.dependencies.playwright && pkg.dependencies.pino && pkg.dependencies.dotenv;
    }
  },
  {
    name: '.env.example template exists',
    check: () => fs.existsSync(path.join(__dirname, '.env.example'))
  },
  {
    name: 'README documentation exists',
    check: () => {
      const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf-8');
      return readme.includes('BulletproofOctoMobilePlaywright') && 
             readme.includes('iPhone 15 Pro') &&
             readme.includes('Sensor');
    }
  }
];

let passed = 0;
let failed = 0;

checks.forEach(({ name, check }) => {
  try {
    const result = check();
    if (result) {
      console.log(`✅ ${name}`);
      passed++;
    } else {
      console.log(`❌ ${name}`);
      failed++;
    }
  } catch (error) {
    console.log(`❌ ${name} (error: ${error.message})`);
    failed++;
  }
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('\n✨ All validation checks passed!');
  console.log('\n📝 Next steps:');
  console.log('1. Copy .env.example to .env');
  console.log('2. Add your OCTO_PROFILE_UUID to .env');
  console.log('3. Ensure Octo Browser is running');
  console.log('4. Run: npm run dev\n');
  process.exit(0);
} else {
  console.log('\n⚠️  Some checks failed. Please review the implementation.');
  process.exit(1);
}
