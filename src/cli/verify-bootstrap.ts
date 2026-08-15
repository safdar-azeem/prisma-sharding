#!/usr/bin/env node

import { runBootstrapVerificationCli } from './utils/bootstrap-verify-core';

runBootstrapVerificationCli()
  .then((exitCode) => {
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
