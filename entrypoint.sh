#!/bin/sh

echo "run_id: $RUN_ID in $ENVIRONMENT"
echo "current dir: ${PWD}"

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
auth_url=https://login.microsoftonline.com/${TENANT_ID:?required secret not set!}/oauth2/v2.0/token
client_auth=`echo -n "${CLIENT_ID:?required secret not set!}:${CLIENT_SECRET:?required secret not set!}" | base64  | tr -d '\n'`
auth_token=`curl -s \
  --connect-timeout 5 \
  -x ${CDP_HTTPS_PROXY:?required env var not set!} \
  -L ${auth_url} \
  -H "Authorization: Basic ${client_auth}" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'grant_type=client_credentials' \
  --data "scope=${CLIENT_SCOPE:?required secret not set!}" \
| jq -r '.access_token'`

# Fast-fail when no token available!
if [ -z "${auth_token}" ] ; then
  echo ERROR! Exiting because an auth token could not be retrieved
  exit 2
fi

# Get a DefraId token. DEFRA_ID_PROVIDER is stub (the FCP Defra ID stub, the default) or b2c (the
# real Defra ID). The stub does not validate client id, secret, service id or password, so it gets
# defaults; b2c needs every value set.
DEFRA_ID_PROVIDER="${DEFRA_ID_PROVIDER:-stub}"
if [ "${DEFRA_ID_PROVIDER}" = "stub" ] ; then
  DEFRA_ID_WELL_KNOWN_URL="${DEFRA_ID_WELL_KNOWN_URL:-https://fcp-defra-id-stub.${ENVIRONMENT}.cdp-int.defra.cloud/idphub/b2c/b2c_1a_cui_cpdev_signupsigninsfi/.well-known/openid-configuration}"
  DEFRA_ID_CRN="${DEFRA_ID_CRN:-1111111100}"  # Originally 1102823449
  DEFRA_ID_PASSWORD="${DEFRA_ID_PASSWORD:-stub}"
  DEFRA_ID_CLIENT_ID="${DEFRA_ID_CLIENT_ID:-fcp-dal-api-perf-test}"
  DEFRA_ID_CLIENT_SECRET="${DEFRA_ID_CLIENT_SECRET:-stub}"
  DEFRA_ID_SERVICE_ID="${DEFRA_ID_SERVICE_ID:-fcp-dal-api-perf-test}"
  DEFRA_ID_REDIRECT_URL="${DEFRA_ID_REDIRECT_URL:-https://fcp-dal-upstream-mock.${ENVIRONMENT}.cdp-int.defra.cloud/auth/sign-in-oidc}"
  DEFRA_ID_RELATIONSHIP_ID="${DEFRA_ID_RELATIONSHIP_ID:-5900001}" # Does this need to map to the CRN?
fi
defra_id_token=$(
  DEFRA_ID_PROVIDER="${DEFRA_ID_PROVIDER}" \
  DEFRA_ID_WELL_KNOWN_URL="${DEFRA_ID_WELL_KNOWN_URL}" \
  DEFRA_ID_CRN="${DEFRA_ID_CRN:-1102823449}" \
  DEFRA_ID_PASSWORD="${DEFRA_ID_PASSWORD}" \
  DEFRA_ID_CLIENT_ID="${DEFRA_ID_CLIENT_ID}" \
  DEFRA_ID_CLIENT_SECRET="${DEFRA_ID_CLIENT_SECRET}" \
  DEFRA_ID_SERVICE_ID="${DEFRA_ID_SERVICE_ID}" \
  DEFRA_ID_REDIRECT_URL="${DEFRA_ID_REDIRECT_URL}" \
  DEFRA_ID_RELATIONSHIP_ID="${DEFRA_ID_RELATIONSHIP_ID}" \
  node $JM_HOME/defraid/get-defraid-token.js
)

# Fast-fail when no DefraId token available!
if [ -z "${defra_id_token}" ] ; then
  echo ERROR! Exiting because a DefraId token could not be retrieved
  exit 2
fi

# Create file paths for environments
internal_test_data_file_path="data/${ENVIRONMENT}/jmeter.config.internalcalls.testdata.csv"
internal_test_paireddata_file_path="data/${ENVIRONMENT}/jmeter.config.internalcalls.pairedtestdata.csv"
internal_land_data_file_path="data/${ENVIRONMENT}/jmeter.config.internalcalls.landdata.csv"
internal_lock_data_file_path="data/${ENVIRONMENT}/jmeter.config.internalcalls.lockabletestdata.csv"

external_test_data_file_path="data/${ENVIRONMENT}/jmeter.config.externalcalls.testdata.csv"
external_test_paireddata_file_path="data/${ENVIRONMENT}/jmeter.config.externalcalls.pairedtestdata.csv"
external_land_data_file_path="data/${ENVIRONMENT}/jmeter.config.externalcalls.landdata.csv"
external_lock_data_file_path="data/${ENVIRONMENT}/jmeter.config.externalcalls.lockabletestdata.csv"

internal_test_model_file_path="data/${ENVIRONMENT}/jmeter.config.internalcalls.testmodel.csv"
external_test_model_file_path="data/${ENVIRONMENT}/jmeter.config.externalcalls.testmodel.csv"

bank_data_file_path="data/${ENVIRONMENT}/jmeter.config.banktestdata.csv"

# Run the test suite
jmeter -n -t ${SCENARIOFILE} -e -l "${REPORTFILE}" -q user.properties -o ${JM_REPORTS} -j ${LOGFILE} -f -Jenv="${ENVIRONMENT}" -JauthToken="${auth_token}" -JdefraIdToken="${defra_id_token}" -JinternalTestDataFilePath="${internal_test_data_file_path}" -JexternalTestDataFilePath="${external_test_data_file_path}" -JinternalTestPairedDataFilePath="${internal_test_paireddata_file_path}" -JexternalTestPairedDataFilePath="${external_test_paireddata_file_path}" -JinternalTestModelFilePath="${internal_test_model_file_path}" -JexternalTestModelFilePath="${external_test_model_file_path}" -JbankDataFilePath="${bank_data_file_path}" -JinternalLandDataFilePath="${internal_land_data_file_path}" -JexternalLandDataFilePath="${external_land_data_file_path}" -JinternalLockableTestDataFilePath="${internal_lock_data_file_path}" -JexternalLockableTestDataFilePath="${external_lock_data_file_path}"
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
