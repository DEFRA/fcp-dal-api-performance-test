FROM defradigital/cdp-perf-test-docker:latest

RUN apk add --no-cache jq nodejs npm

WORKDIR /opt/perftest

COPY scenarios/ ./scenarios/
COPY defraid/ ./defraid/
COPY entrypoint.sh .
COPY user.properties .

RUN npm --prefix ./defraid install

ENV S3_ENDPOINT=https://s3.eu-west-2.amazonaws.com
ENV TEST_SCENARIO=fcp-dal-api-perf-tests

ENTRYPOINT [ "./entrypoint.sh" ]
