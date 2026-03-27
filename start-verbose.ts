/**
 * Verbose Backend Startup Script
 * Shows detailed information about what's happening during startup
 */

import './src/config/env.js';

console.log('='.repeat(60));
console.log('🚀 BACKEND SERVER STARTUP - VERBOSE MODE');
console.log('='.repeat(60));
console.log();

// Step 1: Check environment variables
console.log('📋 Step 1: Checking Environment Variables...');
console.log('   PORT:', process.env.PORT || '8080 (default)');
console.log('   DATABASE_URL:', process.env.DATABASE_URL ? '✅ Set' : '❌ Missing');
console.log('   DB_HOST:', process.env.DB_HOST || '❌ Missing');
console.log('   JWT_SECRET:', process.env.JWT_SECRET ? '✅ Set' : '❌ Missing');
console.log('   CRON_ENABLED:', process.env.CRON_ENABLED || 'false');
console.log();

// Step 2: Import and test database
console.log('📋 Step 2: Testing Database Connection...');
try {
  const { pool } = await import('./src/db/postgres.js');
  
  const result = await pool.query('SELECT NOW() as now');
  console.log('   ✅ Database connected!');
  console.log('   📊 Database time:', result.rows[0].now);
  
  // Count tables
  const tableCount = await pool.query(`
    SELECT COUNT(*) as count 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  console.log('   📁 Tables found:', tableCount.rows[0].count);
  console.log();
} catch (error) {
  console.error('   ❌ Database connection FAILED!');
  console.error('   Error:', error.message);
  console.error();
  process.exit(1);
}

// Step 3: Start server
console.log('📋 Step 3: Starting HTTP Server...');
const port = Number(process.env.PORT || 8080);
console.log('   Target port:', port);

try {
  const express = (await import('express')).default;
  const cors = (await import('cors')).default;
  const { registerRoutes } = await import('./src/routes/index.js');
  const { initDatabase } = await import('./src/db/adapter.js');
  const { startCronJobs } = await import('./src/cron.js');
  const { setupSecurityHeaders, generalRateLimiter } = await import('./src/middleware/security.js');
  const { errorHandler, notFoundHandler } = await import('./src/middleware/errorHandler.js');
  const compression = (await import('compression')).default;
  
  await initDatabase();
  
  const app = express();
  app.set('trust proxy', true);
  
  app.use(cors({
    origin: true,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Origin', 'Accept'],
  }));
  
  app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Origin, Accept');
    res.status(204).send();
  });
  
  setupSecurityHeaders(app);
  app.use(compression());
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(generalRateLimiter);
  
  registerRoutes(app);
  app.use(notFoundHandler);
  app.use(errorHandler);
  
  const server = app.listen(port, () => {
    console.log();
    console.log('='.repeat(60));
    console.log('✅ SUCCESS! Backend server is running!');
    console.log('='.repeat(60));
    console.log('   🌐 URL: http://localhost:' + port);
    console.log('   🏥 Health: http://localhost:' + port + '/health');
    console.log('   🔧 Ready: http://localhost:' + port + '/ready');
    console.log('   ⏰ Started at:', new Date().toISOString());
    console.log('   🔄 Uptime: 0s');
    console.log('='.repeat(60));
    
    startCronJobs(port);
  });
  
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error();
      console.error('❌ ERROR: Port ' + port + ' is already in use!');
      console.error('   Solution:');
      console.error('   1. Find process: netstat -ano | findstr :' + port);
      console.error('   2. Kill it: taskkill /PID <number> /F');
      console.error('   3. Or change PORT in .env file');
      process.exit(1);
    } else {
      console.error('Server error:', err);
      throw err;
    }
  });
  
} catch (error) {
  console.error();
  console.error('❌ FATAL ERROR during startup!');
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}
