module.exports = {
  apps: [
    {
      name: "marketplace-worker",
      cwd: __dirname,
      script: "npm",
      args: "run worker:marketplace",
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "512M",
      kill_timeout: 600000,
      time: false,
      env: {
        NODE_ENV: "production",
        MARKETPLACE_WORKER_BATCH_SIZE: "5",
        MARKETPLACE_WORKER_IDLE_MIN_MS: "2000",
        MARKETPLACE_WORKER_IDLE_MAX_MS: "30000",
        MARKETPLACE_WORKER_ERROR_MIN_MS: "5000",
        MARKETPLACE_WORKER_ERROR_MAX_MS: "60000"
      }
    }
  ]
};
