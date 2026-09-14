#!/usr/bin/env node
import { runMemoryProcessExperimentCli } from '../src/memoryProcessExperimentRunner.js';
import * as adapter from '../src/workflowMemoryExperiment.js';

await runMemoryProcessExperimentCli({ entryUrl: import.meta.url, adapter });
