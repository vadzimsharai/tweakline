import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// .cjs, because the bundle is CommonJS and package.json here says "type": "module".
export const OUTPUT = path.join(HERE, 'dist', 'tweakline.cjs');
const BROTLI_QUALITY = 11;
const EXECUTABLE_MODE = 0o755;
const INSTRUCTIONS_READ = "fs.readFileSync(path.join(HERE, 'instructions.md'), 'utf8')";
const VERSION_READ = "JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version";

// The single file has nothing next to it, so the text assets go inside.
const inlineAssets = {
  name: 'inline-assets',
  setup(context) {
    context.onLoad({ filter: /server\.mjs$/ }, (args) => {
      const source = fs.readFileSync(args.path, 'utf8');
      if (!source.includes(INSTRUCTIONS_READ)) throw new Error('instructions read not found in server.mjs');
      const instructions = fs.readFileSync(path.join(HERE, 'instructions.md'), 'utf8');
      if (!source.includes(VERSION_READ)) throw new Error('version read not found in server.mjs');
      const { version } = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
      return { contents: source.replace(INSTRUCTIONS_READ, JSON.stringify(instructions)).replace(VERSION_READ, JSON.stringify(version)), loader: 'js' };
    });
  },
};

export async function buildBundle() {
  const { outputFiles } = await build({
    write: false,
    entryPoints: [path.join(HERE, 'cli.mjs')],
    outfile: OUTPUT,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    minify: true,
    legalComments: 'none',
    banner: { js: "const __tweaklineFile=require('node:url').pathToFileURL(__filename).href;" },
    define: { 'import.meta.url': '__tweaklineFile', __TWEAKLINE_BUNDLED__: 'true' },
    plugins: [inlineAssets],
    logLevel: 'warning',
  });
  const packed = zlib.brotliCompressSync(outputFiles[0].contents, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }).toString('base64');
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `#!/usr/bin/env node\nmodule._compile(require('node:zlib').brotliDecompressSync(Buffer.from('${packed}','base64')).toString(),__filename);\n`);
  fs.chmodSync(OUTPUT, EXECUTABLE_MODE);
  return OUTPUT;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await buildBundle());
