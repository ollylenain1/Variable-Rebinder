# Blueprint: Variable Rebinder — Figma Plugin

A Figma plugin that scans your design for bound variables and lets you remap them to the correct library or collection. Useful when:

- You've duplicated a file and variables are pointing to the wrong library
- You're migrating from one design system to another
- You need to swap local variables for shared library variables
- Variables got unlinked after a library rename or reorganisation

---

## Files

```
blueprint-variable-rebinder/
├── manifest.json   ← plugin manifest
├── code.js         ← main plugin logic (Figma API side)
├── ui.html         ← plugin UI (HTML/CSS/JS)
└── README.md
```

---

## Installation (Development)

1. Open **Figma Desktop**
2. Go to **Menu → Plugins → Development → Import plugin from manifest…**
3. Select the `manifest.json` file from this folder
4. The plugin will appear under **Plugins → Development → Blueprint: Variable Rebinder**

---

## What It Does

- Scans **Selection**, **Current Page**, or **Whole File**
- Finds bound variables across colors, numbers, booleans, strings, text properties, layout properties, and more
- Includes **hidden layers** in both scan and remap operations
- Makes **Selection** scope reliable for single selected layers, instance children, and override nodes
- Detects **broken / unresolved variable references** and shows them separately
- Supports **bulk remap by source library**
- Supports text layers with **mixed text fill bindings**, including range-based fill variables
- Imports target library variables automatically before applying remaps
- Verifies variable application after apply and retries once before reporting a visible failure

---

## How To Use

### 1. Choose your scope

Select from **Selection**, **Current Page**, or **Whole File** at the top of the plugin.

### 2. Scan

Click **Scan** to discover all bound variables in scope. The plugin lists each variable with its current collection or library source, along with usage counts and hidden-layer stats where relevant.

### 3. Map variables

For each found variable, expand its card and:

- Choose the **target library collection** from the dropdown
- Choose the **target variable** within that collection (filtered to matching type)

Green dot = mapped ✓

### 4. Optional: bulk remap by library

Use **Bulk Remap by Library** to map every variable from one source library or collection to matching variables in a target collection, then fine-tune any exceptions manually.

### 5. Apply

Click **Apply Remapping** to write the new bindings back to the file.

After apply, the plugin shows a single result panel with:

- Variables applied
- Nodes affected
- Bindings applied
- Skipped bindings without mappings
- Any verification failures that need attention

---

## Notes On Behavior

- The plugin scans hidden layers; hidden content is not skipped
- Selection scope explicitly includes the selected node itself, even when only one node is selected
- Instance children and override nodes are explicitly included in selection-scope apply runs
- If selection scope initially resolves zero nodes, the plugin retries by resolving selected node IDs directly
- Instance children are detected and included where possible, but some bindings inside instances can only be changed if that property already has an override
- For text layers, range-based color variable bindings are handled through text segment fills
- When the plugin can identify layers using a variable, the UI can show those usages and focus them in the document
- Variable application is verified after apply; failed applications are surfaced inline in the UI instead of failing silently

---

## Technical Notes

- Uses `figma.variables.importVariableByKeyAsync` to import library variables before binding
- Uses `figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync` to list all connected libraries
- Uses `setBoundVariable` for standard bindable fields
- Uses `setBoundVariableForPaint` and text range fill updates for paint and mixed-text fill rebinding
- Verifies standard bindings with `didVariableApply`
- Verifies text segment bindings with `didTextSegmentVariableApply`
- Handles all bindable fields: fills, strokes, opacity, corner radius, width/height, text properties, etc.
- Works with COLOR, FLOAT, STRING, and BOOLEAN variable types
- Walks nodes in chunks and loads nodes concurrently to avoid timeouts on large files

---

## Limitations

- Requires a Figma account with access to the target libraries
- Library variables must be in connected (shared) libraries visible in the file
- Some instance-child bindings cannot be changed unless that property is already exposed as an override on the instance
- Broken variable references can be reported, but they may not always be recoverable automatically if the source library is missing
