---
title: Getting started
description: Install the package and make the first call.
---

## Install

```sh
pnpm add @rxova/example
```

## Use

```ts
import { greet } from '@rxova/example';

greet('Ada'); // 'Hello, Ada.'
greet('Ada', { excited: true }); // 'Hello, Ada!'
```

Every option is listed in the [API reference](../../reference/api/).
