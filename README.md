# Graffiticode

Graffiticode is a platform for developing and deploying task oriented
web APIs. APIs are defined with task specific language manually through
the Graffiticode web app or programmatically through the Graffiticode API.

# Run Graffiticode Locally

```shell
npm install
```

## Firebase emulators

```shell
npx firebase emulators:start
```

## Auth

```shell
export FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:9099"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
npx @graffiticode/auth
```

## API

```shell
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
export AUTH_URL="http://localhost:4100"
npx @graffiticode/api
```
