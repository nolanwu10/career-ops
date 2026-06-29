const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '..', '..');
const outputRoot = path.join(root, '.amplify-hosting');
const computeRoot = path.join(outputRoot, 'compute', 'default');

require('dotenv').config({ path: path.join(root, '.env') });

const runtimePackage = {
  name: '@career-ops/web-amplify-runtime',
  private: true,
  type: 'commonjs',
  dependencies: {
    'cookie-parser': '^1.4.6',
    dotenv: '^17.2.3',
    express: '^4.19.2',
    helmet: '^7.1.0',
    jszip: '^3.10.1',
    multer: '^2.2.0',
    'pdfjs-dist': '^5.4.296'
  }
};

const deployManifest = {
  version: 1,
  framework: {
    name: 'express',
    version: '4.19.2'
  },
  routes: [
    {
      path: '/*',
      target: {
        kind: 'Compute',
        src: 'default'
      }
    }
  ],
  computeResources: [
    {
      name: 'default',
      runtime: 'nodejs22.x',
      entrypoint: 'index.js'
    }
  ]
};

const launcher = `'use strict';
const path = require('node:path');

process.env.PORT = process.env.PORT || '3000';
process.env.DESKTOP_RENDERER_DIR = process.env.DESKTOP_RENDERER_DIR || path.join(__dirname, 'desktop', 'src', 'renderer');
process.env.PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');

const app = require('./src/server.js');

app.listen(process.env.PORT, () => {
  console.log('Career Ops Amplify server listening on port ' + process.env.PORT);
});
`;

const runtimeEnvKeys = [
  'CLOUD_API_URL',
  'COVER_LETTER_STREAM_URL',
  'COGNITO_DOMAIN',
  'COGNITO_CLIENT_ID',
  'APP_URL',
  'NODE_ENV'
];

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(computeRoot, { recursive: true });

fs.cpSync(path.join(root, 'src'), path.join(computeRoot, 'src'), { recursive: true });
fs.cpSync(path.join(root, 'public'), path.join(computeRoot, 'public'), { recursive: true });
fs.cpSync(
  path.join(repoRoot, 'apps', 'desktop', 'src', 'renderer'),
  path.join(computeRoot, 'desktop', 'src', 'renderer'),
  { recursive: true }
);

fs.writeFileSync(path.join(computeRoot, 'index.js'), launcher);
fs.writeFileSync(path.join(computeRoot, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
fs.writeFileSync(path.join(outputRoot, 'deploy-manifest.json'), `${JSON.stringify(deployManifest, null, 2)}\n`);
const runtimeEnv = runtimeEnvKeys
  .map((key) => [key, process.env[key]])
  .filter(([, value]) => value != null && value !== '')
  .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, '\\n')}`)
  .join('\n');
if (runtimeEnv) {
  fs.writeFileSync(path.join(computeRoot, '.env'), `${runtimeEnv}\n`);
}

execSync(`${npmCommand()} install --omit=dev --no-package-lock`, {
  cwd: computeRoot,
  stdio: 'inherit'
});
