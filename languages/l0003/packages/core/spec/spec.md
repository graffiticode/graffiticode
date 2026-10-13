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
| `image` | `<string: record>` | Renders an image from a URL |
| `theme` | `<[DARK|LIGHT] record: record>` | Selects a theme |
| `id` | `<string any: record>` | Sets an element identifier |

### hello

Renders a hello message formatted in K&R style that includes the given string.

```
hello "world"  | returns "hello, world!"
```

### theme

Select a theme and render the theme toggle button to allow users to set the
theme. The tags `DARK` and `LIGHT` are the only accepted argument values; write them
bare and uppercase.

```
theme DARK "as night"
```
```
theme LIGHT "as day"
```

### image

Renders the image at the given URL.

```
image "https://example.com/logo.png"
```

### id

Attaches an element identifier to what follows, for downstream referencing. The
identifier is a string.

```
id "greeting" hello "world"
```

## Program Examples

Render the text "hello, world!" in the dark theme.

```
theme DARK hello "night"..
```
