# Live operations and route history

## Job

Show where field representatives actually travelled without presenting GPS noise or missing samples as real roads.

## Route truth rules

- Raw points remain available in the audit log.
- The visible route excludes weak fixes, duplicate timestamps, stationary jitter, and impossible spikes.
- A long capture gap starts a new solid segment; the map never invents a solid diagonal connection.
- Out-and-back travel on the same road remains overlapping chronology, not a simplified polygon.
- Display the device's actual uncertainty as `±N m`; explain that a smaller number is more precise.

The visual signature is an honest segmented route over a quiet map, paired with a compact quality ledger showing raw points, drawn points, exclusions, and gaps.
