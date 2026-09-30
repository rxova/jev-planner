---
"jev-planner": patch
---

Take the error-message and object checks from `@rxova/ts-utils`, inlined at build time. No behavior change, except that a thrown value `String()` cannot convert now reports its object tag (`[object Object]`) instead of failing the error handler. Still one runtime dependency.
