'use strict';

/**
 * Test runner.
 *
 * Starts the app in test mode, which loads the harness page instead of the
 * editor and exits with the suite's status. WebGL is not needed by the suite,
 * so the run works on a machine with no display driver worth speaking of.
 */

const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electron = require(path.join(root, 'node_modules', 'electron'));

const args = [root, '--anvil-test'];
if (process.argv.includes('--debug')) args.push('--anvil-debug');

const child = spawn(electron, args, {
  cwd: root,
  stdio: ['ignore', 'inherit', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  stderr += text;
  // Electron is noisy about GPU and network services in a headless run; only
  // surface lines that could actually explain a failure.
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (/gpu|GPU|network_service|Vulkan|dxgi|swiftshader|DevTools/i.test(line)) continue;
    process.stderr.write(`${line}\n`);
  }
});

const timer = setTimeout(() => {
  process.stderr.write('\nTest run timed out after 120s\n');
  child.kill();
  process.exit(1);
}, 120000);

child.on('exit', (code) => {
  clearTimeout(timer);
  if (code !== 0 && code !== 1) {
    process.stderr.write(`\nElectron exited with ${code}\n${stderr}\n`);
  }
  process.exit(code === 0 ? 0 : 1);
});
