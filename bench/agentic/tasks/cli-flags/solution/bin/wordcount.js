#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const lines = args.includes('--lines');
const fi = args.indexOf('--file');
const text = fi > -1 ? readFileSync(args[fi + 1], 'utf8') : readFileSync(0, 'utf8');
console.log(lines ? text.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '').length
                  : text.split(/\s+/).filter(Boolean).length);
