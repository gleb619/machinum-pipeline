#!/bin/bash
# Sleeps for testing timeout
sleep ${1:-10}
echo '{"status": "completed"}'
