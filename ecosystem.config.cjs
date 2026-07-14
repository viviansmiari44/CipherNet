module.exports = {
  apps: [
    // ==========================================
    // ETHEREUM MICROSERVICES
    // ==========================================
    {
      name: 'collector-eth',
      script: 'src/collector.js',
      env: { CHAIN: 'ethereum' },
      autorestart: true,
      max_memory_restart: '1G',
    },
    {
      name: 'observer-eth',
      script: 'src/observer.js',
      env: { CHAIN: 'ethereum' },
      autorestart: true,
      max_memory_restart: '500M',
    },
    {
      name: 'repoison-eth',
      script: 'src/re_poison.js',
      env: { CHAIN: 'ethereum' },
      autorestart: true,
      max_memory_restart: '500M',
    },
    {
      name: 'sweeper-eth',
      script: 'src/sweeper.js',
      env: { CHAIN: 'ethereum' },
      autorestart: true,
      max_memory_restart: '500M',
    },

    // ==========================================
    // BINANCE SMART CHAIN (BSC) MICROSERVICES
    // ==========================================
    {
      name: 'collector-bsc',
      script: 'src/collector.js',
      env: { CHAIN: 'bsc' },
      autorestart: true,
      max_memory_restart: '1G',
    },
    {
      name: 'observer-bsc',
      script: 'src/observer.js',
      env: { CHAIN: 'bsc' },
      autorestart: true,
      max_memory_restart: '500M',
    },
    {
      name: 'repoison-bsc',
      script: 'src/re_poison.js',
      env: { CHAIN: 'bsc' },
      autorestart: true,
      max_memory_restart: '500M',
    },
    {
      name: 'sweeper-bsc',
      script: 'src/sweeper.js',
      env: { CHAIN: 'bsc' },
      autorestart: true,
      max_memory_restart: '500M',
    },

    // ==========================================
    // POLYGON MICROSERVICES
    // ==========================================
    {
      name: 'collector-polygon',
      script: 'src/collector.js',
      env: { CHAIN: 'polygon' },
      autorestart: true,
      max_memory_restart: '1G',
    },
    {
      name: 'observer-polygon',
      script: 'src/observer.js',
      env: { CHAIN: 'polygon' },
      autorestart: true,
      max_memory_restart: '500M',
    },
    {
      name: 'repoison-polygon',
      script: 'src/re_poison.js',
      env: { CHAIN: 'polygon' },
      autorestart: true,
      max_memory_restart: '500M',
    },
    {
      name: 'sweeper-polygon',
      script: 'src/sweeper.js',
      env: { CHAIN: 'polygon' },
      autorestart: true,
      max_memory_restart: '500M',
    },
    {
      name: 'webhook',
      script: 'webhook-server.js',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_memory_restart: '500M',
    },
  ],
};