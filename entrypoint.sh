#!/bin/sh

echo "run_id: $RUN_ID in $ENVIRONMENT"

NOW=$(date +"%Y%m%d-%H%M%S")

if [ -z "${JM_HOME}" ]; then
  JM_HOME=/opt/perftest
fi

JM_SCENARIOS=${JM_HOME}/scenarios
JM_REPORTS=${JM_HOME}/reports
JM_LOGS=${JM_HOME}/logs

mkdir -p ${JM_REPORTS} ${JM_LOGS}

SCENARIOFILE=${JM_SCENARIOS}/${TEST_SCENARIO}.jmx
REPORTFILE=${NOW}-perftest-${TEST_SCENARIO}-report.csv
LOGFILE=${JM_LOGS}/perftest-${TEST_SCENARIO}.log

# Get an auth token
set -eu # fast-fail if the necessary env vars do not exist!!
auth_url=https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token
client_auth=`echo -n "${CLIENT_ID}:${CLIENT_SECRET}" | base64  | tr -d '\n'`
auth_token=`curl -s \
  --connect-timeout 5 \
  -x ${HTTP_PROXY} \
  -L ${auth_url} \
  -H "Authorization: Basic ${client_auth}" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'grant_type=client_credentials' \
  --data "scope=${CLIENT_SCOPE}" \
| jq -r '.access_token'`
set +eu
if [ -z "${auth_token}" ] ; then
  echo ERROR! Exiting because an auth token could not be retrieved
  exit 2
fi

# Run the test suite
jmeter -n -t ${SCENARIOFILE} -e -l "${REPORTFILE}" -o ${JM_REPORTS} -j ${LOGFILE} -f -Jenv="${ENVIRONMENT}" -JauthToken="${auth_token}"
test_exit_code=$?

# Publish the results into S3 so they can be displayed in the CDP Portal
if [ -n "$RESULTS_OUTPUT_S3_PATH" ]; then
  # Copy the CSV report file and the generated report files to the S3 bucket
   if [ -f "$JM_REPORTS/index.html" ]; then
      aws --endpoint-url=$S3_ENDPOINT s3 cp "$REPORTFILE" "$RESULTS_OUTPUT_S3_PATH/$REPORTFILE"
      aws --endpoint-url=$S3_ENDPOINT s3 cp "$JM_REPORTS" "$RESULTS_OUTPUT_S3_PATH" --recursive
      if [ $? -eq 0 ]; then
        echo "CSV report file and test results published to $RESULTS_OUTPUT_S3_PATH"
      fi
   else
      echo "$JM_REPORTS/index.html is not found"
      exit 1
   fi
else
   echo "RESULTS_OUTPUT_S3_PATH is not set"
   exit 1
fi

exit $test_exit_code
