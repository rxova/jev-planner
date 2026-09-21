---
title: API
description: Every export of @rxova/example.
---

## `greet(name, options?)`

Returns a greeting for `name`. Throws a `TypeError` when `name` is empty or only whitespace.

| Option    | Type      | Default | Effect                                                   |
| --------- | --------- | ------- | -------------------------------------------------------- |
| `excited` | `boolean` | `false` | Ends the greeting with an exclamation mark, not a period |
