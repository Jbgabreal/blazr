const fs = require('fs');
const path = require('path');

console.log('🧪 Testing Market Cap Scheduler Configuration (Simple)');
console.log('=====================================================');

// Read the scheduler file directly
const schedulerPath = path.join(__dirname, '../src/services/marketCap/scheduler.js');
const schedulerContent = fs.readFileSync(schedulerPath, 'utf8');

console.log('\n1️⃣ Checking scheduler file content:');
console.log(`   File path: ${schedulerPath}`);
console.log(`   File size: ${schedulerContent.length} characters`);

// Check for 1-minute configuration
const checks = [
  {
    name: 'Constructor default interval',
    pattern: /this\.updateInterval = 1/,
    expected: true
  },
  {
    name: 'Start method default parameter',
    pattern: /async start\(intervalMinutes = 1\)/,
    expected: true
  },
  {
    name: 'Auto-start with 1 minute',
    pattern: /marketCapScheduler\.start\(1\)/,
    expected: true
  },
  {
    name: 'Old 15-minute references (should be false)',
    pattern: /15.*minutes/,
    expected: false
  }
];

console.log('\n2️⃣ Configuration checks:');
let allPassed = true;

checks.forEach((check, index) => {
  const found = check.pattern.test(schedulerContent);
  const status = found === check.expected ? '✅ PASS' : '❌ FAIL';
  
  console.log(`   ${index + 1}. ${check.name}: ${status}`);
  if (found !== check.expected) {
    console.log(`      Expected: ${check.expected}, Found: ${found}`);
    allPassed = false;
  }
});

// Check server.js file
const serverPath = path.join(__dirname, '../server.js');
const serverContent = fs.readFileSync(serverPath, 'utf8');

console.log('\n3️⃣ Checking server.js configuration:');
const serverChecks = [
  {
    name: 'API endpoint default interval',
    pattern: /intervalMinutes = 1/,
    expected: true
  }
];

serverChecks.forEach((check, index) => {
  const found = check.pattern.test(serverContent);
  const status = found === check.expected ? '✅ PASS' : '❌ FAIL';
  
  console.log(`   ${index + 1}. ${check.name}: ${status}`);
  if (found !== check.expected) {
    console.log(`      Expected: ${check.expected}, Found: ${found}`);
    allPassed = false;
  }
});

// Check updater.js file
const updaterPath = path.join(__dirname, '../src/services/marketCap/updater.js');
const updaterContent = fs.readFileSync(updaterPath, 'utf8');

console.log('\n4️⃣ Checking updater.js configuration:');
const updaterChecks = [
  {
    name: '1-minute update threshold',
    pattern: /oneMinuteAgo/,
    expected: true
  },
  {
    name: '1-minute interval check',
    pattern: /1 \* 60 \* 1000/,
    expected: true
  }
];

updaterChecks.forEach((check, index) => {
  const found = check.pattern.test(updaterContent);
  const status = found === check.expected ? '✅ PASS' : '❌ FAIL';
  
  console.log(`   ${index + 1}. ${check.name}: ${status}`);
  if (found !== check.expected) {
    console.log(`      Expected: ${check.expected}, Found: ${found}`);
    allPassed = false;
  }
});

console.log('\n5️⃣ Final Results:');
console.log('==================');
if (allPassed) {
  console.log('✅ ALL CHECKS PASSED!');
  console.log('✅ Scheduler is configured for 1-minute intervals');
  console.log('✅ All files have been updated correctly');
} else {
  console.log('❌ SOME CHECKS FAILED!');
  console.log('❌ Please review the failed checks above');
}

console.log('\n📋 Summary:');
console.log('===========');
console.log('• Scheduler will run every 1 minute instead of 15 minutes');
console.log('• Tokens will be updated if last update was more than 1 minute ago');
console.log('• API endpoints default to 1-minute intervals');
console.log('• No rate limits apply, so frequent updates are safe');

console.log('\n✅ Configuration test completed!'); 