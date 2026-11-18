#!/usr/bin/env node
import {main} from './main.js';

const code = await main(process.argv.slice(2));
// Set the code instead of calling exit, so piped output is flushed first.
if (code !== null) process.exitCode = code;
