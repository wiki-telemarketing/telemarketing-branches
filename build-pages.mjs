import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { branchKey, parseAcceptance, parseDirectory } from './directory.mjs';

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
async function downloadSheet(url,title) {
  try {
    const response = await fetch(url,{signal:AbortSignal.timeout(20_000),cache:'no-store'});
    if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error();
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > limit) throw new Error();
    return bytes;
  } catch {
    throw new Error('Could not retrieve the Google Sheets tab: '+title);
  }
}

const acceptanceSource = new URL(source);
acceptanceSource.searchParams.set('gid','1327834426');
const [workbook,acceptanceWorkbook,coordinates,stations] = await Promise.all([
  downloadSheet(source,'Переезды'),downloadSheet(acceptanceSource,'Приём по отделениям'),
  ...['coordinates','stations'].map(async (name) => JSON.parse(await readFile(name+'.json','utf8'))),
]);
let entries;
let acceptedByBranch;
try {
  entries = parseDirectory(workbook,coordinates);
  acceptedByBranch = parseAcceptance(acceptanceWorkbook);
} catch {
  throw new Error('A source worksheet has an unexpected format.');
}
for (const item of entries) {
  if (item.status !== 'active') continue;
  const accepted = acceptedByBranch.get(branchKey(item));
  if (accepted) item.accepted = accepted;
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
