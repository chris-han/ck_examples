#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');

// Boots the MCP server only when the desired port is available, keeping the
// process alive otherwise so the Next.js dev server can continue to run.

const port = Number.parseInt(process.env.MCP_PORT ?? '7000', 10);
const normalizeBooleanEnv = (value) => {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const skipAutostart = normalizeBooleanEnv(process.env.MCP_SKIP_AUTOSTART);
const forceAutostart = normalizeBooleanEnv(process.env.MCP_FORCE_AUTOSTART);

if (Number.isNaN(port)) {
  console.error(`Invalid MCP port: ${process.env.MCP_PORT}`);
  process.exit(1);
}

function keepProcessAlive() {
  process.stdin.resume();
  const interval = setInterval(() => {}, 1 << 30);
  const clear = () => clearInterval(interval);
  process.once('SIGINT', () => {
    clear();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    clear();
    process.exit(0);
  });
}

function runMcp(targetPort) {
  const child = spawn('npm', ['run', 'dev:mcp', '--', '--port', String(targetPort)], {
    stdio: 'inherit',
    shell: true,
  });

  const forwardSignal = (signal) => {
    child.kill(signal);
  };

  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  child.on('exit', (code, signal) => {
    process.off('SIGINT', forwardSignal);
    process.off('SIGTERM', forwardSignal);
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

try {
  if (skipAutostart) {
    console.log('Skipping local MCP start because MCP_SKIP_AUTOSTART is set.');
    keepProcessAlive();
    return;
  }

  const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' });

  const output = result.stdout?.trim() ?? '';

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      if (forceAutostart) {
        console.warn('Unable to find "lsof"; forcing local MCP start.');
        runMcp(port);
        return;
      }
      console.warn('Unable to find "lsof"; skipping local MCP start. Set MCP_FORCE_AUTOSTART=1 to override.');
      keepProcessAlive();
      return;
    }

    if (result.error.code === 'EPERM') {
      if (forceAutostart) {
        console.warn('Permission denied while checking MCP port; forcing local MCP start.');
        runMcp(port);
        return;
      }
      console.warn('Permission denied while checking MCP port; assuming an MCP server is already running. Set MCP_FORCE_AUTOSTART=1 to override.');
      keepProcessAlive();
      return;
    }

    throw result.error;
  } else if (output.length > 0) {
    console.log(`MCP server already running on port ${port}; skipping local start.`);
    keepProcessAlive();
  } else if (result.status === 0 || result.status === 1) {
    runMcp(port);
  } else {
    console.warn(`Unexpected lsof exit code ${result.status}; assuming MCP port is available.`);
    runMcp(port);
  }
} catch (error) {
  console.error('Error determining MCP port availability:', error);
  process.exit(1);
}
