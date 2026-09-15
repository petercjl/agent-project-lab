#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const r=spawnSync(process.execPath,['--import',root+'node_modules/tsx/dist/loader.mjs',root+'cli.ts',...process.argv.slice(2)],{stdio:'inherit',env:process.env});
process.exit(r.status??1);
