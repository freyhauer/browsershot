---
title: Using a pipe instead of a WebSocket
weight: 22
---

If you want to connect to the browser over a pipe instead of a WebSocket, you can use:

```php
Browsershot::url('https://example.com')
   ->usePipe()
   ...
```
