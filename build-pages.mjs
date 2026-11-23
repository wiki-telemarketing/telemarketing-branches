import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseDirectory } from './directory.mjs';

const input = process.env.MGKL_SOURCE_XLSX_URL;
if (!input) throw new Error('MGKL_SOURCE_XLSX_URL is required.');

let source;
try {
  source = new URL(input);
} catch {
  throw new Error('MGKL_SOURCE_XLSX_URL must be a Google Sheets XLSX export URL.');
}
if (source.origin !== 'https://docs.google.com' ||
    !/^\/spreadsheets\/d\/[\w-]+\/export$/.test(source.pathname) ||
    source.searchParams.get('format') !== 'xlsx' ||
    !/^\d+$/.test(source.searchParams.get('gid') ?? '')) {
  throw new Error('MGKL_SOURCE_XLSX_URL must identify an XLSX export of a single Google Sheets tab.');
}

const limit = 3_000_000;
let workbook;
try {
  const response = await fetch(source,{signal:AbortSignal.timeout(20_000),cache:'no-store'});
  if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error();
  workbook = await response.arrayBuffer();
  if (workbook.byteLength > limit) throw new Error();
} catch {
  throw new Error('Could not retrieve the directory from Google Sheets.');
}

const [coordinates,stations] = await Promise.all(['coordinates','stations'].map(async (name) =>
  JSON.parse(await readFile(name+'.json','utf8'))));
let entries;
try {
  entries = parseDirectory(workbook,coordinates);
} catch {
  throw new Error('The source worksheet is missing, empty, or has an unexpected format.');
}
const data = {entries, stations, updatedAt:new Date().toISOString(),
  tileUrl:'https://tile.openstreetmap.org/{z}/{x}/{y}.png'};

const common = {bundle:true,minify:true,logLevel:'warning',target:'es2022'};
await mkdir('dist',{recursive:true});
await Promise.all([
  build({...common,entryPoints:['app.js'],outfile:'dist/app.js',platform:'browser'}),
  build({...common,entryPoints:['styles.css'],outfile:'dist/styles.css',loader:{'.png':'dataurl'}}),
  copyFile('index.html','dist/index.html'),
  writeFile('dist/directory.json',JSON.stringify(data)),
]);
console.log('Prepared '+entries.length+' public directory records.');
