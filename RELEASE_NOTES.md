# Blueprint: Variable Mapper — Release Notes

## v3.0.1 — 3 June 2026

### Bug Fix: Scanning no longer marks components as modified

**Problem**

Running a scan (selection, page, or file) caused Figma to treat scanned components as modified, making the **Publish changes** button appear even though no variables had been changed. This was a false-positive dirty state that required users to either publish unwanted changes or manually discard them.

**Root Cause**

The `handleScan` function called `setRelaunchForRoots()` at the end of every scan. Internally, this calls Figma's `node.setRelaunchData()` API, which writes metadata directly onto each root node. Writing any property to a component node — even non-visual metadata — is enough for Figma to consider it modified and surface the publish prompt.

**Fix**

Removed the `setRelaunchForRoots()` call from `handleScan`. The call is preserved in `handleRebind`, where it correctly runs only after variables have actually been changed and `figma.commitUndo()` has been called. Scanning is now fully read-only and will never trigger the publish prompt.

**Impact**

| Action | Before | After |
|---|---|---|
| Scan selection | Marked components dirty ❌ | No change to document ✅ |
| Scan page | Marked components dirty ❌ | No change to document ✅ |
| Scan file | Marked components dirty ❌ | No change to document ✅ |
| Remap variables | Marked components dirty ✅ | Marked components dirty ✅ |

The relaunch button (which allows reopening the plugin on a node) will only be set when a remap is actually applied, which is the correct behaviour.

**File changed:** `code.js`
