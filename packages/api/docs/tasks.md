### POST /tasks [{lang, code}, ...]

Takes a one or more task definitions (`{lang, code}`) and returns a `taskId` for
each task.

```
const tasks = getTasksFromRequest(req);
const data = tasks.map(async task => await postTask(task));
```

`lang` defines the vocabulary and semantics of `code`. If `code` is text (source
code), then `getTasksFromRequest()` will parse that code using the lexicon for
the given language `lang`. The task is stored and the taskId included in the
response taskIds.



