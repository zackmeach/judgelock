# Mutation tests

Deliberate-drift tests: change exactly one identity component, assert `verify`
exits nonzero, and assert it names the component that moved rather than
reporting an opaque id change.

## Before the first test lands

Drop `--passWithNoTests` from the `test` script in package.json.

It is load-bearing right now — vitest exits nonzero on zero test files. The
moment a real test exists it becomes a silent-green path: misconfigure the glob
and CI reports pass with zero tests run. Fail-closed is the premise of this
repo; the test runner does not get an exemption from it.
