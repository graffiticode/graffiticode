# Graffiticode

Graffiticode is a platform for developing and deploying task oriented
web APIs. APIs are defined with task specific language, either manually
through the Graffiticode web app or programmatically through the
Graffiticode API.

## Run Graffiticode Locally

```shell
npm install
```

### Firebase emulators

```shell
npx firebase emulators:start
```

### Auth

```shell
npm run -w packages/auth dev
```

### API

```shell
npm run -w packages/api dev
```
