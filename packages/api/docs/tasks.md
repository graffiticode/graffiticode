### POST /tasks [{lang, code}, ...]

Takes a one or more task definitions (`{lang, code}`) and returns a `taskId` for
each task.

```
const tasks = getTasksFromRequest(req);
const data = tasks.map(async task => await postTask(task));
```

`lang` defines the vocabulary and semantics of `code`. The `code` must be a
pre-parsed AST object. The task is stored and the taskId included in the
response taskIds.



