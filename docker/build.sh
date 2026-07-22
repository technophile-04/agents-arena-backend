#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
docker build --tag arena-entrant:dev --file "$script_dir/Dockerfile" "$script_dir"
