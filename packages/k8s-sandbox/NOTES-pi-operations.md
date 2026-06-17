# Pi Operations routing — grep/find findings (pi-fork @ 7acc67a)

Confirms the M2 design's §4.1 load-bearing risk.

## find — operations SUFFICE
`createFindToolDefinition.execute` (src/core/tools/find.ts:155): when
`options.operations.glob` is provided it is used INSTEAD of `fd`. Supplying a
custom `glob` that shells out in-pod fully routes find's search to the pod.
Return: array of paths (relative to the search cwd is accepted).

(Plan claimed line 154; actual check is at line 155. Behavior matches exactly.)

## grep — operations DO NOT suffice
`createGrepToolDefinition.execute` (src/core/tools/grep.ts): always
`spawn(rgPath, args)` against the LOCAL filesystem (line 221). `operations`
only feeds `isDirectory` (path check) and `readFile` (context lines). So grep's
search runs on the head regardless of operations.
Decision: route grep by OVERRIDING the tool's `execute` to run `rg` IN the pod
via execInPod, and return grep's result shape:
  - No-match: `{ content: [{ type: "text", text: "No matches found" }], details: undefined }` (grep.ts:311)
  - Success:   `{ content: [{ type: "text", text: output }], details: <object or undefined> }` (grep.ts:358)

(Plan cited grep.ts:311 for the success/no-match shape. Actual: line 311 is the
no-match resolve; the success resolve is at line 358. Both shapes confirmed above.)

## bash/read/write/edit/ls — operations SUFFICE (standard pattern, per SSH example).
