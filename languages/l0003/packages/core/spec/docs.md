<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0003 User Manual

**Introduction**

*Graffiticode* is a collection of domain languages used for creating task
specific web apps. **L0003** is a *Graffiticode* language for writing
'hello, world' web apps.

L0003 can be used as a template for creating other, presumably more
interesting and useful, languages.

### Overview

The code

```
hello "world"..
```

renders

| **hello, world!**

in the browser view.

### Vocabulary


| Function  | Arity | Example  | Description |
| --------- | :---: | -------- | ----------- |
| **hello** | 1     | `hello "world"` | renders **hello, world!** in the form |
| **val**   | 2     | `val ob "x"` | returns the value of `x` in `ob` |
| **concat**| 1     | `concat [x,y]` | returns the string value that is the concatentation of the values of x and y |
| **add**   | 2     | `add x y` | returns the sum of values of `x` and `y` |
| **map**   | 2     | `map fn [1,2,3]` | returns a list containing the result of applying `fn` to each element in the list `[1,2,3]` |
| **data**  | 1     | `data ob` | returns the value of data passed to the current task, or otherwise the value of `ob` |

