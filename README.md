# fcp-dal-api-performance-test

A JMeter based Consolidated View test runner for the CDP Platform.

- [Licence](#licence)
  - [About the licence](#about-the-licence)

## About the Consolidated View Tests

### Authentication

In the entrypoint.sh file, a call is made to microsoftonline.com to extract an authentication token for use in the test calls to Consolidated View. It is saved in an script variable "auth_token" which is then converted to an environment variable "authToken" when JMeter itself is started in the same file.

In the tests themselves, this environment variable is then referenced in the JMeter header components with `Name=Authorization` and `Value=Bearer {token}`.

### Validation

Validation for each of the test calls is currently quite simple. Each call is subject to a response assertion that it receives a 200 response code. Each call is also subject to a JSON assertion to ensure there is NOT an `error` property in the response object.

### Load profiling

JMeter offers a number of ways to model the load placed on the system under test:
1. We have used a "Constant Throughput timer" which restricts the load to a value set in one of the CSV files and set as the environment variable "xxx-rrpm" (where xxx is the test name).
2. In the main ThreadGroup of the test, we have set each thread to have a time limit of 10 minutes. Each thread created will repeat until this time limit is reached.

### CSV files and data

We make use of four CSV files in the tests which are read at the start of the test using two "CSV Data Set Config" JMeter items.
1. jmeter.config.testparameters.csv - this stores the aforementioned "requestratepm" (request rate per minute for the test) as well as "testrampupseconds", "testnumberofthreads" and "requestratepm"
2. jmeter.config.testdata.csv - this stores individual test data that is needed to make the tests run correctly (e.g. SBI and CRN numbers)
3. jmeter.config.pairedtestdata.csv - this stores test data where each row of data needs to align to a particular organisation and person. If there is no association between the data in a given row, errors may be seen in the tests.
4. jmeter.config.testmodel.csv - this stores the request rate per minute (rrpm) for each of the tests. Using this, we can control the rate of each request type and model a load that is more realistic. The value needs to be referenced in the "Constant Throughput timer" for each type of thread.

## Build

Test suites are built automatically by the [.github/workflows/publish.yml](.github/workflows/publish.yml) action whenever a change are committed to the `main` branch.
A successful build results in a Docker container that is capable of running your tests on the CDP Platform and publishing the results to the CDP Portal.

## Run

The performance test suites are designed to be run from the CDP Portal.
The CDP Platform runs test suites in much the same way it runs any other service, it takes a docker image and runs it as an ECS task, automatically provisioning infrastructure as required.

## Local Testing with LocalStack

### Build a new Docker image
```
docker build . -t my-performance-tests
```
### Create a Localstack bucket
```
aws --endpoint-url=localhost:4566 s3 mb s3://my-bucket
```

### Run performance tests

```
docker run \
-e S3_ENDPOINT='http://host.docker.internal:4566' \
-e RESULTS_OUTPUT_S3_PATH='s3://my-bucket' \
-e AWS_ACCESS_KEY_ID='test' \
-e AWS_SECRET_ACCESS_KEY='test' \
-e AWS_SECRET_KEY='test' \
-e AWS_REGION='eu-west-2' \
my-performance-tests
```

docker run -e S3_ENDPOINT='http://host.docker.internal:4566' -e RESULTS_OUTPUT_S3_PATH='s3://cdp-infra-dev-test-results/cdp-portal-perf-tests/95a01432-8f47-40d2-8233-76514da2236a' -e AWS_ACCESS_KEY_ID='test' -e AWS_SECRET_ACCESS_KEY='test' -e AWS_SECRET_KEY='test' -e AWS_REGION='eu-west-2' -e ENVIRONMENT='perf-test' my-performance-tests


## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

<http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3>

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government licence v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable
information providers in the public sector to license the use and re-use of their information under a common open
licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
