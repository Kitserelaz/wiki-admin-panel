# Host health and Services acceptance scenarios

Functional acceptance remains pending. These scenarios have not been executed, following the instruction to avoid tests and simulated outages.

| Scenario | Expected result |
| --- | --- |
| Anonymous dashboard/API request | Login is required before host data or operations are accessible. |
| Authorized Discord operator | Both views load with the existing eight-hour session policy. |
| Host collection | CPU, load, memory, swap, root filesystem, disk I/O, uptime, and pending reboot appear with a collection timestamp. First rate measurements remain unavailable until the second sample. |
| Docker unavailable | Host collection continues independently. Container inventory becomes unknown, with an explicit error. Host service restart controls remain available. |
| Agent unavailable or sample older than 30 seconds | Retained data is marked stale and restart submission is disabled. |
| History retention | Samples older than 24 hours are removed. Five-minute averages appear across 24 hours, with gaps for unavailable buckets. |
| Hidden browser tab | Polling pauses. Returning to the tab requests fresh data immediately. |
| Stopped/missing production container | Stopped containers remain visible and can be restarted. Missing containers are labeled missing and require deployment repair. |
| Rehearsal and disabled-profile services | They are excluded from production inventory. Multiple matching production containers are marked ambiguous and cannot be restarted. |
| Restart confirmation | The target and impact are stated before submission. Closing or cancelling the dialog submits no operation. |
| Unsupported target or invalid actor/ID | The agent rejects the request without executing a command. The web server takes actor identity from the authenticated session. |
| Cross-origin restart POST | Rejected before it reaches the agent. |
| Duplicate operation ID | The original operation is returned without another restart. Reusing it for another actor or target returns a conflict. |
| Concurrent restart requests | The agent executes one operation at a time, preserving queue order. |
| Failed/timed-out restart | A failed operation records a concise result and timestamps. A timeout warns operators to inspect service state before retrying. |
| Panel restart | Sessions end, while operation records survive. After signing in, the operator can see the outcome. |
| Docker/HAProxy restart | The operation record survives the connection interruption. Service/application health is reported independently of command success. |
| Agent restart during an operation | The operation is marked failed with an uncertain-outcome explanation. Running operations are not automatically replayed. Queued operations resume. |
| Operation retention | Finished operations older than 30 days are removed. Queued/running operations are retained. |
| Credential boundaries | Agent APIs return selected state fields, with no environment variables, credentials, or full container inspection output. |

## Deployment records

Record the pushed revision, Bun build outcome, agent unit installation, panel service restart outcome, and retained rollback build. Starting services and compiling production artifacts are deployment steps. Functional verification and simulated outages remain deferred.
