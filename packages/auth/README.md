# GC Auth

Auth application for [Graffiticode](https://graffiticode.org) applications.

## API

- `uid`: user id, in practice this is a non `0x` prefixed ethereum address.

### `GET /certs`

Gets a JSON Web Key Set for the current set of keys being used to sign tokens.

- __AUTH__: `none`

### `GET /authenticate/ethereum/:address`

Returns the current nonce for an ethereum address. This will generate a nonce if one does not currently exist.

- __AUTH__: `none`
- Request
  - `address`: used as the user id
- Response
  - `nonce`: Opaque random string used for authenticating with ethereum.

### `POST /authenticate/ethereum/:address`

Performs Sign In With Ethereum processing for an address. If authentication succeeds a `accessToken` and `refreshToken` are issued to the caller.

- __AUTH__: `none`
- Request
  - `address`: used as the user id
  - `signature`: signed ethereum message with contents "Nonce: \<nonce\>"
- Response
  - `accessToken`: a short lived JWT that can be used to make authenticated calls to GC APIs (i.e. compilers or the API). This is optimization over the client having to call `POST /authenticate/refresh_token`.
  - `refreshToken`: a long lived opaque token for retrieving auth `accessToken`s.

### `POST /authenticate/refresh_token`

Exchanges a `refreshToken` issued during authentication for a short lived JWT that can be used to make authenticated calls to the GC APIs.

- __AUTH__: `none`
- Request
  - `refreshToken`: the token issued during authentication
- Response
  - `accessToken`: a short lived JWT that can be used to make authenticated calls to GC APIs.

## Development

1. Start firebase emulators (_NOTE_: you only to do this once per GCP project).

```bash
npx firebase emulators:start
```

1. Run GC Auth application (in another terminal)

```bash
npm run dev
```

1. Run example usage

```bash
# Generate a signing key
curl -i -X POST http://localhost:4100/certs

node tools/run-ethereum.js
```
