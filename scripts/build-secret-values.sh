#!/bin/sh
# Builds the PERF_DATA_* values used when USE_SECRET_PERF_DATA is true, from a folder holding the
# test data CSVs. Rows are separated by ; because .env files are one line per variable. See
# "Keeping real SBI and CRN numbers out of this repo" in the README.
#
# Usage:
#   scripts/build-secret-values.sh <csv-folder>
#     Prints NAME=value lines, for a local .env file.
#   scripts/build-secret-values.sh <csv-folder> <output-folder>
#     Writes one file per secret, named after it and holding only its value, ready to paste into
#     CDP. The output folder must be outside any git repo.

csv_dir="${1:?usage: build-secret-values.sh <csv-folder> [output-folder]}"
out_dir="$2"

perf_data_vars="
  PERF_DATA_INTERNAL_TESTDATA:internalcalls.testdata
  PERF_DATA_INTERNAL_PAIREDTESTDATA:internalcalls.pairedtestdata
  PERF_DATA_INTERNAL_LANDDATA:internalcalls.landdata
  PERF_DATA_INTERNAL_LOCKABLETESTDATA:internalcalls.lockabletestdata
  PERF_DATA_EXTERNAL_TESTDATA:externalcalls.testdata
  PERF_DATA_EXTERNAL_PAIREDTESTDATA:externalcalls.pairedtestdata
  PERF_DATA_EXTERNAL_LANDDATA:externalcalls.landdata
  PERF_DATA_EXTERNAL_LOCKABLETESTDATA:externalcalls.lockabletestdata
  PERF_DATA_BANK:banktestdata
"

if [ ! -d "${csv_dir}" ] ; then
  echo "ERROR! Folder not found: ${csv_dir}" >&2
  exit 1
fi

# Check everything first, so that a problem never leaves a partial set of values
problems=""
for perf_data_var in ${perf_data_vars} ; do
  csv="jmeter.config.${perf_data_var#*:}.csv"
  if [ ! -f "${csv_dir}/${csv}" ] ; then
    problems="${problems}  ${csv} is missing\n"
  elif grep -q ';' "${csv_dir}/${csv}" ; then
    problems="${problems}  ${csv} contains a ; which is used to separate rows\n"
  fi
done

if [ -n "${problems}" ] ; then
  printf "ERROR! Problems in ${csv_dir}:\n${problems}" >&2
  exit 1
fi

if [ -n "${out_dir}" ] ; then
  mkdir -p "${out_dir}" || exit 1
  # safety check that stops the script if the output folder is inside a git repository. Since this script writes secrets, that prevents them from being accidentally committed.
  if git -C "${out_dir}" rev-parse --is-inside-work-tree > /dev/null 2>&1 ; then
    echo "ERROR! ${out_dir} is inside a git repo, use a folder outside it" >&2
    exit 1
  fi
fi

# makes every file and directory created afterwards by that shell and its child processes private to the owner.
umask 077

for perf_data_var in ${perf_data_vars} ; do
  name="${perf_data_var%%:*}"
  value=$(tr -d '\r' < "${csv_dir}/jmeter.config.${perf_data_var#*:}.csv" | awk 'NF' | paste -sd ';' -)

  if [ -n "${out_dir}" ] ; then
    printf '%s' "${value}" > "${out_dir}/${name}"
    echo "${name}: ${#value} characters"
  else
    printf '%s=%s\n' "${name}" "${value}"
  fi
done
