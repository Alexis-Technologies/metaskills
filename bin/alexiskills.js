#!/usr/bin/env node
const { run } = require('../src/link.js');

const main = async () => {
  const args = process.argv.slice(2);
  const { env, stdin: input, stdout: output, stderr: errorOutput } = process;
  const root = process.cwd();
  process.exitCode = await run({ args, env, root, input, output, errorOutput });
};

main();
