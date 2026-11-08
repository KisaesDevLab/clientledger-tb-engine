// Builds the desktop engine as a Node Single Executable Application.
//
//   node scripts/desktop/build.mjs            bundle + SEA for this platform
//   node scripts/desktop/build.mjs --bundle   bundle only (dist-desktop/engine.cjs)
//
// Output in dist-desktop/: clientledger-tb-engine[.exe] plus resources/
// (knowledge base and Statement Writer fonts), which the launcher points at
// with KNOWLEDGE_DIR and FS_FONT_DIR. See docs/DESKTOP.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(server, 'dist-desktop');
const bundleOnly = process.argv.includes('--bundle');

// knex resolves every SQL dialect's driver lazily; only pg is used.
const EXTERNAL = ['mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'oracledb', 'tedious', 'pg-query-stream', 'pg-native'];

// Desktop builds don't use or install @kisaesdevlab/vibe-auth (Q12):
// - the package name resolves to src/desktop/vibeAuthStub.ts (local mode);
// - migration 20260916000001 reads Vibe Auth's SQL through require.resolve;
//   it gets the vendored copy in src/desktop/vendor/ instead.
const VIBE_AUTH_STUB = path.join(server, 'src/desktop/vibeAuthStub.ts');
const VIBE_AUTH_SQL = path.join(server, 'src/desktop/vendor/vibe-auth-auth_identities.sql');
const vibeAuthStub = {
  name: 'vibe-auth-stub',
  setup(build) {
    build.onResolve({ filter: /^@kisaesdevlab\/vibe-auth(\/.*)?$/ }, (args) => {
      if (args.path === '@kisaesdevlab/vibe-auth') return { path: VIBE_AUTH_STUB };
      throw new Error(`desktop bundle: unexpected import of ${args.path} from ${args.importer}`);
    });
  },
};
const inlineVibeAuthSql = {
  name: 'inline-vibe-auth-sql',
  setup(build) {
    build.onLoad({ filter: /20260916000001_vibe_auth\.js$/ }, async (args) => {
      const src = await fs.promises.readFile(args.path, 'utf8');
      const needle = "const file = require.resolve('@kisaesdevlab/vibe-auth/sql/auth_identities.sql');\n  return fs.readFileSync(file, 'utf8');";
      const normalized = src.replace(/\r\n/g, '\n');
      if (!normalized.includes(needle)) throw new Error('vibe_auth migration changed upstream; update inline-vibe-auth-sql');
      return {
        contents: normalized.replace(needle, `return require(${JSON.stringify(VIBE_AUTH_SQL)});`),
        loader: 'js',
      };
    });
  },
};

// pdfkit, fontkit and linebreak read data files that sit next to them
// (`readFileSync(__dirname + '/data.trie')`, `${__dirname}/data/x.icc`). Inside
// a bundle __dirname is the bundle's folder, so inline those files.
const DIRNAME_READ = /(?:require\(\s*['"]fs['"]\s*\)|[\w$]+)\.readFileSync\(\s*(?:__dirname\s*\+\s*(['"])([^'"]+)\1|`\$\{__dirname\}([^`$]+)`)\s*(?:,\s*(['"])(\w+)\4\s*)?\)/g;
const inlineDirnameReads = {
  name: 'inline-dirname-reads',
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/]@foliojs-fork[\\/].*\.js$/ }, async (args) => {
      const src = await fs.promises.readFile(args.path, 'utf8');
      if (!src.includes('__dirname')) return undefined;
      const dir = path.dirname(args.path);
      const contents = src.replace(DIRNAME_READ, (whole, _q, rel1, rel2, _q2, enc) => {
        const file = path.join(dir, rel1 ?? rel2);
        if (!fs.existsSync(file)) return whole; // test-only paths
        const bytes = fs.readFileSync(file);
        if (enc === 'utf8' || enc === 'utf-8') return JSON.stringify(bytes.toString('utf8'));
        if (enc === 'base64') return JSON.stringify(bytes.toString('base64'));
        if (enc) throw new Error(`inline-dirname-reads: unsupported encoding ${enc} in ${args.path}`);
        return `Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64')`;
      });
      return { contents, loader: 'js' };
    });
  },
};

execFileSync(process.execPath, [path.join(server, 'scripts/desktop/gen-sources.mjs')], { stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const bundle = path.join(out, 'engine.cjs');
const result = await esbuild.build({
  entryPoints: [path.join(server, 'src/desktop/main.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: EXTERNAL,
  alias: { bcrypt: 'bcryptjs' }, // same API and hash format, no native module
  loader: { '.sql': 'text' },
  plugins: [vibeAuthStub, inlineVibeAuthSql, inlineDirnameReads],
  legalComments: 'external',
  logLevel: 'warning',
  metafile: true,
});
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(result.metafile));
console.log(`[desktop:build] bundle ${(fs.statSync(bundle).size / 1e6).toFixed(1)} MB`);

// Resource folders the engine reads at run time.
const resources = path.join(out, 'resources');
fs.cpSync(path.join(server, 'knowledge'), path.join(resources, 'knowledge'), { recursive: true });
fs.cpSync(path.join(server, 'assets/fs-fonts'), path.join(resources, 'fs-fonts'), { recursive: true });

if (bundleOnly) process.exit(0);

// Node SEA: blob → copy of node → inject.
const seaConfig = path.join(out, 'sea-config.json');
const blob = path.join(out, 'sea-prep.blob');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

const exe = path.join(out, process.platform === 'win32' ? 'clientledger-tb-engine.exe' : 'clientledger-tb-engine');
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });
const postjectArgs = [exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, [path.join(server, 'node_modules/postject/dist/cli.js'), ...postjectArgs], { stdio: 'inherit' });
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
console.log(`[desktop:build] ${path.relative(server, exe)} ${(fs.statSync(exe).size / 1e6).toFixed(1)} MB`);
