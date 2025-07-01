#!/usr/bin/env node

/**
 * Production startup script
 * Ensures market cap scheduler is properly initialized
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting Blazr Server...\n');

// Set environment (production or development)
const isProduction = process.env.NODE_ENV === 'production';
console.log(`🌍 Environment: ${isProduction ? 'Production' : 'Development'}`);
console.log('📊 Market cap scheduler will auto-start in all environments');

// Start the server
const server = spawn('node', ['server.js'], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd()
});

// Handle server process
server.on('error', (error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});

server.on('exit', (code) => {
  console.log(`\n🛑 Server exited with code ${code}`);
  process.exit(code);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  server.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down server...');
  server.kill('SIGTERM');
});

console.log('✅ Startup script initialized');
console.log('📊 Market cap scheduler will auto-start in all environments');
console.log('⏰ Updates will run every 15 minutes\n'); 