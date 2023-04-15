# Storage

Graffiticode API storage package allows for creation and retrieval of Tasks.

## Models

### `Task` [`object`]

Tasks are considered immutable and forever

- `lang`: The language identifier for this task
  - Type: `string`
- `code`: The AST for this task
  - Type: `object`

### `Id` [`string`]

Opaque identifier of a `Task`.

### `Auth` [`object`]

The verified authentication context for the call. The caller is responsible for validating the context.

_Note_: The `Auth` context is optional

- `uid`: The identifier of the user making the call
  - Type: `string`

## Task DAO API

### `Create({ Task, Auth }) -> Id`

Creates the `Task` if not missing from storage. Returns the `Id` of the `Task`. If `Auth` is provided the `Auth.uid` will be added to the Access Control List (ACL) of the `Task`.

### `Get({ Id, Auth }) -> [Task]`

Returns the `Task` for the given `Id` from storage or throws a `NotFoundError` if the `Task` is not present. If `Auth` is present then `Auth.uid` is checked against the ACL of the `Task`. If the `Auth.uid` is present on the ACL then the `Task` is returned. If the `Auth.uid` is missing then a `NotFoundError` is thrown.

### `AppendIds(Id, ...Ids) -> Id`

Combines one or more `Id`s together into a single such that the returned `Id` can be used to retrieve all `Task`s of the combined `Id`s. The returned `Id` must maintain the order of the input `Id`s.

## Invariants

1. `Get(Create(Task1)) == [Task1]`
1. `Get(AppendIds(Create(Task1), Create(Task2))) == [Task1, Task2]`
