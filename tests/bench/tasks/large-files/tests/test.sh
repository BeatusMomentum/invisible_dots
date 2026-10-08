#!/bin/bash
# The reward is 1 when grade.py passes every check, 0 otherwise; its output says which check failed.
mkdir -p /logs/verifier
if python3 /tests/grade.py; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
