<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0003 Vocabulary

This specification documents dialect-specific functions available in the
**L0003** language of Graffiticode. These functions extend the core language
with additional functionality tailored to L0003 use cases.

The core language specification including the definition of its syntax,
semantics and base library can be found here:
[Graffiticode Language Specification](./graffiticode-language-spec.html)

## Functions

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `hello` | `<string: record>` | Renders a hello message |
| `theme` | `<[dark|light] record: record>` | Selects a theme |

### hello

Renders a hello message formatted in K&R style that includes the given string.

```
hello "world"  | returns "hello, world!"
```

### theme

Select a theme and render the theme toggle button to allow users to set the
theme. The tag values `dark` and `light` are the only accepted argument values.

```
theme dark "as night"
```
```
theme light "as day"
```

## Program Examples

Render the text "hello, world!" in the dark theme.

```
theme dark hello "night"..
```
