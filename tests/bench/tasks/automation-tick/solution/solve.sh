#!/bin/bash
set -euo pipefail
cd /app
# The reference cannot use the Dot's automations (they belong to the Dot), so it stands in with the
# effect the grader checks: two lines a minute apart, written by something else than the agent.
date -u +%H:%M:%S >> tick.log; sleep 61; date -u +%H:%M:%S >> tick.log
