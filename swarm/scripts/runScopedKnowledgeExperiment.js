#!/usr/bin/env node
import { runScopedKnowledgeProcessExperimentCli } from '../src/scopedKnowledgeProcessRunner.js';
import * as adapter from '../src/scopedKnowledgeExperiment.js';

await runScopedKnowledgeProcessExperimentCli({ entryUrl: import.meta.url, adapter });
